import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatch, generateInstallInstructions } from "../../src/cli/watch.js";
import { upsertRegistryEntry } from "../../src/registry.js";
import type { Detector, GitRemoteBackend } from "../../src/types.js";

const noopDetector: Detector = {
  name: "noop",
  findProjectFiles: () => [],
  findGlobalFiles: () => [],
  resolveLocalPath: () => "/unused",
};

const fakeBackend: GitRemoteBackend = {
  ensureLocalClone: async () => "/unused",
  initRemote: async () => {},
  push: async () => {},
  pull: async () => ({ fastForward: true, changedFiles: [], skippedUnsafe: [] }),
  checkVisibility: async () => "private",
};

describe("startWatch", () => {
  it("debounces multiple file-change events into a single push", async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", "/some/project", () => "t");

      const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void };
      fakeWatcher.close = vi.fn();
      const chokidarWatch = vi.fn(() => fakeWatcher);

      const pushSpy = vi.fn(async () => {});
      const handle = startWatch(
        { backend: fakeBackend, detectors: [noopDetector], homeDir: home, registryPath, lockPath: join(home, "repo.lock") },
        { chokidarWatch: chokidarWatch as any, debounceMs: 500, pushAllRegisteredFn: pushSpy as any },
      );

      fakeWatcher.emit("change", "/some/project/MEMORY.md");
      fakeWatcher.emit("change", "/some/project/MEMORY.md");
      vi.advanceTimersByTime(500);
      await Promise.resolve();

      expect(pushSpy).toHaveBeenCalledTimes(1);
      handle.stop();
      expect(fakeWatcher.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("logs a visible warning when a per-project push fails (pushAllRegistered resolves, never rejects)", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", "/some/project", () => "t");

      const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void };
      fakeWatcher.close = vi.fn();
      const chokidarWatch = vi.fn(() => fakeWatcher);

      // Task 20's isolation fix means a conflict is a resolved Map entry, not a
      // rejection — watch must inspect the Map, or the failure is invisible.
      const pushSpy = vi.fn(async () =>
        new Map([
          ["acme/widgets", { failed: true, error: "push rejected: local clone is not fast-forward with origin/main" }],
        ]),
      );
      const handle = startWatch(
        { backend: fakeBackend, detectors: [noopDetector], homeDir: home, registryPath, lockPath: join(home, "repo.lock") },
        { chokidarWatch: chokidarWatch as any, debounceMs: 0, pushAllRegisteredFn: pushSpy as any },
      );

      fakeWatcher.emit("change", "/some/project/MEMORY.md");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("acme/widgets");
      expect(output).toContain("not fast-forward");
      handle.stop();
    } finally {
      vi.restoreAllMocks();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("generateInstallInstructions", () => {
  it("returns a launchd/cron-based script on darwin/linux", () => {
    expect(generateInstallInstructions("darwin").ok).toBe(true);
    expect(generateInstallInstructions("linux").ok).toBe(true);
  });

  it("returns ok:false on win32", () => {
    const result = generateInstallInstructions("win32");
    expect(result.ok).toBe(false);
  });
});
