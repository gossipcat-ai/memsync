import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeProjectFiles,
  writeGlobalFiles,
  readProjectFilesFromClone,
  readGlobalFilesFromClone,
  updateIndexJson,
  updateMetaJson,
} from "../../src/sync-engine/clone-writer.js";
import { UnsafePathError } from "../../src/path-safety.js";
import type { FileRef } from "../../src/types.js";

describe("clone-writer", () => {
  it("writeProjectFiles copies files as a single flat file at the clone root, never a real subdirectory", () => {
    const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      writeFileSync(join(source, "MEMORY.md"), "hello");
      const files: FileRef[] = [
        { absolutePath: join(source, "MEMORY.md"), relativeKeyPath: "claude/MEMORY.md", exists: true },
      ];
      writeProjectFiles(clone, "acme/widgets", files);
      const flatPath = join(clone, "acme%2Fwidgets%2Fclaude%2FMEMORY.md");
      expect(readFileSync(flatPath, "utf8")).toBe("hello");
      expect(existsSync(join(clone, "acme"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("writeGlobalFiles copies files as a single flat file at the clone root", () => {
    const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      writeFileSync(join(source, "CLAUDE.md"), "global prefs");
      const files: FileRef[] = [
        { absolutePath: join(source, "CLAUDE.md"), relativeKeyPath: "claude/CLAUDE.md", exists: true },
      ];
      writeGlobalFiles(clone, files);
      const flatPath = join(clone, "global%2Fclaude%2FCLAUDE.md");
      expect(readFileSync(flatPath, "utf8")).toBe("global prefs");
      expect(existsSync(join(clone, "global"))).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("readProjectFilesFromClone reads back what was written", () => {
    const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      writeFileSync(join(source, "MEMORY.md"), "hello again");
      writeProjectFiles(clone, "acme/widgets", [
        { absolutePath: join(source, "MEMORY.md"), relativeKeyPath: "claude/MEMORY.md", exists: true },
      ]);
      const projectFiles = readProjectFilesFromClone(clone, "acme/widgets");
      const memory = projectFiles.find((f) => f.relativeKeyPath === "claude/MEMORY.md");
      expect(memory?.content.toString("utf8")).toBe("hello again");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("readGlobalFilesFromClone reads back what was written", () => {
    const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      writeFileSync(join(source, "CLAUDE.md"), "global again");
      writeGlobalFiles(clone, [
        { absolutePath: join(source, "CLAUDE.md"), relativeKeyPath: "claude/CLAUDE.md", exists: true },
      ]);
      const globalFiles = readGlobalFilesFromClone(clone);
      const memory = globalFiles.find((f) => f.relativeKeyPath === "claude/CLAUDE.md");
      expect(memory?.content.toString("utf8")).toBe("global again");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("readProjectFilesFromClone and readGlobalFilesFromClone only return entries under their own logical prefix", () => {
    const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      writeFileSync(join(source, "a.md"), "project a");
      writeFileSync(join(source, "b.md"), "project b");
      writeFileSync(join(source, "c.md"), "global c");
      writeProjectFiles(clone, "acme/widgets", [
        { absolutePath: join(source, "a.md"), relativeKeyPath: "claude/a.md", exists: true },
      ]);
      writeProjectFiles(clone, "other/project", [
        { absolutePath: join(source, "b.md"), relativeKeyPath: "claude/b.md", exists: true },
      ]);
      writeGlobalFiles(clone, [
        { absolutePath: join(source, "c.md"), relativeKeyPath: "claude/c.md", exists: true },
      ]);
      const acmeFiles = readProjectFilesFromClone(clone, "acme/widgets");
      expect(acmeFiles.map((f) => f.relativeKeyPath)).toEqual(["claude/a.md"]);
      const otherFiles = readProjectFilesFromClone(clone, "other/project");
      expect(otherFiles.map((f) => f.relativeKeyPath)).toEqual(["claude/b.md"]);
      const globalFiles = readGlobalFilesFromClone(clone);
      expect(globalFiles.map((f) => f.relativeKeyPath)).toEqual(["claude/c.md"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("readProjectFilesFromClone does not follow a symlink planted inside the clone dir", () => {
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    try {
      const secret = join(outside, "secret.txt");
      writeFileSync(secret, "top secret contents");
      mkdirSync(clone, { recursive: true });
      const link = join(clone, "acme%2Fwidgets%2Fclaude%2FMEMORY.md");
      symlinkSync(secret, link);
      const projectFiles = readProjectFilesFromClone(clone, "acme/widgets");
      const leaked = projectFiles.find((f) => f.content.toString("utf8").includes("top secret contents"));
      expect(leaked).toBeUndefined();
      expect(projectFiles.find((f) => f.relativeKeyPath === "claude/MEMORY.md")).toBeUndefined();
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("readGlobalFilesFromClone does not follow a symlinked directory planted inside the clone dir", () => {
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside directory contents");
      mkdirSync(clone, { recursive: true });
      symlinkSync(outside, join(clone, "global%2Flinked-dir"));
      const globalFiles = readGlobalFilesFromClone(clone);
      const leaked = globalFiles.find((f) => f.content.toString("utf8").includes("outside directory contents"));
      expect(leaked).toBeUndefined();
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("updateIndexJson adds formatVersion:1 and the projectKey, idempotently", () => {
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      updateIndexJson(clone, "acme/widgets");
      updateIndexJson(clone, "acme/widgets");
      updateIndexJson(clone, "other/project");
      const index = JSON.parse(readFileSync(join(clone, "index.json"), "utf8"));
      expect(index).toEqual({ formatVersion: 1, projects: ["acme/widgets", "other/project"] });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("updateMetaJson writes displayName/activeTools/lastSyncedAt/hostname for the project as a flat file", () => {
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      updateMetaJson(clone, "acme/widgets", ["claude-code", "cursor"], "my-macbook");
      const meta = JSON.parse(readFileSync(join(clone, "acme%2Fwidgets%2Fmeta.json"), "utf8"));
      expect(meta.activeTools).toEqual(["claude-code", "cursor"]);
      expect(meta.hostname).toBe("my-macbook");
      expect(typeof meta.lastSyncedAt).toBe("string");
      expect(existsSync(join(clone, "acme"))).toBe(false);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("never creates a real subdirectory under the clone root for any operation", () => {
    const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
    const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    try {
      writeFileSync(join(source, "MEMORY.md"), "hello");
      writeProjectFiles(clone, "acme/widgets", [
        { absolutePath: join(source, "MEMORY.md"), relativeKeyPath: "claude/memory/MEMORY.md", exists: true },
      ]);
      updateMetaJson(clone, "acme/widgets", ["claude-code"], "host");
      updateIndexJson(clone, "acme/widgets");
      writeGlobalFiles(clone, [
        { absolutePath: join(source, "MEMORY.md"), relativeKeyPath: "claude/CLAUDE.md", exists: true },
      ]);
      for (const entry of readdirSync(clone, { withFileTypes: true })) {
        expect(entry.isDirectory()).toBe(false);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  describe("path safety", () => {
    it("writeProjectFiles rejects a projectKey containing .. without writing anything", () => {
      const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
      const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
      try {
        writeFileSync(join(source, "MEMORY.md"), "hello");
        const files: FileRef[] = [
          { absolutePath: join(source, "MEMORY.md"), relativeKeyPath: "claude/MEMORY.md", exists: true },
        ];
        expect(() => writeProjectFiles(clone, "../../etc", files)).toThrow(UnsafePathError);
        expect(existsSync(join(clone, "..", "..", "etc"))).toBe(false);
      } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it("writeProjectFiles rejects a FileRef.relativeKeyPath containing .. without writing anything", () => {
      const source = mkdtempSync(join(tmpdir(), "memsync-src-"));
      const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
      try {
        writeFileSync(join(source, "MEMORY.md"), "hello");
        const files: FileRef[] = [
          { absolutePath: join(source, "MEMORY.md"), relativeKeyPath: "../../etc/passwd", exists: true },
        ];
        expect(() => writeProjectFiles(clone, "acme/widgets", files)).toThrow(UnsafePathError);
        expect(readdirSync(clone).length).toBe(0);
      } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it("readProjectFilesFromClone rejects a projectKey containing ..", () => {
      const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
      try {
        expect(() => readProjectFilesFromClone(clone, "../../etc")).toThrow(UnsafePathError);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it("updateIndexJson rejects a projectKey containing .. without writing index.json", () => {
      const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
      try {
        expect(() => updateIndexJson(clone, "../../etc")).toThrow(UnsafePathError);
        expect(existsSync(join(clone, "index.json"))).toBe(false);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it("updateMetaJson rejects a projectKey containing .. without writing anything", () => {
      const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
      try {
        expect(() => updateMetaJson(clone, "../../etc", ["claude-code"], "host")).toThrow(UnsafePathError);
        expect(existsSync(join(clone, "etc"))).toBe(false);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it("readProjectFilesFromClone skips a flat filename that decodes to a relativeKeyPath containing .. instead of returning or throwing", () => {
      const clone = mkdtempSync(join(tmpdir(), "memsync-clone-"));
      try {
        mkdirSync(clone, { recursive: true });
        // A flat filename is just an on-disk name with no real "/" in it, so it
        // passes the symlink/directory checks in readAllUnder unremarkably —
        // but it was written by something untrusted (a gist), and it decodes
        // to a relativeKeyPath that escapes the project prefix via "..".
        const maliciousFlatName = "acme%2Fwidgets%2F..%2F..%2F..%2Fetc%2Fpasswd";
        writeFileSync(join(clone, maliciousFlatName), "attacker-controlled content");
        let projectFiles: ReturnType<typeof readProjectFilesFromClone> = [];
        expect(() => {
          projectFiles = readProjectFilesFromClone(clone, "acme/widgets");
        }).not.toThrow();
        expect(projectFiles.some((f) => f.relativeKeyPath.includes(".."))).toBe(false);
        expect(projectFiles.length).toBe(0);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });
  });
});
