import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";

describe("LocalBareGitBackend", () => {
  it("initRemote + ensureLocalClone gives a working clone directory", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      const clonePath = await backend.ensureLocalClone();
      expect(clonePath).toBe(cloneDir);
      expect(existsSync(join(cloneDir, ".git"))).toBe(true);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("push commits and pushes local changes; a second clone sees them after pull", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();
      writeFileSync(join(cloneADir, "hello.txt"), "hi");
      await backendA.push();

      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();
      const result = await backendB.pull();
      expect(result.fastForward).toBe(true);
      expect(readFileSync(join(cloneBDir, "hello.txt"), "utf8")).toBe("hi");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
    }
  });

  it("push fast-forwards a merely-behind clone before committing, so an unrelated remote change is not a conflict", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();
      writeFileSync(join(cloneADir, "a.txt"), "from A");
      await backendA.push();

      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();
      await backendB.pull();
      writeFileSync(join(cloneBDir, "b.txt"), "from B");
      await backendB.push();

      writeFileSync(join(cloneADir, "c.txt"), "new local content from A, stale clone");
      await expect(backendA.push()).resolves.toBeUndefined();
      // A caught up to B's commit first, then pushed its own on top.
      expect(readFileSync(join(cloneADir, "b.txt"), "utf8")).toBe("from B");
      await backendB.pull();
      expect(readFileSync(join(cloneBDir, "c.txt"), "utf8")).toBe("new local content from A, stale clone");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
    }
  });

  it("push refuses (throws) — and creates no local commit — when fast-forwarding would clobber local changes", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();
      writeFileSync(join(cloneADir, "shared.txt"), "v1");
      await backendA.push();

      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();
      await backendB.pull();
      writeFileSync(join(cloneBDir, "shared.txt"), "from B");
      await backendB.push();

      // A edits the same file the incoming fast-forward would overwrite.
      writeFileSync(join(cloneADir, "shared.txt"), "conflicting edit from A");
      const commitsBefore = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: cloneADir }).toString().trim();
      await expect(backendA.push()).rejects.toThrow(
        "push rejected: local clone is not fast-forward with origin/main",
      );
      // The rejected push must not have committed anything locally, otherwise
      // the clone would be permanently diverged and unrecoverable via pull.
      const commitsAfter = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: cloneADir }).toString().trim();
      expect(commitsAfter).toBe(commitsBefore);
      expect(readFileSync(join(cloneADir, "shared.txt"), "utf8")).toBe("conflicting edit from A");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
    }
  });

  it("push surfaces the real fetch error instead of mislabeling it as a fast-forward conflict", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();
      writeFileSync(join(cloneDir, "x.txt"), "hi");
      // Simulate a real fetch failure (network/permissions/missing remote) by
      // removing the bare repo entirely after the clone succeeded, so `git
      // fetch origin` fails for a reason that has nothing to do with a
      // fast-forward conflict.
      rmSync(bareDir, { recursive: true, force: true });

      let thrown: unknown;
      try {
        await backend.push();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(
        "push rejected: local clone is not fast-forward with origin/main",
      );
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("checkVisibility returns 'private' (local bare repos are never network-exposed)", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      expect(await backend.checkVisibility()).toBe("private");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});
