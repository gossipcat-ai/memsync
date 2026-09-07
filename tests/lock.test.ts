import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError } from "../src/lock.js";

describe("acquireLock", () => {
  it("creates a lock file and the release function removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-lock-"));
    try {
      const lockPath = join(dir, "repo.lock");
      const release = acquireLock(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws LockHeldError immediately when the lock is already held", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-lock-"));
    try {
      const lockPath = join(dir, "repo.lock");
      const release = acquireLock(lockPath);
      expect(() => acquireLock(lockPath)).toThrow(LockHeldError);
      release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can be re-acquired after release", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-lock-"));
    try {
      const lockPath = join(dir, "repo.lock");
      acquireLock(lockPath)();
      expect(() => acquireLock(lockPath)()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the lock file's parent directory when it doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-lock-"));
    try {
      const lockPath = join(dir, "nested", "sub", "repo.lock");
      expect(existsSync(join(dir, "nested"))).toBe(false);
      const release = acquireLock(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still throws LockHeldError when already held, even with the mkdirSync call in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-lock-"));
    try {
      const lockPath = join(dir, "nested", "sub", "repo.lock");
      const release = acquireLock(lockPath);
      expect(() => acquireLock(lockPath)).toThrow(LockHeldError);
      release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
