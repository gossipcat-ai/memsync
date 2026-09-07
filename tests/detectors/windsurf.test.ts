import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windsurfDetector } from "../../src/detectors/windsurf.js";

describe("windsurfDetector.findProjectFiles", () => {
  it("returns .windsurfrules as exists:true when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    try {
      writeFileSync(join(dir, ".windsurfrules"), "rules");
      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        { absolutePath: join(dir, ".windsurfrules"), relativeKeyPath: "windsurf/.windsurfrules", exists: true },
      ]);

      expect(windsurfDetector.resolveLocalPath("windsurf/.windsurfrules", dir, "/unused/home", "project")).toBe(
        join(dir, ".windsurfrules"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns .windsurfrules as exists:false when absent (no separate config dir to gate on)", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    try {
      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        { absolutePath: join(dir, ".windsurfrules"), relativeKeyPath: "windsurf/.windsurfrules", exists: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findGlobalFiles returns an empty array (no documented Windsurf global memory)", () => {
    expect(windsurfDetector.findGlobalFiles("/any/home")).toEqual([]);
  });
});

describe("windsurfDetector.resolveLocalPath scope isolation", () => {
  // TypeScript's structural typing cannot force a Detector implementation to actually
  // consult its `scope` argument, so this rejection is only guarded by a test.
  // Windsurf's findGlobalFiles always returns [], so it owns no key under the gist's
  // `global/` prefix — a global-scope entry must never resolve to a real project file.
  it("rejects a project-scope key presented in global scope", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-windsurf-scope-"));
    try {
      expect(() =>
        windsurfDetector.resolveLocalPath("windsurf/.windsurfrules", projectDir, "/unused/home", "global"),
      ).toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
