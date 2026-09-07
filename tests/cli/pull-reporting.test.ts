import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPull } from "../../src/cli/pull.js";
import { upsertRegistryEntry } from "../../src/registry.js";
import type { Detector, GitRemoteBackend } from "../../src/types.js";

// Resolves nothing, so every file coming out of the clone lands in
// PullResult.skippedUnsafe — the data runPull must surface.
const unresolvableDetector: Detector = {
  name: "unresolvable",
  findProjectFiles: () => [],
  findGlobalFiles: () => [],
  resolveLocalPath: (relativeKeyPath: string) => {
    throw new Error(`cannot resolve ${relativeKeyPath}`);
  },
};

function fakeBackend(cloneDir: string): GitRemoteBackend {
  return {
    initRemote: async () => {},
    ensureLocalClone: async () => cloneDir,
    push: async () => {},
    pull: async () => ({ fastForward: true, changedFiles: [], skippedUnsafe: [] }),
    checkVisibility: async () => "private",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("runPull skipped-unsafe reporting", () => {
  it("reports each skipped unsafe file and exits non-zero for a single project", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(cloneDir, "global%2FMEMORY.md"), "global memory");

      await runPull(
        {
          backend: fakeBackend(cloneDir),
          detectors: [unresolvableDetector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
        },
        { projectDir, projectKeyOverride: "acme/widgets" },
      );

      const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("MEMORY.md");
      expect(output).toMatch(/skipped unsafe/i);
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports skipped unsafe files per key in the --all loop without aborting it", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "memsync-clone-"));
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

      const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("acme/widgets");
      expect(output).toContain("MEMORY.md");
      expect(output).toMatch(/skipped unsafe/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
