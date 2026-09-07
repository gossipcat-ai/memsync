import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";
import { pushAllRegistered } from "../../src/sync-engine/push.js";
import { pullAllRegistered } from "../../src/sync-engine/pull.js";
import { upsertRegistryEntry } from "../../src/registry.js";
import type { Detector } from "../../src/types.js";

const noopDetector: Detector = {
  name: "noop",
  findProjectFiles: () => [],
  findGlobalFiles: () => [],
  resolveLocalPath: () => {
    throw new Error("unused");
  },
};

describe("pushAllRegistered", () => {
  it("skips a registry entry whose absolutePath no longer exists, and continues with the rest", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const goodProjectDir = mkdtempSync(join(tmpdir(), "memsync-good-"));
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "gone/project", "/does/not/exist", () => "t");
      upsertRegistryEntry(registryPath, "good/project", goodProjectDir, () => "t");

      const results = await pushAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      expect((results.get("gone/project") as any).skipped).toBe(true);
      expect((results.get("good/project") as any).skipped).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(goodProjectDir, { recursive: true, force: true });
    }
  });

  it("skips a registry entry whose absolutePath resolves to a file, not a directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const notADir = join(mkdtempSync(join(tmpdir(), "memsync-notadir-")), "file.txt");
    writeFileSync(notADir, "not a directory");
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "file/project", notADir, () => "t");

      const results = await pushAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      const result = results.get("file/project") as any;
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("registry path is not a directory");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(notADir, { recursive: true, force: true });
    }
  });

  it("does not trust a registry entry whose registered directory has been swapped for a symlink to an untrusted location", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const swappedParent = mkdtempSync(join(tmpdir(), "memsync-swapparent-"));
    const untrusted = mkdtempSync(join(tmpdir(), "memsync-untrusted-"));
    const swappedPath = join(swappedParent, "project");
    // Registry points at swappedPath, but it is actually a symlink to an
    // unrelated directory -- realpathSync must resolve this before it is
    // ever trusted as a push/pull containment anchor.
    symlinkSync(untrusted, swappedPath);
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "swapped/project", swappedPath, () => "t");

      const results = await pushAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      // The symlink target is itself a real, existing directory, so this is not
      // expected to be skipped -- but it must be pushed using the *resolved*
      // (realpathSync'd) path, not the raw registry string, so that downstream
      // containment checks anchor on the real location.
      const result = results.get("swapped/project") as any;
      expect(result.skipped).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(swappedParent, { recursive: true, force: true });
      rmSync(untrusted, { recursive: true, force: true });
    }
  });

  it("isolates a per-project failure: one project throwing does not block or lose another project's result", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const goodProjectDir = mkdtempSync(join(tmpdir(), "memsync-good-"));
    const badProjectDir = mkdtempSync(join(tmpdir(), "memsync-bad-"));
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      // An unsafe projectKey (a real, pre-existing error condition: assertSafeKeyPath
      // rejects any key containing a ".." segment) makes pushProject throw deep inside
      // writeProjectFiles/updateIndexJson, well after pushAllRegistered's own realpath/
      // isDirectory pre-checks have already passed both entries.
      upsertRegistryEntry(registryPath, "../bad-project", badProjectDir, () => "t");
      upsertRegistryEntry(registryPath, "good/project", goodProjectDir, () => "t");

      const results = await pushAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      const badResult = results.get("../bad-project") as any;
      expect(badResult.failed).toBe(true);
      expect(typeof badResult.error).toBe("string");

      const goodResult = results.get("good/project") as any;
      expect(goodResult.failed).toBeUndefined();
      expect(goodResult.skipped).toBeUndefined();
      expect(goodResult.pushedFiles).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(goodProjectDir, { recursive: true, force: true });
      rmSync(badProjectDir, { recursive: true, force: true });
    }
  });
});

describe("pullAllRegistered", () => {
  it("skips a registry entry whose absolutePath no longer exists, and continues with the rest", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const goodProjectDir = mkdtempSync(join(tmpdir(), "memsync-good-"));
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "gone/project", "/does/not/exist", () => "t");
      upsertRegistryEntry(registryPath, "good/project", goodProjectDir, () => "t");

      const results = await pullAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      expect((results.get("gone/project") as any).skipped).toBe(true);
      expect((results.get("good/project") as any).skipped).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(goodProjectDir, { recursive: true, force: true });
    }
  });

  it("skips a registry entry whose absolutePath resolves to a file, not a directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const notADir = join(mkdtempSync(join(tmpdir(), "memsync-notadir-")), "file.txt");
    writeFileSync(notADir, "not a directory");
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      upsertRegistryEntry(registryPath, "file/project", notADir, () => "t");

      const results = await pullAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      const result = results.get("file/project") as any;
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("registry path is not a directory");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(notADir, { recursive: true, force: true });
    }
  });

  it("isolates a per-project failure: one project throwing does not block or lose another project's result", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const goodProjectDir = mkdtempSync(join(tmpdir(), "memsync-good-"));
    const badProjectDir = mkdtempSync(join(tmpdir(), "memsync-bad-"));
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const registryPath = join(home, "registry.json");
      // An unsafe projectKey (a real, pre-existing error condition: assertSafeKeyPath
      // rejects any key containing a ".." segment) makes pullProject throw deep inside
      // readProjectFilesFromClone, well after pullAllRegistered's own realpath/
      // isDirectory pre-checks have already passed both entries.
      upsertRegistryEntry(registryPath, "../bad-project", badProjectDir, () => "t");
      upsertRegistryEntry(registryPath, "good/project", goodProjectDir, () => "t");

      const results = await pullAllRegistered({
        backend,
        detectors: [noopDetector],
        homeDir: home,
        registryPath,
        lockPath: join(home, "repo.lock"),
      });

      const badResult = results.get("../bad-project") as any;
      expect(badResult.failed).toBe(true);
      expect(typeof badResult.error).toBe("string");

      const goodResult = results.get("good/project") as any;
      expect(goodResult.failed).toBeUndefined();
      expect(goodResult.skipped).toBeUndefined();
      expect(goodResult.fastForward).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(goodProjectDir, { recursive: true, force: true });
      rmSync(badProjectDir, { recursive: true, force: true });
    }
  });
});
