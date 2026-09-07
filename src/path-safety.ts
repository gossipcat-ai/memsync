import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export class UnsafePathError extends Error {
  constructor(key: string) {
    super(`Unsafe path rejected: ${key}`);
    this.name = "UnsafePathError";
  }
}

/**
 * Validates that `key` is a safe, relative path suitable for joining onto a
 * base directory. This check is deliberately platform-agnostic — it must not
 * depend on `process.platform` or the native `path` module's
 * `normalize`/`isAbsolute`/`sep`, because keys may originate from a synced
 * gist written by a different OS's memsync client.
 */
export function assertSafeKeyPath(key: string): void {
  // Reject any colon outright: rules out every Windows drive-letter and
  // drive-relative form (C:foo, C:\foo, C:/foo) without special-casing them.
  // No legitimate relativeKeyPath ever contains a colon.
  if (key.includes(":")) {
    throw new UnsafePathError(key);
  }

  // Reject a leading separator: covers POSIX-absolute and
  // Windows-UNC/backslash-absolute forms.
  if (/^[/\\]/.test(key)) {
    throw new UnsafePathError(key);
  }

  // Split on any run of / or \ characters (not path.sep) and reject if any
  // resulting segment is literally "..", "." or empty. This catches traversal
  // regardless of which separator convention the string uses, without relying
  // on normalize's segment-merging behavior.
  //
  // The "" and "." cases matter as much as "..": a key with a trailing
  // separator ("claude/memory/") splits to ["claude", "memory", ""], and a
  // detector's `join(memoryDir, key.slice(prefix.length))` then resolves the
  // empty remainder back to `memoryDir` itself — the user's real memory
  // DIRECTORY, not a file inside it. pull would rename that whole directory to
  // `.bak` and write a regular file in its place, reported as a normal
  // success. No legitimate detector-produced relativeKeyPath (or projectKey)
  // ever contains an empty or "." segment.
  const segments = key.split(/[/\\]+/);
  if (segments.includes("..") || segments.includes("") || segments.includes(".")) {
    throw new UnsafePathError(key);
  }
}

/**
 * Resolves `candidate` to its real, symlink-free filesystem path and
 * verifies it is contained within `allowedRoot`. Unlike `assertSafeKeyPath`
 * (a pure string check performed before any filesystem access), this
 * function requires `candidate` and `allowedRoot` to actually exist and
 * uses `realpathSync` to resolve every symlink in the chain — both the
 * leaf and any intermediate directory segment — so a symlink that points
 * outside the allowed root cannot be used to escape containment.
 *
 * Returns the resolved real path on success, or `null` if the candidate
 * does not exist, the root does not exist, or the resolved path escapes
 * the root.
 */
export function resolveSafeAbsolutePath(candidate: string, allowedRoot: string): string | null {
  let realCandidate: string;
  let realRoot: string;
  try {
    realCandidate = realpathSync(candidate);
    realRoot = realpathSync(allowedRoot);
  } catch {
    return null; // candidate or root does not exist
  }
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realCandidate === realRoot || realCandidate.startsWith(rootWithSep)) {
    return realCandidate;
  }
  return null;
}

/**
 * Like `resolveSafeAbsolutePath`, but accepts multiple allowed roots and
 * returns the resolved real path for the first root that contains
 * `candidate`. Callers pass e.g. `[projectDir, homeDir]` because a
 * detector's file is not guaranteed to live under the project directory
 * specifically (e.g. Claude Code's project memory lives under
 * `$HOME/.claude/projects/<encoded>/memory/`, while Cursor's `.cursorrules`
 * lives under the project directory itself).
 */
export function resolveSafeAbsolutePathAnyRoot(candidate: string, allowedRoots: string[]): string | null {
  for (const root of allowedRoots) {
    const result = resolveSafeAbsolutePath(candidate, root);
    if (result !== null) return result;
  }
  return null;
}

/**
 * True if any path segment BELOW `root` on the way to `candidate` (inclusive of
 * candidate's own final component, exclusive of the root itself) is a symlink.
 *
 * Realpath containment alone is not enough, in either direction memsync moves data:
 *
 *   - PUSH: a detector enumerates a directory with `readdirSync`, and if that
 *     directory is itself a symlink — say a hostile repo ships
 *     `.cursor/rules -> $HOME/.ssh`, materialized the moment someone clones it —
 *     every entry it yields becomes a FileRef whose *lexical* absolutePath still
 *     looks like it lives in the project. The OS resolves that link before it ever
 *     reaches the final component, so the leaf lstats as a perfectly ordinary
 *     regular file. It is one; it just isn't where the path says it is.
 *   - PULL: the same link makes a gist entry's destination resolve to an arbitrary
 *     path under $HOME (e.g. `~/.zshrc`), which pull then backs up to `.bak` and
 *     overwrites with remote content, reporting a normal success.
 *
 * Both accept, because the resolved path really is under $HOME — a root memsync
 * allows on purpose (Claude Code's project memory legitimately lives deep under it).
 *
 * The walk deliberately STARTS at `root` and never stats the root itself: only links
 * introduced *between* the root and the target are the attacker's doing. How the root
 * is reached is a separate, already-handled concern (resolveSafeAbsolutePath's realpath
 * containment). Re-examining it would misfire on benign OS-level links — macOS's
 * `/var -> /private/var`, and therefore nearly every `os.tmpdir()` path.
 *
 * A candidate that IS the root has no segments below the root and is therefore
 * vacuously symlink-free. That case is common and legitimate on the pull side
 * (cursor's `.cursorrules` resolves directly under projectDir, so its nearest existing
 * ancestor is projectDir itself) and must not be conflated with "a segment is a
 * symlink". A symlink AT the target is a separate concern both callers check
 * independently with their own `lstatSync` gate.
 */
function hasSymlinkedSegmentBelowRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  // Zero segments below the root — nothing for this walk to inspect.
  if (rel === "") return false;
  // Not lexically under this root at all — irrelevant here; realpath containment is
  // what decides that, and it is checked separately.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true; // vanished mid-walk — fail closed
    }
  }
  return false;
}

/**
 * Like `resolveSafeAbsolutePath`, but additionally requires that `candidate` is
 * reached from `allowedRoot` through zero symlinked path segments — see
 * `hasSymlinkedSegmentBelowRoot` for why containment alone is insufficient.
 *
 * Containment and the segment walk are anchored to the SAME root by construction.
 * Checking them against different roots would let one root vouch for containment
 * while a different one vouches for the walk, which is precisely the hole this
 * function exists to close.
 *
 * Returns the resolved real path on success, or `null` otherwise.
 */
export function resolveSafeAbsolutePathNoSymlinks(candidate: string, allowedRoot: string): string | null {
  const resolved = resolveSafeAbsolutePath(candidate, allowedRoot);
  if (resolved === null) return null;
  if (hasSymlinkedSegmentBelowRoot(candidate, allowedRoot)) return null;
  return resolved;
}

/**
 * Like `resolveSafeAbsolutePathAnyRoot`, but each root must satisfy BOTH containment
 * and the symlink-free segment walk for that same root before it is accepted.
 */
export function resolveSafeAbsolutePathNoSymlinksAnyRoot(candidate: string, allowedRoots: string[]): string | null {
  for (const root of allowedRoots) {
    const result = resolveSafeAbsolutePathNoSymlinks(candidate, root);
    if (result !== null) return result;
  }
  return null;
}
