import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeDetector, encodeClaudeProjectPath } from "../../src/detectors/claude-code.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
  };
});

describe("encodeClaudeProjectPath", () => {
  it("replaces path separators with dashes", () => {
    expect(encodeClaudeProjectPath("/Users/goku/Desktop/projects/brain-transplant")).toBe(
      "-Users-goku-Desktop-projects-brain-transplant",
    );
  });
});

describe("claudeCodeDetector.findProjectFiles", () => {
  it("returns MEMORY.md as exists:true when present, plus other memory/*.md files", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = "/fake/project/path";
    try {
      const encoded = encodeClaudeProjectPath(projectDir);
      const memDir = join(home, ".claude", "projects", encoded, "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "index");
      writeFileSync(join(memDir, "feedback_testing.md"), "note");

      const refs = claudeCodeDetector.findProjectFiles(projectDir, home);

      const memoryMd = refs.find((r) => r.relativeKeyPath === "claude/MEMORY.md");
      expect(memoryMd?.exists).toBe(true);
      const other = refs.find((r) => r.relativeKeyPath === "claude/memory/feedback_testing.md");
      expect(other?.exists).toBe(true);

      expect(claudeCodeDetector.resolveLocalPath("claude/MEMORY.md", projectDir, home, "project")).toBe(
        join(memDir, "MEMORY.md"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns MEMORY.md as exists:false when the project's claude dir exists but MEMORY.md is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = "/fake/project/path2";
    try {
      const encoded = encodeClaudeProjectPath(projectDir);
      mkdirSync(join(home, ".claude", "projects", encoded, "memory"), { recursive: true });

      const refs = claudeCodeDetector.findProjectFiles(projectDir, home);
      const memoryMd = refs.find((r) => r.relativeKeyPath === "claude/MEMORY.md");
      expect(memoryMd?.exists).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns no FileRef at all when Claude Code was never used for this project", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      const refs = claudeCodeDetector.findProjectFiles("/fake/never-used", home);
      expect(refs).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recurses into subdirectories of memory/ and picks up nested .md files", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = "/fake/project/path-nested";
    try {
      const encoded = encodeClaudeProjectPath(projectDir);
      const memDir = join(home, ".claude", "projects", encoded, "memory");
      const archiveDir = join(memDir, "archive");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "index");
      writeFileSync(join(archiveDir, "some_note.md"), "archived note");

      const refs = claudeCodeDetector.findProjectFiles(projectDir, home);

      const nested = refs.find((r) => r.relativeKeyPath === "claude/memory/archive/some_note.md");
      expect(nested).toBeDefined();
      expect(nested?.exists).toBe(true);
      expect(nested?.absolutePath).toBe(join(archiveDir, "some_note.md"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recurses 2+ levels deep into memory/ subdirectories", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = "/fake/project/path-deep-nested";
    try {
      const encoded = encodeClaudeProjectPath(projectDir);
      const memDir = join(home, ".claude", "projects", encoded, "memory");
      const deepDir = join(memDir, "archive", "2026");
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "index");
      writeFileSync(join(deepDir, "note.md"), "deep note");

      const refs = claudeCodeDetector.findProjectFiles(projectDir, home);

      const deep = refs.find((r) => r.relativeKeyPath === "claude/memory/archive/2026/note.md");
      expect(deep).toBeDefined();
      expect(deep?.exists).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked subdirectory under memory/", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = "/fake/project/path-symlinked-dir";
    try {
      const encoded = encodeClaudeProjectPath(projectDir);
      const memDir = join(home, ".claude", "projects", encoded, "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "index");

      const outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-dir-"));
      writeFileSync(join(outsideDir, "secret.md"), "should not be picked up");
      symlinkSync(outsideDir, join(memDir, "linked-archive"), "dir");

      const refs = claudeCodeDetector.findProjectFiles(projectDir, home);

      expect(refs.some((r) => r.relativeKeyPath.includes("secret.md"))).toBe(false);
      expect(refs.some((r) => r.relativeKeyPath.includes("linked-archive"))).toBe(false);

      rmSync(outsideDir, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not pick up a symlinked .md file directly under memory/", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = "/fake/project/path-symlinked-file";
    try {
      const encoded = encodeClaudeProjectPath(projectDir);
      const memDir = join(home, ".claude", "projects", encoded, "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "index");

      const outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-file-"));
      const outsideFile = join(outsideDir, "real_secret.md");
      writeFileSync(outsideFile, "outside content");
      symlinkSync(outsideFile, join(memDir, "linked_note.md"), "file");

      const refs = claudeCodeDetector.findProjectFiles(projectDir, home);

      expect(refs.some((r) => r.relativeKeyPath === "claude/memory/linked_note.md")).toBe(false);

      rmSync(outsideDir, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("when readdirSync throws (e.g. permission revoked between existsSync check and read)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not throw, and still returns the MEMORY.md FileRef", () => {
      const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
      const projectDir = "/fake/project/path-readdir-fails";
      try {
        const encoded = encodeClaudeProjectPath(projectDir);
        const memDir = join(home, ".claude", "projects", encoded, "memory");
        mkdirSync(memDir, { recursive: true });
        writeFileSync(join(memDir, "MEMORY.md"), "index");

        vi.mocked(readdirSync).mockImplementationOnce(() => {
          throw new Error("EACCES: permission denied, scandir");
        });

        let refs: ReturnType<typeof claudeCodeDetector.findProjectFiles> = [];
        expect(() => {
          refs = claudeCodeDetector.findProjectFiles(projectDir, home);
        }).not.toThrow();

        const memoryMd = refs.find((r) => r.relativeKeyPath === "claude/MEMORY.md");
        expect(memoryMd?.exists).toBe(true);
        // No other memory/*.md entries should be present since readdir failed.
        expect(refs.filter((r) => r.relativeKeyPath.startsWith("claude/memory/"))).toHaveLength(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("skips just the affected subtree (not the whole walk) when a nested subdirectory's readdirSync throws", async () => {
      const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
      const projectDir = "/fake/project/path-nested-readdir-fails";
      try {
        const encoded = encodeClaudeProjectPath(projectDir);
        const memDir = join(home, ".claude", "projects", encoded, "memory");
        const brokenDir = join(memDir, "broken");
        const okDir = join(memDir, "ok");
        mkdirSync(brokenDir, { recursive: true });
        mkdirSync(okDir, { recursive: true });
        writeFileSync(join(memDir, "MEMORY.md"), "index");
        writeFileSync(join(brokenDir, "unreadable.md"), "should not appear");
        writeFileSync(join(okDir, "readable.md"), "should appear");

        vi.mocked(readdirSync).mockImplementation(((dirPath: unknown, ...rest: unknown[]) => {
          if (dirPath === brokenDir) {
            throw new Error("EACCES: permission denied, scandir");
          }
          return (actualFs.readdirSync as (...a: unknown[]) => unknown)(dirPath, ...rest);
        }) as typeof readdirSync);

        let refs: ReturnType<typeof claudeCodeDetector.findProjectFiles> = [];
        expect(() => {
          refs = claudeCodeDetector.findProjectFiles(projectDir, home);
        }).not.toThrow();

        const memoryMd = refs.find((r) => r.relativeKeyPath === "claude/MEMORY.md");
        expect(memoryMd?.exists).toBe(true);
        expect(refs.some((r) => r.relativeKeyPath === "claude/memory/ok/readable.md")).toBe(true);
        expect(refs.some((r) => r.relativeKeyPath.startsWith("claude/memory/broken/"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe("claudeCodeDetector.resolveLocalPath scope isolation", () => {
  // TypeScript's structural typing cannot force a Detector implementation to actually
  // consult its `scope` argument, so these rejections are only guarded by tests.
  // claude-code is the one detector owning keys in BOTH scopes, so it must refuse each
  // key in the other one: a `<projectKey>/claude/CLAUDE.md` gist entry must never
  // overwrite the real $HOME/CLAUDE.md, and a `global/claude/MEMORY.md` entry must
  // never overwrite a project's memory index.
  it("rejects the global CLAUDE.md key when it arrives in project scope", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    try {
      expect(() =>
        claudeCodeDetector.resolveLocalPath("claude/CLAUDE.md", projectDir, home, "project"),
      ).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects project memory keys when they arrive in global scope", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    try {
      expect(() =>
        claudeCodeDetector.resolveLocalPath("claude/MEMORY.md", projectDir, home, "global"),
      ).toThrow();
      expect(() =>
        claudeCodeDetector.resolveLocalPath("claude/memory/notes.md", projectDir, home, "global"),
      ).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("claudeCodeDetector.findGlobalFiles", () => {
  it("returns global CLAUDE.md when present", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      writeFileSync(join(home, "CLAUDE.md"), "global prefs");
      const refs = claudeCodeDetector.findGlobalFiles(home);
      expect(refs).toEqual([
        { absolutePath: join(home, "CLAUDE.md"), relativeKeyPath: "claude/CLAUDE.md", exists: true },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
