import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Detector, FileRef } from "../types.js";

// Recursively walks currentDir (starting at .cursor/rules/ and descending into
// any real, non-symlinked subdirectories), collecting FileRefs for every *.md
// file. Mirrors the symlink discipline established in claude-code.ts's
// walkMemoryDir: lstatSync (not statSync) is used so symlink entries are
// detected without being dereferenced, and any symlink — whether a file or a
// directory — is skipped entirely rather than followed. This avoids both
// infinite loops via symlink cycles and reading arbitrary content from
// outside the rules directory via a planted link. relativeSegments
// accumulates the path (relative to .cursor/rules/) using forward slashes
// regardless of OS, matching this project's relativeKeyPath convention.
// readdirSync failures are handled per-subtree: if a nested directory's
// listing throws, that subtree is skipped but the rest of the walk continues.
function walkRulesDir(currentDir: string, relativeSegments: string[]): FileRef[] {
  let entries: string[];
  try {
    entries = readdirSync(currentDir);
  } catch {
    // Directory became unreadable between discovery and read (permission
    // revoked, etc.). Degrade gracefully: skip just this subtree.
    return [];
  }
  const refs: FileRef[] = [];
  for (const entry of entries) {
    const entryPath = join(currentDir, entry);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      refs.push(...walkRulesDir(entryPath, [...relativeSegments, entry]));
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const relativePath = [...relativeSegments, entry].join("/");
    refs.push({
      absolutePath: entryPath,
      relativeKeyPath: `cursor/rules/${relativePath}`,
      exists: true,
    });
  }
  return refs;
}

export const cursorDetector: Detector = {
  name: "cursor",

  findProjectFiles(projectDir: string, _homeDir: string): FileRef[] {
    const cursorDir = join(projectDir, ".cursor");
    if (!existsSync(cursorDir)) {
      return [];
    }
    const refs: FileRef[] = [];
    const rulesFile = join(projectDir, ".cursorrules");
    refs.push({
      absolutePath: rulesFile,
      relativeKeyPath: "cursor/.cursorrules",
      exists: existsSync(rulesFile),
    });
    const rulesDir = join(cursorDir, "rules");
    if (existsSync(rulesDir)) {
      // walkRulesDir's internal try/catch degrades gracefully to [] if the
      // directory (or any nested subtree) is or becomes unreadable, so the
      // .cursorrules FileRef already pushed above is preserved either way.
      refs.push(...walkRulesDir(rulesDir, []));
    }
    return refs;
  },

  findGlobalFiles(_homeDir: string): FileRef[] {
    return [];
  },

  resolveLocalPath(
    relativeKeyPath: string,
    projectDir: string,
    _homeDir: string,
    scope: "project" | "global",
  ): string {
    // findGlobalFiles always returns [], so this detector never legitimately owns a
    // key under the gist's `global/` prefix — refuse to resolve one rather than
    // silently treating it as project-scoped.
    if (scope !== "project") {
      throw new Error(`cursor detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`);
    }
    if (relativeKeyPath === "cursor/.cursorrules") {
      return join(projectDir, ".cursorrules");
    }
    const prefix = "cursor/rules/";
    if (relativeKeyPath.startsWith(prefix)) {
      return join(projectDir, ".cursor", "rules", relativeKeyPath.slice(prefix.length));
    }
    throw new Error(`cursor detector cannot resolve local path for ${relativeKeyPath}`);
  },
};
