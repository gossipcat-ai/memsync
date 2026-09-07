import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorDetector } from "../../src/detectors/cursor.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
  };
});

describe("cursorDetector.findProjectFiles", () => {
  it("returns .cursorrules and rules/*.md when .cursor/ exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    try {
      mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(dir, ".cursorrules"), "be nice");
      writeFileSync(join(dir, ".cursor", "rules", "style.md"), "use tabs");

      const refs = cursorDetector.findProjectFiles(dir, "/unused/home");
      expect(refs.find((r) => r.relativeKeyPath === "cursor/.cursorrules")).toEqual({
        absolutePath: join(dir, ".cursorrules"),
        relativeKeyPath: "cursor/.cursorrules",
        exists: true,
      });
      expect(refs.find((r) => r.relativeKeyPath === "cursor/rules/style.md")).toEqual({
        absolutePath: join(dir, ".cursor", "rules", "style.md"),
        relativeKeyPath: "cursor/rules/style.md",
        exists: true,
      });

      expect(cursorDetector.resolveLocalPath("cursor/.cursorrules", dir, "/unused/home", "project")).toBe(
        join(dir, ".cursorrules"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports .cursorrules as exists:false when .cursor/ exists but the file doesn't", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    try {
      mkdirSync(join(dir, ".cursor"), { recursive: true });
      const refs = cursorDetector.findProjectFiles(dir, "/unused/home");
      expect(refs.find((r) => r.relativeKeyPath === "cursor/.cursorrules")?.exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no FileRef at all when Cursor was never used", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    try {
      expect(cursorDetector.findProjectFiles(dir, "/unused/home")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recurses into subdirectories of .cursor/rules/ and picks up nested .md files", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    try {
      const rulesDir = join(dir, ".cursor", "rules");
      const subDir = join(rulesDir, "backend");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "api.md"), "use REST");

      const refs = cursorDetector.findProjectFiles(dir, "/unused/home");

      const nested = refs.find((r) => r.relativeKeyPath === "cursor/rules/backend/api.md");
      expect(nested).toBeDefined();
      expect(nested?.exists).toBe(true);
      expect(nested?.absolutePath).toBe(join(subDir, "api.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recurses 2+ levels deep into .cursor/rules/ subdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    try {
      const rulesDir = join(dir, ".cursor", "rules");
      const deepDir = join(rulesDir, "backend", "services");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, "billing.md"), "idempotency keys");

      const refs = cursorDetector.findProjectFiles(dir, "/unused/home");

      const deep = refs.find((r) => r.relativeKeyPath === "cursor/rules/backend/services/billing.md");
      expect(deep).toBeDefined();
      expect(deep?.exists).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked subdirectory under .cursor/rules/", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    let outsideDir = "";
    try {
      const rulesDir = join(dir, ".cursor", "rules");
      mkdirSync(rulesDir, { recursive: true });

      outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-dir-"));
      writeFileSync(join(outsideDir, "secret.md"), "should not be picked up");
      symlinkSync(outsideDir, join(rulesDir, "linked-rules"), "dir");

      const refs = cursorDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.some((r) => r.relativeKeyPath.includes("secret.md"))).toBe(false);
      expect(refs.some((r) => r.relativeKeyPath.includes("linked-rules"))).toBe(false);
    } finally {
      if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pick up a symlinked .md file directly under .cursor/rules/", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
    let outsideDir = "";
    try {
      const rulesDir = join(dir, ".cursor", "rules");
      mkdirSync(rulesDir, { recursive: true });

      outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-file-"));
      const outsideFile = join(outsideDir, "real_secret.md");
      writeFileSync(outsideFile, "outside content");
      symlinkSync(outsideFile, join(rulesDir, "linked_style.md"), "file");

      const refs = cursorDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.some((r) => r.relativeKeyPath === "cursor/rules/linked_style.md")).toBe(false);
    } finally {
      if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("when readdirSync throws (e.g. permission revoked between existsSync check and read)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not throw, and still returns the .cursorrules FileRef", () => {
      const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
      try {
        mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
        writeFileSync(join(dir, ".cursorrules"), "be nice");
        writeFileSync(join(dir, ".cursor", "rules", "style.md"), "use tabs");

        vi.mocked(readdirSync).mockImplementationOnce(() => {
          throw new Error("EACCES: permission denied, scandir");
        });

        let refs: ReturnType<typeof cursorDetector.findProjectFiles> = [];
        expect(() => {
          refs = cursorDetector.findProjectFiles(dir, "/unused/home");
        }).not.toThrow();

        const rulesFile = refs.find((r) => r.relativeKeyPath === "cursor/.cursorrules");
        expect(rulesFile?.exists).toBe(true);
        // No rules/*.md entries should be present since readdir failed.
        expect(refs.filter((r) => r.relativeKeyPath.startsWith("cursor/rules/"))).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("skips just the affected subtree (not the whole walk) when a nested subdirectory's readdirSync throws", async () => {
      const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const dir = mkdtempSync(join(tmpdir(), "memsync-cursor-"));
      try {
        const rulesDir = join(dir, ".cursor", "rules");
        const brokenDir = join(rulesDir, "broken");
        const okDir = join(rulesDir, "ok");
        mkdirSync(brokenDir, { recursive: true });
        mkdirSync(okDir, { recursive: true });
        writeFileSync(join(brokenDir, "unreadable.md"), "should not appear");
        writeFileSync(join(okDir, "readable.md"), "should appear");

        vi.mocked(readdirSync).mockImplementation(((dirPath: unknown, ...rest: unknown[]) => {
          if (dirPath === brokenDir) {
            throw new Error("EACCES: permission denied, scandir");
          }
          return (actualFs.readdirSync as (...a: unknown[]) => unknown)(dirPath, ...rest);
        }) as typeof readdirSync);

        let refs: ReturnType<typeof cursorDetector.findProjectFiles> = [];
        expect(() => {
          refs = cursorDetector.findProjectFiles(dir, "/unused/home");
        }).not.toThrow();

        expect(refs.some((r) => r.relativeKeyPath === "cursor/rules/ok/readable.md")).toBe(true);
        expect(refs.some((r) => r.relativeKeyPath.startsWith("cursor/rules/broken/"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("cursorDetector.findGlobalFiles", () => {
  it("returns an empty array (no documented Cursor global memory)", () => {
    expect(cursorDetector.findGlobalFiles("/any/home")).toEqual([]);
  });
});

describe("cursorDetector.resolveLocalPath scope isolation", () => {
  // TypeScript's structural typing cannot force a Detector implementation to actually
  // consult its `scope` argument, so this rejection is only guarded by a test. Cursor's
  // findGlobalFiles always returns [], so it owns no key under the gist's `global/`
  // prefix — a global-scope entry must never resolve to a real project file.
  it("rejects a project-scope key presented in global scope", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-cursor-scope-"));
    try {
      expect(() =>
        cursorDetector.resolveLocalPath("cursor/.cursorrules", projectDir, "/unused/home", "global"),
      ).toThrow();
      expect(() =>
        cursorDetector.resolveLocalPath("cursor/rules/style.md", projectDir, "/unused/home", "global"),
      ).toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
