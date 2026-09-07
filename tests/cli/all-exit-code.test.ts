import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPush } from "../../src/cli/push.js";
import { runPull } from "../../src/cli/pull.js";
import { upsertRegistryEntry } from "../../src/registry.js";
import type { Detector, GitRemoteBackend, PullResult } from "../../src/types.js";

// Resolves nothing, so every file coming out of the clone lands in
// PullResult.skippedUnsafe.
const unresolvableDetector: Detector = {
  name: "unresolvable",
  findProjectFiles: () => [],
  findGlobalFiles: () => [],
  resolveLocalPath: (relativeKeyPath: string) => {
    throw new Error(`cannot resolve ${relativeKeyPath}`);
  },
};

const noopDetector: Detector = {
  name: "noop",
  findProjectFiles: () => [],
  findGlobalFiles: () => [],
  resolveLocalPath: (relativeKeyPath: string) => {
    throw new Error(`cannot resolve ${relativeKeyPath}`);
  },
};

function fakeBackend(
  cloneDir: string,
  overrides: Partial<GitRemoteBackend> = {},
): GitRemoteBackend {
  return {
    initRemote: async () => {},
    ensureLocalClone: async () => cloneDir,
    push: async () => {},
    pull: async (): Promise<PullResult> => ({ fastForward: true, changedFiles: [], skippedUnsafe: [] }),
    checkVisibility: async () => "private",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("runPush --all exit code", () => {
  it("exits non-zero when a registered project's push fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPush(
        {
          backend: fakeBackend(cloneDir, {
            push: async () => {
              throw new Error("push rejected: local clone is not fast-forward with origin/main");
            },
          }),
          detectors: [noopDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("warns but does NOT fail the run when a registry entry is stale (its directory is gone)", async () => {
    // Spec, "Eskimiş girdi": a stale registry entry is skipped with a warning and
    // the run continues — "tek bir eskimiş girdi tüm `--all` çalıştırmasını
    // başarısız kılmaz". It is housekeeping, not a sync failure.
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const goneDir = mkdtempSync(join(tmpdir(), "memsync-gone-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", goneDir);
      rmSync(goneDir, { recursive: true, force: true });

      await runPush(
        {
          backend: fakeBackend(cloneDir),
          detectors: [noopDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir: home, all: true },
      );

      expect(process.exitCode).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping acme/widgets"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("leaves the exit code untouched when every registered project pushes cleanly", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPush(
        {
          backend: fakeBackend(cloneDir),
          detectors: [noopDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("runPush gist visibility warning", () => {
  it("warns on the single-project path when the backend reports the gist is public", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runPush(
        {
          backend: fakeBackend(cloneDir, { checkVisibility: async () => "public" }),
          detectors: [noopDetector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
        },
        { projectDir },
      );

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the backing gist is public"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not warn on the single-project path when the backend reports the gist is private", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runPush(
        {
          backend: fakeBackend(cloneDir, { checkVisibility: async () => "private" }),
          detectors: [noopDetector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
        },
        { projectDir },
      );

      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not warn on the single-project path when the backend reports unknown visibility", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runPush(
        {
          backend: fakeBackend(cloneDir, { checkVisibility: async () => "unknown" }),
          detectors: [noopDetector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
        },
        { projectDir },
      );

      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("warns on the --all path for a registered project whose gist is public", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPush(
        {
          backend: fakeBackend(cloneDir, { checkVisibility: async () => "public" }),
          detectors: [noopDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the backing gist is public"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not warn on the --all path when every registered project's gist is private", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPush(
        {
          backend: fakeBackend(cloneDir, { checkVisibility: async () => "private" }),
          detectors: [noopDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("runPull --all exit code", () => {
  it("exits non-zero when a registered project has a skipped unsafe path", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      writeFileSync(join(cloneDir, "global%2FMEMORY.md"), "global memory");
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPull(
        {
          backend: fakeBackend(cloneDir),
          detectors: [unresolvableDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a registered project's clone is not fast-forward", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPull(
        {
          backend: fakeBackend(cloneDir, {
            pull: async () => ({ fastForward: false, changedFiles: [], skippedUnsafe: [] }),
          }),
          detectors: [unresolvableDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("warns but does NOT fail the run when a registry entry is stale (its directory is gone)", async () => {
    // Same spec rule as the push side: a stale entry is skipped with a warning and
    // must not make the whole --all run report failure.
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const goneDir = mkdtempSync(join(tmpdir(), "memsync-gone-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", goneDir);
      rmSync(goneDir, { recursive: true, force: true });

      await runPull(
        {
          backend: fakeBackend(cloneDir),
          detectors: [unresolvableDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir: home, all: true },
      );

      expect(process.exitCode).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping acme/widgets"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("leaves the exit code untouched when every registered project pulls cleanly", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", projectDir);

      await runPull(
        {
          backend: fakeBackend(cloneDir),
          detectors: [unresolvableDetector],
          homeDir: home,
          registryPath,
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, all: true },
      );

      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
