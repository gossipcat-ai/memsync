import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Detector, FileRef } from "../types.js";

// Directory basenames never recursed into while walking the project tree for
// nested AGENTS.md files. Unlike the other detectors' nested walks (each confined
// to one small, well-known subdirectory like .cursor/rules/), this walk has no
// fixed subtree to anchor on — AGENTS.md's nested convention allows a file at any
// depth in a monorepo — so it must walk the whole project tree and explicitly
// steer around dependency, VCS, and build-output directories.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".turbo",
  "vendor",
  "target",
  ".venv",
  "venv",
]);

// Recursively walks currentDir (starting at projectDir itself and descending into
// any real, non-symlinked, non-excluded subdirectories), collecting FileRefs for
// nested AGENTS.md files. Mirrors the symlink discipline established in
// claude-code.ts's walkMemoryDir and cursor.ts's walkRulesDir: lstatSync (not
// statSync) is used so symlink entries are detected without being dereferenced,
// and any symlink — whether a file or a directory — is skipped entirely rather
// than followed. This avoids both infinite loops via symlink cycles and reading
// arbitrary content from outside the project via a planted link. relativeSegments
// accumulates the path (relative to projectDir) using forward slashes regardless
// of OS, matching this project's relativeKeyPath convention. readdirSync failures
// are handled per-subtree: if a nested directory's listing throws, that subtree is
// skipped but the rest of the walk continues. The root-level AGENTS.md (i.e. an
// entry named AGENTS.md found when relativeSegments is still empty) is skipped
// here to avoid re-adding it as a duplicate/second ref — findProjectFiles already
// returns a fixed ref for it — mirroring how claude-code.ts's walkMemoryDir
// explicitly skips re-adding the root MEMORY.md for the same reason.
function walkForNestedAgentsMd(currentDir: string, relativeSegments: string[]): FileRef[] {
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
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      refs.push(...walkForNestedAgentsMd(entryPath, [...relativeSegments, entry]));
      continue;
    }
    if (entry !== "AGENTS.md") continue;
    // Root-level AGENTS.md is already covered by the fixed ref in findProjectFiles.
    if (relativeSegments.length === 0) continue;
    const relativePath = [...relativeSegments, entry].join("/");
    refs.push({
      absolutePath: entryPath,
      relativeKeyPath: `agents-md/nested/${relativePath}`,
      exists: true,
    });
  }
  return refs;
}

export const agentsMdDetector: Detector = {
  name: "agents-md",

  findProjectFiles(projectDir: string, _homeDir: string): FileRef[] {
    const agentsFile = join(projectDir, "AGENTS.md");
    const refs: FileRef[] = [
      { absolutePath: agentsFile, relativeKeyPath: "agents-md/AGENTS.md", exists: existsSync(agentsFile) },
    ];
    refs.push(...walkForNestedAgentsMd(projectDir, []));
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
      throw new Error(`agents-md detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`);
    }
    if (relativeKeyPath === "agents-md/AGENTS.md") {
      return join(projectDir, "AGENTS.md");
    }
    const nestedPrefix = "agents-md/nested/";
    if (relativeKeyPath.startsWith(nestedPrefix)) {
      return join(projectDir, relativeKeyPath.slice(nestedPrefix.length));
    }
    throw new Error(`agents-md detector cannot resolve local path for ${relativeKeyPath}`);
  },
};
