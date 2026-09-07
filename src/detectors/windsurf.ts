import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Detector, FileRef } from "../types.js";

// Recursively walks currentDir (starting at .windsurf/rules/ or .devin/rules/ and
// descending into any real, non-symlinked subdirectories), collecting FileRefs for
// every *.md file. Mirrors the symlink discipline established in claude-code.ts's
// walkMemoryDir and cursor.ts's walkRulesDir: lstatSync (not statSync) is used so
// symlink entries are detected without being dereferenced, and any symlink —
// whether a file or a directory — is skipped entirely rather than followed. This
// avoids both infinite loops via symlink cycles and reading arbitrary content from
// outside the rules directory via a planted link. relativeSegments accumulates the
// path (relative to the rules root) using forward slashes regardless of OS,
// matching this project's relativeKeyPath convention. readdirSync failures are
// handled per-subtree: if a nested directory's listing throws, that subtree is
// skipped but the rest of the walk continues. keyPrefix lets callers distinguish
// entries sourced from .windsurf/rules/ ("windsurf/rules/") vs .devin/rules/
// ("windsurf/devin-rules/") so the two directories can never collide in the gist's
// key space even when they contain identically-named files.
function walkRulesDir(currentDir: string, relativeSegments: string[], keyPrefix: string): FileRef[] {
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
      refs.push(...walkRulesDir(entryPath, [...relativeSegments, entry], keyPrefix));
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const relativePath = [...relativeSegments, entry].join("/");
    refs.push({
      absolutePath: entryPath,
      relativeKeyPath: `${keyPrefix}${relativePath}`,
      exists: true,
    });
  }
  return refs;
}

export const windsurfDetector: Detector = {
  name: "windsurf",

  findProjectFiles(projectDir: string, _homeDir: string): FileRef[] {
    const rulesFile = join(projectDir, ".windsurfrules");
    const refs: FileRef[] = [
      { absolutePath: rulesFile, relativeKeyPath: "windsurf/.windsurfrules", exists: existsSync(rulesFile) },
    ];

    const windsurfRulesDir = join(projectDir, ".windsurf", "rules");
    if (existsSync(windsurfRulesDir)) {
      refs.push(...walkRulesDir(windsurfRulesDir, [], "windsurf/rules/"));
    }

    const devinRulesDir = join(projectDir, ".devin", "rules");
    if (existsSync(devinRulesDir)) {
      refs.push(...walkRulesDir(devinRulesDir, [], "windsurf/devin-rules/"));
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
      throw new Error(`windsurf detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`);
    }
    if (relativeKeyPath === "windsurf/.windsurfrules") {
      return join(projectDir, ".windsurfrules");
    }
    const rulesPrefix = "windsurf/rules/";
    if (relativeKeyPath.startsWith(rulesPrefix)) {
      return join(projectDir, ".windsurf", "rules", relativeKeyPath.slice(rulesPrefix.length));
    }
    const devinRulesPrefix = "windsurf/devin-rules/";
    if (relativeKeyPath.startsWith(devinRulesPrefix)) {
      return join(projectDir, ".devin", "rules", relativeKeyPath.slice(devinRulesPrefix.length));
    }
    throw new Error(`windsurf detector cannot resolve local path for ${relativeKeyPath}`);
  },
};
