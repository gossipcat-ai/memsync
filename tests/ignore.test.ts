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

  describe("default patterns — word-boundary-aware filename matching", () => {
    it("keeps files whose name merely contains 'api' and 'key' as substrings within other words", () => {
      const files: FileRef[] = [
        {
          absolutePath: "/p/reference_apigw_invalid_keyvalue_is_route_miss.md",
          relativeKeyPath: "claude/memory/reference_apigw_invalid_keyvalue_is_route_miss.md",
          exists: true,
        },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual(files);
    });

    it("keeps files whose name merely contains 'token' as a substring within another word", () => {
      const files: FileRef[] = [
        {
          absolutePath: "/p/archive/project_tokenizeit_engagement.md",
          relativeKeyPath: "claude/memory/archive/project_tokenizeit_engagement.md",
          exists: true,
        },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual(files);
    });

    it("excludes files with a standalone 'token' token in the name", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/gh_token.md", relativeKeyPath: "claude/memory/gh_token.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with standalone 'api' and 'key' tokens separated by a hyphen", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/api-key.md", relativeKeyPath: "claude/memory/api-key.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with standalone 'api' and 'key' tokens separated by an underscore", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/api_key.md", relativeKeyPath: "claude/memory/api_key.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with camelCase 'apiKey' by splitting on the camelCase boundary", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/apiKey.md", relativeKeyPath: "claude/memory/apiKey.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with a standalone 'env' token as a dotfile", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/.env.local", relativeKeyPath: "claude/memory/.env.local", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with a standalone 'env' token as a suffix", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/production.env", relativeKeyPath: "claude/memory/production.env", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with squashed, no-delimiter 'apikey' (api+key within one token)", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/apikey.md", relativeKeyPath: "claude/memory/apikey.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with squashed, no-delimiter 'mytoken' ('token' as a suffix of a token)", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/mytoken.md", relativeKeyPath: "claude/memory/mytoken.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with squashed, no-delimiter 'authtoken' ('token' as a suffix of a token)", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/authtoken.md", relativeKeyPath: "claude/memory/authtoken.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("excludes files with squashed, all-uppercase 'AUTHTOKEN' (lowercasing still applies before suffix check)", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/AUTHTOKEN.md", relativeKeyPath: "claude/memory/AUTHTOKEN.md", exists: true },
      ];
      const kept = filterIgnored(files, DEFAULT_IGNORE_PATTERNS);
      expect(kept).toEqual([]);
    });

    it("still applies custom (non-default) patterns as classic substring globs alongside the smarter default check", () => {
      const files: FileRef[] = [
        { absolutePath: "/p/a.md", relativeKeyPath: "claude/a.md", exists: true },
        {
          absolutePath: "/p/reference_apigw_invalid_keyvalue_is_route_miss.md",
          relativeKeyPath: "claude/memory/reference_apigw_invalid_keyvalue_is_route_miss.md",
          exists: true,
        },
      ];
      // "*apigw*" is a genuinely custom pattern (not one of the 3 defaults), so it
      // should still do classic substring globbing and exclude the second file.
      const kept = filterIgnored(files, [...DEFAULT_IGNORE_PATTERNS, "*apigw*"]);
      expect(kept).toEqual([files[0]]);
    });
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
