import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotDetector } from "../../src/detectors/copilot.js";

describe("copilotDetector.findProjectFiles", () => {
  it("returns .github/copilot-instructions.md as exists:true when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-copilot-"));
    try {
      mkdirSync(join(dir, ".github"), { recursive: true });
      writeFileSync(join(dir, ".github", "copilot-instructions.md"), "instructions");
      const refs = copilotDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        {
          absolutePath: join(dir, ".github", "copilot-instructions.md"),
          relativeKeyPath: "copilot/copilot-instructions.md",
          exists: true,
        },
      ]);

      expect(
        copilotDetector.resolveLocalPath("copilot/copilot-instructions.md", dir, "/unused/home", "project"),
      ).toBe(join(dir, ".github", "copilot-instructions.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns .github/copilot-instructions.md as exists:false when absent (no separate config dir to gate on)", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-copilot-"));
    try {
      const refs = copilotDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        {
          absolutePath: join(dir, ".github", "copilot-instructions.md"),
          relativeKeyPath: "copilot/copilot-instructions.md",
          exists: false,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exists:false when .github/ itself does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-copilot-"));
    try {
      const refs = copilotDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        {
          absolutePath: join(dir, ".github", "copilot-instructions.md"),
          relativeKeyPath: "copilot/copilot-instructions.md",
          exists: false,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findGlobalFiles returns an empty array (no documented Copilot global memory)", () => {
    expect(copilotDetector.findGlobalFiles("/any/home")).toEqual([]);
  });
});

describe("copilotDetector.resolveLocalPath scope isolation", () => {
  // TypeScript's structural typing cannot force a Detector implementation to actually
  // consult its `scope` argument, so this rejection is only guarded by a test.
  // Copilot's findGlobalFiles always returns [], so it owns no key under the gist's
  // `global/` prefix — a global-scope entry must never resolve to a real project file.
  it("rejects a project-scope key presented in global scope", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-copilot-scope-"));
    try {
      expect(() =>
        copilotDetector.resolveLocalPath("copilot/copilot-instructions.md", projectDir, "/unused/home", "global"),
      ).toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
