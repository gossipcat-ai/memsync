import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeKeyPath, UnsafePathError } from "../path-safety.js";
import type { FileRef } from "../types.js";

interface IndexJson {
  formatVersion: number;
  projects: string[];
}

interface ClonedFile {
  relativeKeyPath: string;
  content: Buffer;
}

/**
 * GitHub's gist git backend rejects real directories ("Gist does not
 * support directories") — confirmed via a live spike, see the spec's
 * "Gist içindeki veri yapısı" section. Every logical path therefore has
 * to be flattened into a single filename with no "/" left in it before
 * it is written into the clone. "%" is escaped first so the encoding is
 * unambiguously reversible even if a segment legitimately contains "%".
 */
function encodeFlatName(logicalPath: string): string {
  return logicalPath.replace(/%/g, "%25").replace(/\//g, "%2F");
}

function decodeFlatName(flatName: string): string {
  return flatName.replace(/%2F/g, "/").replace(/%25/g, "%");
}

/**
 * Copies each `exists: true` FileRef into `baseDir/<flattened logical
 * path>` as a single flat file — never a nested directory (gist does
 * not support them).
 *
 * `relativeKeyPath` values here originate from `FileRef`s, which may be
 * built from registry data (an untrusted-input source per spec's "Path
 * güvenliği" section). Every value is validated with `assertSafeKeyPath`
 * before it is used to derive a filesystem path — a rejected value throws
 * `UnsafePathError` before any `copyFileSync` call happens.
 */
function copyInto(baseDir: string, logicalPrefix: string, files: FileRef[]): void {
  mkdirSync(baseDir, { recursive: true });
  for (const file of files) {
    assertSafeKeyPath(file.relativeKeyPath);
    if (!file.exists) continue;
    const dest = join(baseDir, encodeFlatName(`${logicalPrefix}/${file.relativeKeyPath}`));
    copyFileSync(file.absolutePath, dest);
  }
}

export function writeProjectFiles(cloneDir: string, projectKey: string, files: FileRef[]): void {
  assertSafeKeyPath(projectKey);
  copyInto(cloneDir, projectKey, files);
}

export function writeGlobalFiles(cloneDir: string, files: FileRef[]): void {
  copyInto(cloneDir, "global", files);
}

function readAllUnder(baseDir: string, logicalPrefix: string): ClonedFile[] {
  if (!existsSync(baseDir)) return [];
  const results: ClonedFile[] = [];
  const prefix = `${logicalPrefix}/`;
  for (const entry of readdirSync(baseDir)) {
    const full = join(baseDir, entry);
    // Use lstatSync (not statSync) so symlink entries are detected without
    // being dereferenced. Git materializes tracked symlinks as real OS
    // symlinks on clone/checkout, so a compromised or malicious gist write
    // could plant one under baseDir pointing anywhere on disk (e.g.
    // ~/.ssh/id_rsa). No legitimate detector-produced memory file is ever
    // a symlink, so any symlink found here is skipped entirely rather than
    // followed. Everything in a real gist clone is a flat file (gist
    // rejects real directories), so a directory entry here would be
    // unexpected too — skip it defensively rather than recursing.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      continue;
    }
    const logical = decodeFlatName(entry);
    if (!logical.startsWith(prefix)) continue;
    const relativeKeyPath = logical.slice(prefix.length);
    // Unlike the old nested-directory walk (where relativeKeyPath came from
    // real disk enumeration under baseDir and could never legally contain
    // ".."), this flat filename was decoded from an on-disk name that
    // originated in a gist — an untrusted source (see the symlink-defense
    // comment above). A flat filename can contain no real "/" and still pass
    // every check above, yet decode to a relativeKeyPath like
    // "../../../etc/passwd". This function must be self-defending at its own
    // trust boundary rather than relying on a caller to catch it, so
    // validate here and just skip the bad entry rather than aborting the
    // whole read.
    try {
      assertSafeKeyPath(relativeKeyPath);
    } catch (err) {
      if (err instanceof UnsafePathError) continue;
      throw err;
    }
    results.push({ relativeKeyPath, content: readFileSync(full) });
  }
  return results;
}

export function readProjectFilesFromClone(cloneDir: string, projectKey: string): ClonedFile[] {
  assertSafeKeyPath(projectKey);
  return readAllUnder(cloneDir, projectKey).filter((f) => f.relativeKeyPath !== "meta.json");
}

export function readGlobalFilesFromClone(cloneDir: string): ClonedFile[] {
  return readAllUnder(cloneDir, "global");
}

export function updateIndexJson(cloneDir: string, projectKey: string): void {
  assertSafeKeyPath(projectKey);
  const path = join(cloneDir, "index.json");
  const index: IndexJson = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as IndexJson)
    : { formatVersion: 1, projects: [] };
  if (!index.projects.includes(projectKey)) {
    index.projects.push(projectKey);
  }
  writeFileSync(path, JSON.stringify(index, null, 2));
}

export function updateMetaJson(
  cloneDir: string,
  projectKey: string,
  activeTools: string[],
  hostname: string,
): void {
  assertSafeKeyPath(projectKey);
  mkdirSync(cloneDir, { recursive: true });
  const meta = {
    displayName: projectKey,
    activeTools,
    lastSyncedAt: new Date().toISOString(),
    hostname,
  };
  writeFileSync(join(cloneDir, encodeFlatName(`${projectKey}/meta.json`)), JSON.stringify(meta, null, 2));
}
