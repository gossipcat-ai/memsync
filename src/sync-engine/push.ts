import { hostname as osHostname } from "node:os";
import { lstatSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import type { Detector, FileRef, GitRemoteBackend } from "../types.js";
import { resolveSafeAbsolutePathNoSymlinksAnyRoot } from "../path-safety.js";
import { loadIgnorePatterns, filterIgnored, scanContentForSecretMatches } from "../ignore.js";
import { upsertRegistryEntry, loadRegistry } from "../registry.js";
import { acquireLock } from "../lock.js";
import { writeProjectFiles, writeGlobalFiles, updateIndexJson, updateMetaJson } from "./clone-writer.js";

export interface SyncEngineDeps {
  backend: GitRemoteBackend;
  detectors: Detector[];
  homeDir: string;
  registryPath: string;
  lockPath: string;
  hostname?: string;
}

// A detector's project-scoped file is not guaranteed to live under projectDir specifically
// (Claude Code's project memory lives under homeDir/.claude/projects/<encoded>/memory/, while
// Cursor's .cursorrules lives under projectDir) — so both roots are always allowed, for both
// project and global files. The boundary being enforced is "somewhere under $HOME or the
// project tree", not "exactly the root this call happened to pass."
function safeExistingFiles(files: FileRef[], allowedRoots: string[]): FileRef[] {
  return files.filter((f) => {
    if (!f.exists) return false;
    // A symlink must be REFUSED here, never resolved. Containment alone does not
    // help: $HOME is itself an allowed root, so a link planted in a project dir
    // (e.g. `.cursorrules` -> `~/.config/gh/hosts.yml`) resolves to an *allowed*
    // path and clone-writer's copyFileSync then copies the TARGET's bytes — a real
    // OAuth token, an SSH key — into a gist that anyone holding the URL can read,
    // with permanent history. This is the only path in memsync that publishes
    // externally, and it was the last one still resolving rather than refusing:
    // clone-writer.ts's readAllUnder and pull.ts's destination gate already refuse
    // symlinks outright, and this matches them.
    //
    // f.exists came from existsSync, which FOLLOWS symlinks and therefore says
    // nothing about symlink-ness — lstatSync is checked independently.
    let stat: Stats;
    try {
      stat = lstatSync(f.absolutePath);
    } catch {
      return false; // vanished between detection and now — nothing to push
    }
    if (stat.isSymbolicLink()) return false;
    // Keep a file only if SOME allowed root both contains it (realpath) and reaches it
    // through zero symlinked segments. The lstat above already refuses a symlink AT the
    // leaf, which is the one case the shared walk deliberately leaves to its callers.
    return resolveSafeAbsolutePathNoSymlinksAnyRoot(f.absolutePath, allowedRoots) !== null;
  });
}

export async function pushProject(
  deps: SyncEngineDeps,
  projectDir: string,
  projectKey: string,
): Promise<{ pushedFiles: string[]; contentWarnings: string[] }> {
  const release = acquireLock(deps.lockPath);
  try {
    const cloneDir = await deps.backend.ensureLocalClone();

    // Catch the local clone up to origin BEFORE writing any detector content, while the
    // working tree is still clean. Without this, every push after another machine has
    // pushed the same projectKey deadlocks: pushProject always rewrites
    // <projectKey>/meta.json, so by the time backend.push() runs its own fetch +
    // `merge --ff-only`, the tree is dirty on the exact file the remote also changed and
    // git refuses ("local changes would be overwritten") — and the "run `memsync pull`
    // first" remediation cannot help, because pull performs the identical --ff-only merge
    // against the same dirty tree.
    //
    // backend.pull() is a pure fetch + ff-only merge of the local clone; it does not
    // touch real project files (that is pullProject's separate job), so calling it here
    // is a no-op when already in sync and a clean catch-up when merely behind.
    //
    // This does not close the residual case where a genuinely CONCURRENT push lands on
    // origin between this pre-sync and backend.push()'s own check moments later — that
    // needs a server-side atomic operation and is out of reach for a local-only fix. In
    // that narrow window backend.push() still refuses rather than auto-merging.
    const preSync = await deps.backend.pull();
    if (!preSync.fastForward) {
      throw new Error(
        "push aborted: local clone has unresolved local changes that don't match the remote — this should not normally happen; if it persists, manually inspect ~/.memsync/repo",
      );
    }

    const allowedRoots = [projectDir, deps.homeDir];
    const activeTools: string[] = [];
    let projectFiles: FileRef[] = [];
    let globalFiles: FileRef[] = [];
    for (const detector of deps.detectors) {
      const pf = safeExistingFiles(detector.findProjectFiles(projectDir, deps.homeDir), allowedRoots);
      const gf = safeExistingFiles(detector.findGlobalFiles(deps.homeDir), allowedRoots);
      if (pf.length > 0 || gf.length > 0) activeTools.push(detector.name);
      projectFiles = projectFiles.concat(pf);
      globalFiles = globalFiles.concat(gf);
    }

    const patterns = loadIgnorePatterns(projectDir, deps.homeDir);
    projectFiles = filterIgnored(projectFiles, patterns);
    globalFiles = filterIgnored(globalFiles, patterns);

    const contentWarnings = [
      ...scanContentForSecretMatches(projectFiles, patterns),
      ...scanContentForSecretMatches(globalFiles, patterns),
    ];

    writeProjectFiles(cloneDir, projectKey, projectFiles);
    writeGlobalFiles(cloneDir, globalFiles);
    updateIndexJson(cloneDir, projectKey);
    updateMetaJson(cloneDir, projectKey, activeTools, deps.hostname ?? osHostname());

    await deps.backend.push();

    upsertRegistryEntry(deps.registryPath, projectKey, projectDir);

    return {
      pushedFiles: [...projectFiles, ...globalFiles].map((f) => f.relativeKeyPath),
      contentWarnings,
    };
  } finally {
    release();
  }
}

export async function pushAllRegistered(
  deps: SyncEngineDeps,
): Promise<
  Map<
    string,
    | { pushedFiles: string[]; contentWarnings: string[] }
    | { skipped: true; reason: string }
    | { failed: true; error: string }
  >
> {
  const registry = loadRegistry(deps.registryPath);
  const results = new Map<
    string,
    | { pushedFiles: string[]; contentWarnings: string[] }
    | { skipped: true; reason: string }
    | { failed: true; error: string }
  >();
  for (const [projectKey, entry] of Object.entries(registry)) {
    // Registry dosyaları güvenilmez girdi olarak ele alınır: an absolutePath read back
    // from ~/.memsync/registry.json must be re-resolved and re-validated here, not
    // trusted as-is, before it is handed to pushProject as a containment anchor root.
    // realpathSync (rather than existsSync) collapses any symlink in the path --
    // including a symlink swap of the registered directory itself -- so a corrupted
    // or tampered registry entry can never smuggle an arbitrary real-world path
    // (e.g. "/etc") into pushProject's [projectDir, homeDir] trust boundary.
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(entry.absolutePath);
    } catch {
      results.set(projectKey, { skipped: true, reason: "registry path no longer exists" });
      continue;
    }
    // Defense in depth: a TOCTOU removal between realpathSync and statSync above would
    // otherwise throw here and abort the whole --all run instead of just this entry.
    let stat;
    try {
      stat = statSync(resolvedPath);
    } catch {
      results.set(projectKey, { skipped: true, reason: "registry path no longer exists" });
      continue;
    }
    if (!stat.isDirectory()) {
      results.set(projectKey, { skipped: true, reason: "registry path is not a directory" });
      continue;
    }
    // A genuine push failure for one project (e.g. a non-fast-forward conflict,
    // per the no-auto-merge requirement) must not abort the whole --all run —
    // isolate it here so every other registered project still gets pushed and
    // reported.
    try {
      results.set(projectKey, await pushProject(deps, resolvedPath, projectKey));
    } catch (err) {
      results.set(projectKey, { failed: true, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
