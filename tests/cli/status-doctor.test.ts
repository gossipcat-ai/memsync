import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../../src/cli/status.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { buildProgram } from "../../src/cli/program.js";
import { upsertRegistryEntry } from "../../src/registry.js";
import { ALL_DETECTORS } from "../../src/detectors/index.js";
import { GistBackend } from "../../src/backends/gist-backend.js";
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
    expect(report.toolReport).toEqual([{ tool: "fake", relativeKeyPath: "claude/MEMORY.md", exists: false, scope: "project" }]);
    expect(report.visibility).toBe("private");
  });

  it("also reports global files, tagged with scope: \"global\", alongside project files", async () => {
    const detector: Detector = {
      name: "fake",
      findProjectFiles: () => [{ absolutePath: "/x/MEMORY.md", relativeKeyPath: "claude/MEMORY.md", exists: false }],
      findGlobalFiles: () => [{ absolutePath: "/home/CLAUDE.md", relativeKeyPath: "claude/CLAUDE.md", exists: true }],
      resolveLocalPath: () => "/x/MEMORY.md",
    };
    const report = await runDoctor({ detectors: [detector], homeDir: "/home", projectDir: "/x", backend: fakeBackend });
    expect(report.toolReport).toEqual([
      { tool: "fake", relativeKeyPath: "claude/MEMORY.md", exists: false, scope: "project" },
      { tool: "fake", relativeKeyPath: "claude/CLAUDE.md", exists: true, scope: "global" },
    ]);
  });
});

describe("CLI --json output", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("`status --json` prints valid JSON on stdout matching runStatus's raw return value", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "memsync-home-"));
    process.env.HOME = tempHome;
    const registryPath = join(tempHome, ".memsync", "registry.json");
    upsertRegistryEntry(registryPath, "acme/widgets", "/x", () => "t1");
    const expected = runStatus(registryPath);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await buildProgram().parseAsync(["node", "memsync", "status", "--json"]);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual(expected);
  });

  it("`status` (no --json) still prints human-readable tab-separated lines, unchanged", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "memsync-home-"));
    process.env.HOME = tempHome;
    const registryPath = join(tempHome, ".memsync", "registry.json");
    upsertRegistryEntry(registryPath, "acme/widgets", "/x", () => "t1");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await buildProgram().parseAsync(["node", "memsync", "status"]);

    expect(logs).toEqual(["acme/widgets\t/x\tlast synced t1"]);
  });

  it("`doctor --json` prints valid JSON on stdout matching runDoctor's raw return value", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "memsync-home-"));
    process.env.HOME = tempHome;
    const expected = await runDoctor({
      detectors: ALL_DETECTORS,
      homeDir: tempHome,
      projectDir: process.cwd(),
      backend: new GistBackend(join(tempHome, ".memsync", "repo")),
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await buildProgram().parseAsync(["node", "memsync", "doctor", "--json"]);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual(expected);
  });

  it("`doctor` (no --json) still prints human-readable lines including scope, unchanged in shape", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "memsync-home-"));
    process.env.HOME = tempHome;

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await buildProgram().parseAsync(["node", "memsync", "doctor"]);

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1]).toBe("remote visibility: unknown");
    for (const line of logs.slice(0, -1)) {
      expect(line).toMatch(/^.+ \[(project|global)\]: .+ — (found|expected, not found)$/);
    }
  });
});
