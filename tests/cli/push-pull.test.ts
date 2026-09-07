import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBareGitBackend } from "../../src/backends/local-bare-backend.js";
import { claudeCodeDetector, encodeClaudeProjectPath } from "../../src/detectors/claude-code.js";
import { runPush } from "../../src/cli/push.js";
import { runPull } from "../../src/cli/pull.js";

describe("runPush / runPull", () => {
  it("--project-key lets push/pull agree on a key independent of cwd (non-git-remote cross-machine restore)", async () => {
    const sourceProjectDir = mkdtempSync(join(tmpdir(), "memsync-srcproj-"));
    const sourceHome = mkdtempSync(join(tmpdir(), "memsync-srchome-"));
    const bareDir = mkdtempSync(join(tmpdir(), "memsync-bare-"));
    const pushCloneDir = join(sourceHome, "repo");
    const targetProjectDir = mkdtempSync(join(tmpdir(), "memsync-tgtproj-"));
    const targetHome = mkdtempSync(join(tmpdir(), "memsync-tgthome-"));
    const pullCloneDir = join(targetHome, "repo");
    const explicitKey = "my-explicit-key";
    try {
      const srcEncoded = encodeClaudeProjectPath(sourceProjectDir);
      mkdirSync(join(sourceHome, ".claude", "projects", srcEncoded, "memory"), { recursive: true });
      writeFileSync(join(sourceHome, ".claude", "projects", srcEncoded, "memory", "MEMORY.md"), "cli round trip");

      const pushBackend = new LocalBareGitBackend(bareDir, pushCloneDir);
      await pushBackend.initRemote();
      await pushBackend.ensureLocalClone();
      await runPush(
        { backend: pushBackend, detectors: [claudeCodeDetector], homeDir: sourceHome, registryPath: join(sourceHome, "registry.json"), lockPath: join(sourceHome, "repo.lock") },
        { projectDir: sourceProjectDir, projectKeyOverride: explicitKey },
      );

      const pullBackend = new LocalBareGitBackend(bareDir, pullCloneDir);
      await pullBackend.ensureLocalClone();
      await runPull(
        { backend: pullBackend, detectors: [claudeCodeDetector], homeDir: targetHome, registryPath: join(targetHome, "registry.json"), lockPath: join(targetHome, "repo.lock") },
        { projectDir: targetProjectDir, projectKeyOverride: explicitKey },
      );

      const restoredPath = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(targetProjectDir), "memory", "MEMORY.md");
      expect(readFileSync(restoredPath, "utf8")).toBe("cli round trip");
    } finally {
      rmSync(sourceProjectDir, { recursive: true, force: true });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(targetProjectDir, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
    }
  });
});
