import { describe, it, expect } from "vitest";
import { resolveProjectKeyFallback } from "../src/project-key.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeGitRemoteUrl, getGitRemoteUrl, resolveProjectKeyForDir } from "../src/project-key.js";

describe("resolveProjectKeyFallback", () => {
  it("combines the folder name with a stable 6-hex-char path hash", () => {
    const key = resolveProjectKeyFallback("/Users/goku/Desktop/projects/brain-transplant");
    expect(key).toMatch(/^brain-transplant-[0-9a-f]{6}$/);
  });

  it("is deterministic for the same path", () => {
    const a = resolveProjectKeyFallback("/Users/goku/projects/x");
    const b = resolveProjectKeyFallback("/Users/goku/projects/x");
    expect(a).toBe(b);
  });

  it("produces different keys for different paths with the same folder name", () => {
    const a = resolveProjectKeyFallback("/Users/alice/projects/x");
    const b = resolveProjectKeyFallback("/Users/bob/projects/x");
    expect(a).not.toBe(b);
  });
});

describe("normalizeGitRemoteUrl", () => {
  it("normalizes https and ssh forms of the same repo to the same key", () => {
    const https = normalizeGitRemoteUrl("https://github.com/acme/widgets.git");
    const httpsNoSuffix = normalizeGitRemoteUrl("https://github.com/acme/widgets");
    const ssh = normalizeGitRemoteUrl("git@github.com:acme/widgets.git");
    expect(https).toBe(httpsNoSuffix);
    expect(https).toBe(ssh);
  });

  it("lowercases the host", () => {
    expect(normalizeGitRemoteUrl("https://GitHub.com/acme/widgets.git")).toBe(
      normalizeGitRemoteUrl("https://github.com/acme/widgets.git"),
    );
  });

  it("strips embedded userinfo credentials from an https remote", () => {
    const withCreds = normalizeGitRemoteUrl(
      "https://x-access-token:ghp_SECRETTOKEN@github.com/acme/widgets.git",
    );
    const withoutCreds = normalizeGitRemoteUrl("https://github.com/acme/widgets.git");
    expect(withCreds).not.toMatch(/ghp_SECRETTOKEN/);
    expect(withCreds).not.toMatch(/x-access-token/);
    expect(withCreds).toBe(withoutCreds);
  });

  it("still normalizes the ssh scp-like form correctly (git@ is not a leaked credential)", () => {
    expect(normalizeGitRemoteUrl("git@github.com:acme/widgets.git")).toBe(
      normalizeGitRemoteUrl("https://github.com/acme/widgets.git"),
    );
  });

  it("preserves owner/repo path case while still lowercasing the host", () => {
    const upper = normalizeGitRemoteUrl("https://example.com/Acme/Widgets.git");
    const lower = normalizeGitRemoteUrl("https://example.com/acme/widgets.git");
    expect(upper).not.toBe(lower);
    expect(upper).toMatch(/Acme\/Widgets/);
  });
});

describe("resolveProjectKeyForDir", () => {
  it("uses the normalized git remote when one exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
      expect(resolveProjectKeyForDir(dir)).toBe(normalizeGitRemoteUrl("git@github.com:acme/widgets.git"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to folder-name+hash when there is no git remote", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-nogit-"));
    try {
      expect(resolveProjectKeyForDir(dir)).toMatch(/^memsync-nogit-[a-zA-Z0-9]+-[0-9a-f]{6}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null from getGitRemoteUrl outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-nogit2-"));
    try {
      expect(getGitRemoteUrl(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
