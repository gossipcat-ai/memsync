import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { PullResult } from "../types.js";
import type { SyncEngineDeps } from "./push.js";
import {
  assertSafeKeyPath,
  resolveSafeAbsolutePathAnyRoot,
  resolveSafeAbsolutePathNoSymlinksAnyRoot,
  UnsafePathError,
} from "../path-safety.js";
import { upsertRegistryEntry, loadRegistry } from "../registry.js";
import { acquireLock } from "../lock.js";
import { readProjectFilesFromClone, readGlobalFilesFromClone } from "./clone-writer.js";

/**
 * Walks up from `dir` until it finds a path segment that already exists on
 * disk, without creating anything. Used to run the containment check on a
 * real (and therefore symlink-resolvable) ancestor *before* any directory is
 * created — see the comment on the per-file loop below for why this
 * ordering matters.
 */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null; // nothing exists there — safe to write fresh
  }
}

/**
 * The containment checks in the write loop only cover the destination's
 * DIRECTORY. The destination entry itself still has to be inspected with
 * lstatSync (which does NOT dereference), because:
 *   - a symlink at the destination would be followed by writeFileSync, landing
 *     gist content at the link's target — potentially outside every allowed
 *     root. A DANGLING symlink is the worst case: existsSync() returns false for
 *     it, so the .bak backup would also be skipped and the write would look like
 *     an ordinary first-time create.
 *   - a directory there would be renamed wholesale to "<dir>.bak" and replaced
 *     by a regular file.
 * No legitimate detector destination is ever a symlink or a directory, so both
 * are refused outright rather than resolved.
 */
function isUnsafeDest(stat: Stats | null): boolean {
  return stat !== null && (stat.isSymbolicLink() || stat.isDirectory());
}

function findExistingAncestor(dir: string): string {
  let current = dir;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root, stop
    current = parent;
  }
  return current;
}

export async function pullProject(
  deps: SyncEngineDeps,
  projectDir: string,
  projectKey: string,
  opts: { dryRun?: boolean } = {},
): Promise<PullResult> {
  const release = acquireLock(deps.lockPath);
  try {
    const cloneDir = await deps.backend.ensureLocalClone();
    const pullResult = await deps.backend.pull();
    if (!pullResult.fastForward) {
      return pullResult;
    }

    const projectFiles = readProjectFilesFromClone(cloneDir, projectKey);
    const globalFiles = readGlobalFilesFromClone(cloneDir);
    const changedFiles: string[] = [];
    const skippedUnsafe: string[] = [];
    const allowedRoots = [projectDir, deps.homeDir];

    // Each entry keeps the scope of the gist prefix it was actually read from.
    // Merging the two lists into one undifferentiated array would leave
    // resolveLocalPath below unable to tell a `<projectKey>/claude/CLAUDE.md`
    // entry from a `global/claude/CLAUDE.md` one — and it would resolve both to
    // the real global file (spec: "Path güvenliği" → scope conflation).
    const scopedFiles = [
      ...projectFiles.map((f) => ({ ...f, scope: "project" as const })),
      ...globalFiles.map((f) => ({ ...f, scope: "global" as const })),
    ];

    for (const { relativeKeyPath, content, scope } of scopedFiles) {
      // Defense in depth: this repeats the same string-level check clone-writer.ts already
      // performs on write, so pull.ts does not implicitly rely on a specific GitRemoteBackend
      // (or git's own checkout-time protections) to keep a traversal out of the containment
      // check below. A rejected path is skipped, not fatal to the rest of the pull.
      try {
        assertSafeKeyPath(relativeKeyPath);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          skippedUnsafe.push(relativeKeyPath);
          continue;
        }
        throw err;
      }

      let localPath: string | null = null;
      for (const detector of deps.detectors) {
        try {
          localPath = detector.resolveLocalPath(relativeKeyPath, projectDir, deps.homeDir, scope);
          break;
        } catch {
          continue;
        }
      }
      if (!localPath) {
        skippedUnsafe.push(relativeKeyPath);
        continue;
      }

      // Path güvenliği: check containment on the nearest EXISTING ancestor directory
      // BEFORE creating anything. If an intermediate segment under dirname(localPath) is a
      // pre-existing symlink pointing outside allowedRoots, mkdirSync's recursive mode would
      // silently walk through it and create new directories at the escaped location before any
      // containment check ever ran. Resolving containment on the existing ancestor first (which
      // realpathSync can fully resolve, since it already exists) means an escape is caught
      // without ever touching the filesystem — same invariant assertSafeKeyPath enforces for
      // pure string checks.
      //
      // Containment is necessary but NOT sufficient, which is why this uses the
      // symlink-walk-aware variant. realpathSync resolves symlinks rather than refusing
      // them, and $HOME is deliberately an allowed root — so a hostile repo shipping
      // `.cursor/rules` as a link to $HOME makes a gist entry named `.zshrc` resolve to
      // the user's REAL ~/.zshrc, fully "contained", and pull would back it up to .bak and
      // overwrite it with remote content while reporting an ordinary success. The
      // destination-entry lstat gate below cannot catch that either: the OS follows the
      // symlinked directory long before the final component, so the leaf lstats as a
      // perfectly normal regular file at the attacker's chosen location.
      //
      // Segments BELOW existingAncestor need no walk: they do not exist yet, so they
      // cannot already be a planted symlink. mkdirSync creates them as real directories,
      // and the post-mkdirSync re-check below covers the narrow race window there.
      const existingAncestor = findExistingAncestor(dirname(localPath));
      const safeAncestor = resolveSafeAbsolutePathNoSymlinksAnyRoot(existingAncestor, allowedRoots);
      if (safeAncestor === null) {
        skippedUnsafe.push(relativeKeyPath);
        continue; // an existing ancestor segment escapes allowedRoots or is a symlink — refuse, no filesystem write at all
      }

      // Run the destination-entry gate BEFORE the dry-run branch. It needs only
      // lstatSync — no mkdirSync, no write — so `--dry-run` and a real pull agree on
      // which files are safe instead of dry-run advertising a destination as "would
      // change" that a real pull then refuses. lstatSync does not require the parent
      // directory to exist (it just fails, i.e. "nothing there yet"), and localPath
      // names the same filesystem entry as the realpath-resolved safeDest below, so
      // this is the same check, merely earlier.
      if (isUnsafeDest(lstatOrNull(localPath))) {
        skippedUnsafe.push(relativeKeyPath);
        continue;
      }

      if (opts.dryRun) {
        // Nothing is created on disk in dry-run mode, so the post-mkdirSync TOCTOU
        // re-check below (which only guards against a race introduced by mkdirSync
        // itself) does not apply here. The ancestor-containment and destination
        // checks above are the safety gates this file needs to pass before being
        // reported as something a real pull would change.
        changedFiles.push(relativeKeyPath);
        continue;
      }

      mkdirSync(dirname(localPath), { recursive: true });
      // Defense in depth: re-verify after creation in case of a TOCTOU race between the
      // existing-ancestor check above and this mkdirSync call.
      const safeDir = resolveSafeAbsolutePathAnyRoot(dirname(localPath), allowedRoots);
      if (safeDir === null) {
        skippedUnsafe.push(relativeKeyPath);
        continue;
      }
      const safeDest = join(safeDir, basename(localPath));
      // Re-run the destination-entry gate on the realpath-resolved destination, after
      // mkdirSync: defense in depth against a race between the pre-check above and
      // the directory creation. See isUnsafeDest for why symlinks and directories are
      // refused rather than resolved.
      const destStat = lstatOrNull(safeDest);
      if (isUnsafeDest(destStat)) {
        skippedUnsafe.push(relativeKeyPath);
        continue;
      }
      // Only now — after the pre-mkdirSync ancestor-containment check, the
      // post-mkdirSync TOCTOU re-check, and the destination-entry check have all
      // succeeded — do we know this file will actually be written, so it is safe to
      // report it as changed.
      changedFiles.push(relativeKeyPath);
      if (destStat) {
        renameSync(safeDest, `${safeDest}.bak`);
      }
      writeFileSync(safeDest, content);
    }

    if (!opts.dryRun) {
      upsertRegistryEntry(deps.registryPath, projectKey, projectDir);
    }

    return { fastForward: true, changedFiles, skippedUnsafe };
  } finally {
    release();
  }
}

export async function pullAllRegistered(
  deps: SyncEngineDeps,
  opts: { dryRun?: boolean } = {},
): Promise<Map<string, PullResult | { skipped: true; reason: string } | { failed: true; error: string }>> {
  const registry = loadRegistry(deps.registryPath);
  const results = new Map<string, PullResult | { skipped: true; reason: string } | { failed: true; error: string }>();
  for (const [projectKey, entry] of Object.entries(registry)) {
    // Registry dosyaları güvenilmez girdi olarak ele alınır: an absolutePath read back
    // from ~/.memsync/registry.json must be re-resolved and re-validated here, not
    // trusted as-is, before it is handed to pullProject as a containment anchor root.
    // realpathSync (rather than existsSync) collapses any symlink in the path --
    // including a symlink swap of the registered directory itself -- so a corrupted
    // or tampered registry entry can never smuggle an arbitrary real-world path
    // (e.g. "/etc") into pullProject's [projectDir, homeDir] trust boundary, which
    // would otherwise let a pull write files like /etc/.cursorrules undetected.
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
    // A genuine pull failure for one project must not abort the whole --all
    // run — isolate it here so every other registered project still gets
    // pulled and reported.
    try {
      results.set(projectKey, await pullProject(deps, resolvedPath, projectKey, opts));
    } catch (err) {
      results.set(projectKey, { failed: true, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
