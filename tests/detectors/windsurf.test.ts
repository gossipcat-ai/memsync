import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

  it("discovers nested .md files under .windsurf/rules/ with windsurf/rules/... keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    try {
      const rulesDir = join(dir, ".windsurf", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(rulesDir, "coding-standards.md"), "use tabs");
      const deepDir = join(rulesDir, "backend");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, "api.md"), "use REST");

      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");

      const shallow = refs.find((r) => r.relativeKeyPath === "windsurf/rules/coding-standards.md");
      expect(shallow).toEqual({
        absolutePath: join(rulesDir, "coding-standards.md"),
        relativeKeyPath: "windsurf/rules/coding-standards.md",
        exists: true,
      });

      const nested = refs.find((r) => r.relativeKeyPath === "windsurf/rules/backend/api.md");
      expect(nested).toEqual({
        absolutePath: join(deepDir, "api.md"),
        relativeKeyPath: "windsurf/rules/backend/api.md",
        exists: true,
      });

      expect(
        windsurfDetector.resolveLocalPath("windsurf/rules/backend/api.md", dir, "/unused/home", "project"),
      ).toBe(join(deepDir, "api.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers nested .md files under .devin/rules/ with windsurf/devin-rules/... keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    try {
      const rulesDir = join(dir, ".devin", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(rulesDir, "coding-standards.md"), "use tabs");
      const deepDir = join(rulesDir, "backend");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, "api.md"), "use REST");

      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");

      const shallow = refs.find((r) => r.relativeKeyPath === "windsurf/devin-rules/coding-standards.md");
      expect(shallow).toEqual({
        absolutePath: join(rulesDir, "coding-standards.md"),
        relativeKeyPath: "windsurf/devin-rules/coding-standards.md",
        exists: true,
      });

      const nested = refs.find((r) => r.relativeKeyPath === "windsurf/devin-rules/backend/api.md");
      expect(nested).toEqual({
        absolutePath: join(deepDir, "api.md"),
        relativeKeyPath: "windsurf/devin-rules/backend/api.md",
        exists: true,
      });

      expect(
        windsurfDetector.resolveLocalPath("windsurf/devin-rules/backend/api.md", dir, "/unused/home", "project"),
      ).toBe(join(deepDir, "api.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns entries from .windsurfrules, .windsurf/rules/, and .devin/rules/ together, with no key collisions even for identical basenames", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    try {
      writeFileSync(join(dir, ".windsurfrules"), "legacy rules");

      const windsurfRulesDir = join(dir, ".windsurf", "rules");
      mkdirSync(windsurfRulesDir, { recursive: true });
      writeFileSync(join(windsurfRulesDir, "shared-name.md"), "windsurf version");

      const devinRulesDir = join(dir, ".devin", "rules");
      mkdirSync(devinRulesDir, { recursive: true });
      writeFileSync(join(devinRulesDir, "shared-name.md"), "devin version");

      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.find((r) => r.relativeKeyPath === "windsurf/.windsurfrules")).toBeDefined();

      const windsurfEntry = refs.find((r) => r.relativeKeyPath === "windsurf/rules/shared-name.md");
      expect(windsurfEntry).toEqual({
        absolutePath: join(windsurfRulesDir, "shared-name.md"),
        relativeKeyPath: "windsurf/rules/shared-name.md",
        exists: true,
      });

      const devinEntry = refs.find((r) => r.relativeKeyPath === "windsurf/devin-rules/shared-name.md");
      expect(devinEntry).toEqual({
        absolutePath: join(devinRulesDir, "shared-name.md"),
        relativeKeyPath: "windsurf/devin-rules/shared-name.md",
        exists: true,
      });

      // No collisions: the two "shared-name.md" entries must resolve back to their own distinct files.
      expect(
        windsurfDetector.resolveLocalPath("windsurf/rules/shared-name.md", dir, "/unused/home", "project"),
      ).toBe(join(windsurfRulesDir, "shared-name.md"));
      expect(
        windsurfDetector.resolveLocalPath("windsurf/devin-rules/shared-name.md", dir, "/unused/home", "project"),
      ).toBe(join(devinRulesDir, "shared-name.md"));

      expect(refs).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked subdirectory under .windsurf/rules/ or .devin/rules/", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    let outsideDir = "";
    try {
      const windsurfRulesDir = join(dir, ".windsurf", "rules");
      mkdirSync(windsurfRulesDir, { recursive: true });
      const devinRulesDir = join(dir, ".devin", "rules");
      mkdirSync(devinRulesDir, { recursive: true });

      outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-dir-"));
      writeFileSync(join(outsideDir, "secret.md"), "should not be picked up");
      symlinkSync(outsideDir, join(windsurfRulesDir, "linked-rules"), "dir");
      symlinkSync(outsideDir, join(devinRulesDir, "linked-rules"), "dir");

      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.some((r) => r.relativeKeyPath.includes("secret.md"))).toBe(false);
      expect(refs.some((r) => r.relativeKeyPath.includes("linked-rules"))).toBe(false);
    } finally {
      if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pick up a symlinked .md file directly under .windsurf/rules/ or .devin/rules/", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-windsurf-"));
    let outsideDir = "";
    try {
      const windsurfRulesDir = join(dir, ".windsurf", "rules");
      mkdirSync(windsurfRulesDir, { recursive: true });
      const devinRulesDir = join(dir, ".devin", "rules");
      mkdirSync(devinRulesDir, { recursive: true });

      outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-file-"));
      const outsideFile = join(outsideDir, "real_secret.md");
      writeFileSync(outsideFile, "outside content");
      symlinkSync(outsideFile, join(windsurfRulesDir, "linked_style.md"), "file");
      symlinkSync(outsideFile, join(devinRulesDir, "linked_style.md"), "file");

      const refs = windsurfDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.some((r) => r.relativeKeyPath === "windsurf/rules/linked_style.md")).toBe(false);
      expect(refs.some((r) => r.relativeKeyPath === "windsurf/devin-rules/linked_style.md")).toBe(false);
    } finally {
      if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns only the .windsurfrules entry when neither .windsurf/ nor .devin/ exist (regression: matches today's behavior)", () => {
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
      expect(() =>
        windsurfDetector.resolveLocalPath("windsurf/rules/style.md", projectDir, "/unused/home", "global"),
      ).toThrow();
      expect(() =>
        windsurfDetector.resolveLocalPath("windsurf/devin-rules/style.md", projectDir, "/unused/home", "global"),
      ).toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
