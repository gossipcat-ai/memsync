import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/init.js";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";
import { GistBackend } from "../../src/backends/gist-backend.js";
import { loadMachineConfig } from "../../src/machine-config.js";

describe("runInit", () => {
  it("creates a new remote, writes machine-config.json, and creates a .memsyncignore template", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const clonePath = join(home, "repo");
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    try {
      await runInit({
        homeDir: home,
        clonePath,
        projectDir,
        backendFactory: (cp) => new LocalBareGitBackend(bareDir, cp),
      });

      expect(existsSync(clonePath)).toBe(true);
      expect(existsSync(join(projectDir, ".memsyncignore"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("with an existingId, attaches instead of creating (verified via the backend's initRemote receiving it)", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const clonePath = join(home, "repo");
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    try {
      let receivedId: string | undefined;
      class SpyBackend extends LocalBareGitBackend {
        async initRemote(existingId?: string) {
          receivedId = existingId;
          return super.initRemote(existingId);
        }
      }
      await runInit({
        homeDir: home,
        clonePath,
        projectDir,
        existingGistId: "abc123",
        backendFactory: (cp) => new SpyBackend(bareDir, cp),
      });
      expect(receivedId).toBe("abc123");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("with a GistBackend, persists the newly created gist id to machine-config.json and returns it", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const clonePath = join(home, "repo");
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    // Pre-create the clone directory so `ensureLocalClone`'s existsSync check
    // short-circuits and skips the real `git clone` call entirely.
    mkdirSync(clonePath, { recursive: true });
    try {
      const exec = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
          return { stdout: "https://gist.github.com/user/abc123\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const gistBackend = new GistBackend(clonePath, exec);

      const result = await runInit({
        homeDir: home,
        clonePath,
        projectDir,
        backendFactory: () => gistBackend,
      });

      expect(loadMachineConfig(join(home, "config.json")).gistId).toBe("abc123");
      expect(result.gistId).toBe("abc123");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
