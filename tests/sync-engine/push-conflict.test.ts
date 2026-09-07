import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";
import { pushProject } from "../../src/sync-engine/push.js";
import { acquireLock } from "../../src/lock.js";
import type { Detector, GitRemoteBackend } from "../../src/types.js";

const noopDetector: Detector = {
  name: "noop",
  findProjectFiles: () => [],
  findGlobalFiles: () => [],
  resolveLocalPath: (relativeKeyPath: string) => {
    throw new Error(`noop detector cannot resolve local path for ${relativeKeyPath}`);
  },
};

function commitCount(cloneDir: string): number {
  return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: cloneDir }).toString().trim());
}

function isClean(cloneDir: string): boolean {
  return execFileSync("git", ["status", "--porcelain"], { cwd: cloneDir }).toString().trim().length === 0;
}

/**
 * Reads a logical clone path (e.g. "acme/widgets/meta.json") out of HEAD. The gist
 * layout is flat, so "/" is encoded as "%2F" in the real filename — mirroring
 * clone-writer's encodeFlatName, without importing internals.
 */
function headCommitted(cloneDir: string, logicalPath: string): string {
  const flat = logicalPath.replace(/\//g, "%2F");
  return execFileSync("git", ["show", `HEAD:${flat}`], { cwd: cloneDir }).toString();
}

function revParse(cloneDir: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { cwd: cloneDir }).toString().trim();
}

describe("pushProject conflict handling", () => {
  it("fast-forwards and succeeds when the local clone is merely behind the remote (no divergence)", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    const projectDirA = mkdtempSync(join(tmpdir(), "memsync-proja-"));
    const lockPath = join(home, "repo.lock");
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();

      writeFileSync(join(cloneADir, "seed.txt"), "seed");
      await backendA.push();

      // Another machine pushes something unrelated: clone A is now strictly
      // BEHIND origin, not diverged from it.
      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();
      writeFileSync(join(cloneBDir, "other.txt"), "from another machine");
      await backendB.push();

      // push() must fetch + fast-forward BEFORE committing anything locally, so
      // a merely-behind clone transparently catches up instead of erroring.
      await expect(
        pushProject(
          { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath },
          projectDirA,
          "acme/widgets",
        ),
      ).resolves.toBeDefined();

      expect(isClean(cloneADir)).toBe(true);
      expect(() => acquireLock(lockPath)()).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
      rmSync(projectDirA, { recursive: true, force: true });
    }
  });

  it("succeeds when another machine already pushed the SAME project key (pre-sync catches the clone up before writing)", async () => {
    // pushProject always rewrites <projectKey>/meta.json, so after another machine
    // pushes the same key, clone A's next push has local changes to the exact file the
    // remote also changed — `git merge --ff-only` refuses that outright ("local changes
    // would be overwritten"), and `memsync pull` could not recover it either, since it
    // runs the same --ff-only merge against the same dirty tree. pushProject therefore
    // pre-syncs via backend.pull() while the tree is still clean, BEFORE writing any
    // detector content. Two sequential real pushes of the same project must never
    // conflict: memsync fully regenerates content from live local state, so there is
    // nothing to merge.
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const homeB = mkdtempSync(join(tmpdir(), "memsync-homeb-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    const projectDirA = mkdtempSync(join(tmpdir(), "memsync-proja-"));
    const projectDirB = mkdtempSync(join(tmpdir(), "memsync-projb-"));
    const lockPath = join(home, "repo.lock");
    const lockPathB = join(homeB, "repo.lock");
    const projectKey = "acme/widgets";
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();
      await pushProject(
        { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a" },
        projectDirA,
        projectKey,
      );

      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();
      await pushProject(
        { backend: backendB, detectors: [noopDetector], homeDir: homeB, registryPath: join(homeB, "registry.json"), lockPath: lockPathB, hostname: "machine-b" },
        projectDirB,
        projectKey,
      );

      await expect(
        pushProject(
          { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a2" },
          projectDirA,
          projectKey,
        ),
      ).resolves.toBeDefined();

      // The clone must be left clean and in sync, so a following pull/push works too.
      expect(isClean(cloneADir)).toBe(true);
      await expect(backendA.pull()).resolves.toMatchObject({ fastForward: true });
      expect(() => acquireLock(lockPath)()).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
      rmSync(projectDirA, { recursive: true, force: true });
      rmSync(projectDirB, { recursive: true, force: true });
    }
  });

  it("throws instead of auto-merging when origin moves after the pre-sync (the residual concurrent-push race), without leaving a local commit behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const homeB = mkdtempSync(join(tmpdir(), "memsync-homeb-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    const projectDirA = mkdtempSync(join(tmpdir(), "memsync-proja-"));
    const projectDirB = mkdtempSync(join(tmpdir(), "memsync-projb-"));
    const lockPath = join(home, "repo.lock");
    const lockPathB = join(homeB, "repo.lock");
    const projectKey = "acme/widgets";
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();
      await pushProject(
        { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a" },
        projectDirA,
        projectKey,
      );

      // Simulate the residual race that pushProject's pre-sync cannot close: another
      // machine pushes the SAME project key in the window AFTER clone A's pre-sync has
      // already run and its fresh content is on disk, but BEFORE backend.push() gets to
      // fetch. The wrapper below fires exactly in that window (on the push() call), so
      // origin moves underneath a clone whose tree is already dirty on the same
      // meta.json path — the one case where backend.push()'s own --ff-only check must
      // genuinely refuse rather than auto-merge.
      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();

      // Captured inside the race window (after the pre-sync's legitimate
      // fast-forward, before the racing remote push), so the assertion below measures
      // only what the refused push itself did.
      let commitsBefore = -1;
      const racingBackendA: GitRemoteBackend = {
        initRemote: (id) => backendA.initRemote(id),
        ensureLocalClone: () => backendA.ensureLocalClone(),
        pull: () => backendA.pull(),
        checkVisibility: () => backendA.checkVisibility(),
        push: async () => {
          commitsBefore = commitCount(cloneADir);
          await pushProject(
            { backend: backendB, detectors: [noopDetector], homeDir: homeB, registryPath: join(homeB, "registry.json"), lockPath: lockPathB, hostname: "machine-b" },
            projectDirB,
            projectKey,
          );
          await backendA.push();
        },
      };

      await expect(
        pushProject(
          { backend: racingBackendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a2" },
          projectDirA,
          projectKey,
        ),
      ).rejects.toThrow(/not fast-forward/);

      // No local commit may be created by a rejected push — otherwise the clone
      // would be permanently diverged and `memsync pull` (also --ff-only) could
      // never recover it.
      expect(commitsBefore).toBeGreaterThan(0); // the race window actually fired
      expect(commitCount(cloneADir)).toBe(commitsBefore);
      // And nothing may have been auto-merged: machine B's commit must not have
      // landed in clone A's history at all.
      expect(headCommitted(cloneADir, `${projectKey}/meta.json`)).not.toContain("machine-b");

      // lock must have been released so a subsequent call can acquire it
      expect(() => acquireLock(lockPath)()).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
      rmSync(projectDirA, { recursive: true, force: true });
      rmSync(projectDirB, { recursive: true, force: true });
    }
  });

  it("rolls the local commit back when the REMOTE rejects the push, so the clone is not left ahead-and-behind and the next push succeeds unaided", async () => {
    // The narrowest form of the concurrent-push race: another machine's push lands
    // between our own pre-sync/ff-check and our `git push`, so the rejection comes
    // from the remote AFTER we already committed locally. Without a rollback the
    // clone ends up simultaneously ahead of its last known-good state and behind the
    // new remote — `pull` can't fast-forward it and `push`'s pre-sync can't fix it,
    // leaving the user in manual `git` surgery on ~/.memsync/repo forever.
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const homeB = mkdtempSync(join(tmpdir(), "memsync-homeb-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneADir = join(mkdtempSync(join(tmpdir(), "memsync-clonea-")), "repo");
    const cloneBDir = join(mkdtempSync(join(tmpdir(), "memsync-cloneb-")), "repo");
    const projectDirA = mkdtempSync(join(tmpdir(), "memsync-proja-"));
    const projectDirB = mkdtempSync(join(tmpdir(), "memsync-projb-"));
    const lockPath = join(home, "repo.lock");
    const lockPathB = join(homeB, "repo.lock");
    const projectKey = "acme/widgets";
    const hookPath = join(bareDir, "hooks", "pre-receive");
    try {
      const backendA = new LocalBareGitBackend(bareDir, cloneADir);
      await backendA.initRemote();
      await backendA.ensureLocalClone();
      await pushProject(
        { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a" },
        projectDirA,
        projectKey,
      );

      const backendB = new LocalBareGitBackend(bareDir, cloneBDir);
      await backendB.ensureLocalClone();

      // Baseline is read from the REMOTE, not from clone A: "known-good" means
      // "whatever origin holds", and clone A may legitimately be behind it here.
      const remoteHeadBefore = revParse(bareDir, "main");

      // Reject on the receiving side only — this fires strictly AFTER clone A has
      // fetched, fast-forwarded, staged and committed, which is exactly the window
      // no earlier check can cover.
      writeFileSync(hookPath, "#!/bin/sh\necho 'simulated remote rejection' >&2\nexit 1\n");
      chmodSync(hookPath, 0o755);

      await expect(
        pushProject(
          { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a2" },
          projectDirA,
          projectKey,
        ),
      ).rejects.toThrow(/another machine pushed first/);

      rmSync(hookPath, { force: true });

      // (b) the clone is back to a clean, known state that matches origin exactly —
      // no stray commit left ahead of it, no dirty tree, and nothing landed remotely.
      expect(revParse(bareDir, "main")).toBe(remoteHeadBefore);
      expect(revParse(cloneADir, "HEAD")).toBe(remoteHeadBefore);
      expect(revParse(cloneADir, "origin/main")).toBe(remoteHeadBefore);
      expect(isClean(cloneADir)).toBe(true);
      expect(() => acquireLock(lockPath)()).not.toThrow();

      // The competing machine's push (the thing that won the race) now lands, so
      // clone A really is behind origin for the retry.
      await pushProject(
        { backend: backendB, detectors: [noopDetector], homeDir: homeB, registryPath: join(homeB, "registry.json"), lockPath: lockPathB, hostname: "machine-b" },
        projectDirB,
        projectKey,
      );

      // (c) the very next independent push succeeds with zero manual intervention.
      await expect(
        pushProject(
          { backend: backendA, detectors: [noopDetector], homeDir: home, registryPath: join(home, "registry.json"), lockPath, hostname: "machine-a3" },
          projectDirA,
          projectKey,
        ),
      ).resolves.toBeDefined();

      expect(isClean(cloneADir)).toBe(true);
      expect(headCommitted(cloneADir, `${projectKey}/meta.json`)).toContain("machine-a3");
      await expect(backendA.pull()).resolves.toMatchObject({ fastForward: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneADir, { recursive: true, force: true });
      rmSync(cloneBDir, { recursive: true, force: true });
      rmSync(projectDirA, { recursive: true, force: true });
      rmSync(projectDirB, { recursive: true, force: true });
    }
  });
});
