import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, saveRegistry, upsertRegistryEntry } from "../src/registry.js";

describe("registry", () => {
  it("loadRegistry returns an empty object when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-reg-"));
    try {
      expect(loadRegistry(join(dir, "registry.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveRegistry writes the file with 0600 permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-reg-"));
    try {
      const path = join(dir, "registry.json");
      saveRegistry(path, { "acme/widgets": { absolutePath: "/x", lastSyncedAt: "2026-01-01T00:00:00.000Z" } });
      expect(existsSync(path)).toBe(true);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsertRegistryEntry adds a new entry and round-trips through load/save", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-reg-"));
    try {
      const path = join(dir, "registry.json");
      upsertRegistryEntry(path, "acme/widgets", "/Users/me/widgets", () => "2026-02-02T00:00:00.000Z");
      const reg = loadRegistry(path);
      expect(reg["acme/widgets"]).toEqual({
        absolutePath: "/Users/me/widgets",
        lastSyncedAt: "2026-02-02T00:00:00.000Z",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsertRegistryEntry updates an existing entry in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-reg-"));
    try {
      const path = join(dir, "registry.json");
      upsertRegistryEntry(path, "k", "/a", () => "t1");
      upsertRegistryEntry(path, "k", "/a", () => "t2");
      const reg = loadRegistry(path);
      expect(Object.keys(reg)).toHaveLength(1);
      expect(reg.k.lastSyncedAt).toBe("t2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveRegistry corrects permissions back to 0600 on a file that already has wider permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-reg-"));
    try {
      const path = join(dir, "registry.json");
      // Simulate a pre-existing registry file with overly-permissive mode
      // (e.g. created by a different umask or hand-edited).
      writeFileSync(path, "{}");
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);

      saveRegistry(path, { k: { absolutePath: "/a", lastSyncedAt: "t1" } });

      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveRegistry creates the parent directory if it does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-reg-"));
    try {
      const path = join(dir, "nested", "does", "not", "exist", "registry.json");
      expect(() =>
        saveRegistry(path, { k: { absolutePath: "/a", lastSyncedAt: "t1" } }),
      ).not.toThrow();
      expect(existsSync(path)).toBe(true);
      expect(loadRegistry(path)).toEqual({ k: { absolutePath: "/a", lastSyncedAt: "t1" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
