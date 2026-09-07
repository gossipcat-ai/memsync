import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_IGNORE_PATTERNS,
  loadIgnorePatterns,
  filterIgnored,
  scanContentForSecretMatches,
} from "../src/ignore.js";
import type { FileRef } from "../src/types.js";

describe("loadIgnorePatterns", () => {
  it("returns the default patterns when no .memsyncignore files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-ign-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-ign-home-"));
    try {
      expect(loadIgnorePatterns(dir, home)).toEqual(DEFAULT_IGNORE_PATTERNS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges project .memsyncignore and global ~/.memsync/ignore patterns with defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-ign-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-ign-home-"));
    try {
      writeFileSync(join(dir, ".memsyncignore"), "*.secret\n");
      mkdirSync(join(home, ".memsync"), { recursive: true });
      writeFileSync(join(home, ".memsync", "ignore"), "*.private\n");
      const patterns = loadIgnorePatterns(dir, home);
      expect(patterns).toEqual(expect.arrayContaining([...DEFAULT_IGNORE_PATTERNS, "*.secret", "*.private"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("filterIgnored", () => {
  it("removes files whose relativeKeyPath matches a pattern", () => {
    const files: FileRef[] = [
      { absolutePath: "/p/a.md", relativeKeyPath: "claude/a.md", exists: true },
      { absolutePath: "/p/apikey.md", relativeKeyPath: "claude/apikey.md", exists: true },
    ];
    const kept = filterIgnored(files, ["*apikey*"]);
    expect(kept).toEqual([files[0]]);
  });
});

describe("scanContentForSecretMatches", () => {
  it("reports relativeKeyPaths whose content matches a token-shaped pattern, without removing them", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-ign-content-"));
    try {
      const file = join(dir, "MEMORY.md");
      writeFileSync(file, "remember: token=sk-abc123");
      const files: FileRef[] = [{ absolutePath: file, relativeKeyPath: "claude/MEMORY.md", exists: true }];
      const flagged = scanContentForSecretMatches(files, ["*token*"]);
      expect(flagged).toEqual(["claude/MEMORY.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty array when no pattern-like text is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-ign-content-"));
    try {
      const file = join(dir, "MEMORY.md");
      writeFileSync(file, "the user prefers tabs over spaces");
      const files: FileRef[] = [{ absolutePath: file, relativeKeyPath: "claude/MEMORY.md", exists: true }];
      expect(scanContentForSecretMatches(files, ["*token*", "*api*key*"])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
