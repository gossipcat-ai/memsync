import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../../src/cli/status.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { upsertRegistryEntry } from "../../src/registry.js";
import type { Detector, GitRemoteBackend } from "../../src/types.js";

describe("runStatus", () => {
  it("lists every registered project", () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "acme/widgets", "/x", () => "t1");
      const rows = runStatus(registryPath);
      expect(rows).toEqual([{ projectKey: "acme/widgets", absolutePath: "/x", lastSyncedAt: "t1" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const fakeBackend: GitRemoteBackend = {
  ensureLocalClone: async () => "/unused",
  initRemote: async () => {},
  push: async () => {},
  pull: async () => ({ fastForward: true, changedFiles: [], skippedUnsafe: [] }),
  checkVisibility: async () => "private",
};

describe("runDoctor", () => {
  it("reports each detector's findings and the remote's visibility", async () => {
    const detector: Detector = {
      name: "fake",
      findProjectFiles: () => [{ absolutePath: "/x/MEMORY.md", relativeKeyPath: "claude/MEMORY.md", exists: false }],
      findGlobalFiles: () => [],
      resolveLocalPath: () => "/x/MEMORY.md",
    };
    const report = await runDoctor({ detectors: [detector], homeDir: "/home", projectDir: "/x", backend: fakeBackend });
    expect(report.toolReport).toEqual([{ tool: "fake", relativeKeyPath: "claude/MEMORY.md", exists: false }]);
    expect(report.visibility).toBe("private");
  });
});
