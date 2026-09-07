import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullProject } from "../../src/sync-engine/pull.js";
import { claudeCodeDetector, encodeClaudeProjectPath } from "../../src/detectors/claude-code.js";
import type { GitRemoteBackend, PullResult } from "../../src/types.js";
import type { SyncEngineDeps } from "../../src/sync-engine/push.js";

/**
 * Gist entries are flat files whose name is the logical path with "/" escaped
 * as "%2F" (see clone-writer.ts's encodeFlatName). Building the clone by hand
 * here lets a test plant an entry under an arbitrary logical prefix — including
 * the cross-scope one a legitimate push would never produce.
 */
function encodeFlatName(logicalPath: string): string {
  return logicalPath.replace(/%/g, "%25").replace(/\//g, "%2F");
}

interface Fixture {
  home: string;
  projectDir: string;
  cloneDir: string;
  deps: SyncEngineDeps;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "memsync-scope-"));
  const home = join(root, "home");
  const projectDir = join(root, "proj");
  const cloneDir = join(root, "clone");
  for (const dir of [home, projectDir, cloneDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const backend: GitRemoteBackend = {
    ensureLocalClone: async () => cloneDir,
    initRemote: async () => {},
    push: async () => {},
    pull: async (): Promise<PullResult> => ({ fastForward: true, changedFiles: [], skippedUnsafe: [] }),
    checkVisibility: async () => "private" as const,
  };
  return {
    home,
    projectDir,
    cloneDir,
    deps: {
      backend,
      detectors: [claudeCodeDetector],
      homeDir: home,
      registryPath: join(root, "registry.json"),
      lockPath: join(root, "repo.lock"),
    },
  };
}

describe("pullProject scope isolation", () => {
  it("refuses to write a project-scoped entry to the real global CLAUDE.md", async () => {
    const { home, projectDir, cloneDir, deps } = makeFixture();
    // A PROJECT-scoped gist entry (prefix "<projectKey>/") whose relativeKeyPath
    // collides with the GLOBAL file's key. Nothing about the string itself is
    // traversal-unsafe, so assertSafeKeyPath cannot catch this — only the
    // detector's scope check can.
    writeFileSync(join(cloneDir, encodeFlatName("pk/claude/CLAUDE.md")), "EVIL GLOBAL INSTRUCTIONS");
    writeFileSync(join(home, "CLAUDE.md"), "original global");

    const result = await pullProject(deps, projectDir, "pk");

    expect(result.skippedUnsafe).toContain("claude/CLAUDE.md");
    expect(result.changedFiles).not.toContain("claude/CLAUDE.md");
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("original global");
    // Nothing was written, so no backup should have been taken either.
    expect(existsSync(join(home, "CLAUDE.md.bak"))).toBe(false);
  });

  it("still restores a legitimately global-scoped CLAUDE.md", async () => {
    const { home, projectDir, cloneDir, deps } = makeFixture();
    writeFileSync(join(cloneDir, encodeFlatName("global/claude/CLAUDE.md")), "synced global");

    const result = await pullProject(deps, projectDir, "pk");

    expect(result.skippedUnsafe).toEqual([]);
    expect(result.changedFiles).toContain("claude/CLAUDE.md");
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("synced global");
  });

  it("still restores a legitimately project-scoped MEMORY.md", async () => {
    const { home, projectDir, cloneDir, deps } = makeFixture();
    writeFileSync(join(cloneDir, encodeFlatName("pk/claude/MEMORY.md")), "synced project memory");

    const result = await pullProject(deps, projectDir, "pk");

    expect(result.skippedUnsafe).toEqual([]);
    expect(result.changedFiles).toContain("claude/MEMORY.md");
    const encoded = encodeClaudeProjectPath(projectDir);
    expect(readFileSync(join(home, ".claude", "projects", encoded, "memory", "MEMORY.md"), "utf8")).toBe(
      "synced project memory",
    );
  });

  it("refuses to write a global-scoped entry to a project-scoped path", async () => {
    const { home, projectDir, cloneDir, deps } = makeFixture();
    // The mirror image of the first case: a GLOBAL-prefixed entry carrying a
    // relativeKeyPath that only makes sense per-project.
    writeFileSync(join(cloneDir, encodeFlatName("global/claude/MEMORY.md")), "EVIL PROJECT MEMORY");

    const result = await pullProject(deps, projectDir, "pk");

    expect(result.skippedUnsafe).toContain("claude/MEMORY.md");
    expect(result.changedFiles).not.toContain("claude/MEMORY.md");
    const encoded = encodeClaudeProjectPath(projectDir);
    expect(existsSync(join(home, ".claude", "projects", encoded, "memory", "MEMORY.md"))).toBe(false);
  });
});
