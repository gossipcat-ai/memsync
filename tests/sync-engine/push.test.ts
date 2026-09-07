import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";
import { pushProject } from "../../src/sync-engine/push.js";
import { cursorDetector } from "../../src/detectors/cursor.js";
import type { Detector, FileRef } from "../../src/types.js";

function fakeDetector(projectFiles: FileRef[], globalFiles: FileRef[] = []): Detector {
  return {
    name: "fake",
    findProjectFiles: () => projectFiles,
    findGlobalFiles: () => globalFiles,
    resolveLocalPath: (relativeKeyPath: string) => {
      throw new Error(`fake detector cannot resolve local path for ${relativeKeyPath}`);
    },
  };
}

describe("pushProject", () => {
  it("copies detected files into the clone under projectKey and pushes them to the remote", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      writeFileSync(join(projectDir, "MEMORY.md"), "remember this");
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const detector = fakeDetector([
        { absolutePath: join(projectDir, "MEMORY.md"), relativeKeyPath: "claude/MEMORY.md", exists: true },
      ]);

      const result = await pushProject(
        {
          backend,
          detectors: [detector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
          hostname: "test-host",
        },
        projectDir,
        "acme/widgets",
      );

      expect(result.pushedFiles).toEqual(["claude/MEMORY.md"]);

      const verifyClone = join(mkdtempSync(join(tmpdir(), "memsync-verify-")), "repo");
      const verifyBackend = new LocalBareGitBackend(bareDir, verifyClone);
      await verifyBackend.ensureLocalClone();
      expect(readFileSync(join(verifyClone, "acme%2Fwidgets%2Fclaude%2FMEMORY.md"), "utf8")).toBe("remember this");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("excludes files matching .memsyncignore patterns", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      writeFileSync(join(projectDir, "apikey.md"), "sk-should-not-sync");
      writeFileSync(join(projectDir, ".memsyncignore"), "*apikey*\n");
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();
      const detector = fakeDetector([
        { absolutePath: join(projectDir, "apikey.md"), relativeKeyPath: "claude/apikey.md", exists: true },
      ]);

      const result = await pushProject(
        { backend, detectors: [detector], homeDir: home, registryPath: join(home, "registry.json"), lockPath: join(home, "repo.lock"), hostname: "h" },
        projectDir,
        "acme/widgets",
      );

      expect(result.pushedFiles).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("refuses to push a detector file whose absolutePath is a symlink, so a planted link cannot exfiltrate a $HOME credential into the gist", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    // Entirely outside every allowed containment root.
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const verifyClone = join(mkdtempSync(join(tmpdir(), "memsync-verify-")), "repo");
    try {
      // The credential lives UNDER $HOME, and $HOME is one of pushProject's allowed
      // containment roots — so realpath-based containment ALONE happily accepts this
      // link and copies the token's bytes into a gist that is readable by anyone
      // holding its URL, forever. Only refusing symlinks outright stops it.
      mkdirSync(join(home, ".config", "gh"), { recursive: true });
      writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_SUPERSECRETTOKEN\n");
      symlinkSync(join(home, ".config", "gh", "hosts.yml"), join(projectDir, ".cursorrules"));

      // Second vector from the same report: a link pointing outside all roots.
      writeFileSync(join(outside, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
      mkdirSync(join(projectDir, ".cursor", "rules"), { recursive: true });
      symlinkSync(join(outside, "id_rsa"), join(projectDir, ".cursor", "rules", "notes.md"));

      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const detector = fakeDetector([
        { absolutePath: join(projectDir, ".cursorrules"), relativeKeyPath: "cursor/.cursorrules", exists: true },
        { absolutePath: join(projectDir, ".cursor", "rules", "notes.md"), relativeKeyPath: "cursor/rules/notes.md", exists: true },
      ]);

      const result = await pushProject(
        { backend, detectors: [detector], homeDir: home, registryPath: join(home, "registry.json"), lockPath: join(home, "repo.lock"), hostname: "h" },
        projectDir,
        "acme/widgets",
      );

      expect(result.pushedFiles).toEqual([]);

      // Nothing symlink-derived may have reached the remote at all.
      await new LocalBareGitBackend(bareDir, verifyClone).ensureLocalClone();
      const committed = readdirSync(verifyClone).filter((name) => name !== ".git");
      expect(committed).not.toContain("acme%2Fwidgets%2Fcursor%2F.cursorrules");
      expect(committed).not.toContain("acme%2Fwidgets%2Fcursor%2Frules%2Fnotes.md");
      for (const name of committed) {
        const body = readFileSync(join(verifyClone, name), "utf8");
        expect(body).not.toContain("gho_SUPERSECRETTOKEN");
        expect(body).not.toContain("BEGIN OPENSSH PRIVATE KEY");
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(verifyClone, { recursive: true, force: true });
    }
  });

  it("refuses to push files reached through a symlinked intermediate DIRECTORY, so a planted .cursor/rules link cannot exfiltrate $HOME secrets", async () => {
    // The leaf-only lstat check is not enough. If `.cursor/rules` is ITSELF a symlink
    // (a hostile repo materializes one on `git clone`), readdirSync transparently
    // follows it, every enumerated entry becomes a FileRef whose lexical absolutePath
    // still looks like it lives in the project, and lstat on that path resolves the
    // link before reaching the final component — so the leaf reports as an ordinary
    // regular file. It is one; just not where the path suggests. realpath containment
    // then ACCEPTS it, because its real location is under $HOME — an intentionally
    // allowed root (Claude Code's project memory legitimately lives deep under $HOME).
    // Only walking the intermediate segments catches this.
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    // Project lives under $HOME (the common real-world layout), so the file IS
    // lexically contained by an allowed root — containment alone cannot reject it.
    const projectDir = join(home, "work", "widgets");
    mkdirSync(projectDir, { recursive: true });
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    const verifyClone = join(mkdtempSync(join(tmpdir(), "memsync-verify-")), "repo");
    try {
      const secretsDir = join(home, ".ssh");
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(join(secretsDir, "deploy-notes.md"), "passphrase: PRIVATE-KEY-b4dc0ffee\n");

      mkdirSync(join(projectDir, ".cursor"), { recursive: true });
      symlinkSync(secretsDir, join(projectDir, ".cursor", "rules"));

      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const result = await pushProject(
        {
          backend,
          detectors: [cursorDetector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
          hostname: "h",
        },
        projectDir,
        "acme/widgets",
      );

      expect(result.pushedFiles).toEqual([]);

      await new LocalBareGitBackend(bareDir, verifyClone).ensureLocalClone();
      const committed = readdirSync(verifyClone).filter((name) => name !== ".git");
      expect(committed).not.toContain("acme%2Fwidgets%2Fcursor%2Frules%2Fdeploy-notes.md");
      for (const name of committed) {
        expect(readFileSync(join(verifyClone, name), "utf8")).not.toContain("PRIVATE-KEY-b4dc0ffee");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      rmSync(verifyClone, { recursive: true, force: true });
    }
  });

  it("still pushes ordinary nested project files reached through zero symlinks, including under a tmpdir-rooted project", async () => {
    // Guards against over-rejection: os.tmpdir() on macOS returns a path under /var,
    // which is itself an OS-level symlink to /private/var. A naive
    // `realpathSync(p) === p` check would reject every legitimate file in this
    // project's own test fixtures. The segment walk must start AT the allowed root
    // and never re-examine how the root itself is reached.
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      writeFileSync(join(projectDir, ".cursorrules"), "be concise");
      mkdirSync(join(projectDir, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(projectDir, ".cursor", "rules", "style.md"), "use tabs");

      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();

      const result = await pushProject(
        {
          backend,
          detectors: [cursorDetector],
          homeDir: home,
          registryPath: join(home, "registry.json"),
          lockPath: join(home, "repo.lock"),
          hostname: "h",
        },
        projectDir,
        "acme/widgets",
      );

      expect(result.pushedFiles.sort()).toEqual(["cursor/.cursorrules", "cursor/rules/style.md"]);
      expect(readFileSync(join(cloneDir, "acme%2Fwidgets%2Fcursor%2Frules%2Fstyle.md"), "utf8")).toBe("use tabs");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("registers the project in the local registry after a successful push", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const cloneDir = join(mkdtempSync(join(tmpdir(), "memsync-clone-")), "repo");
    try {
      const backend = new LocalBareGitBackend(bareDir, cloneDir);
      await backend.initRemote();
      await backend.ensureLocalClone();
      const registryPath = join(home, "registry.json");

      await pushProject(
        { backend, detectors: [fakeDetector([])], homeDir: home, registryPath, lockPath: join(home, "repo.lock"), hostname: "h" },
        projectDir,
        "acme/widgets",
      );

      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      expect(registry["acme/widgets"].absolutePath).toBe(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});
