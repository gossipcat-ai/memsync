import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Detector, FileRef } from "../types.js";

export function encodeClaudeProjectPath(absoluteProjectDir: string): string {
  return absoluteProjectDir.split(/[\\/]/).join("-");
}

// Recursively walks memoryDir (and any real, non-symlinked subdirectories
// under it), collecting FileRefs for every *.md file other than the
// root-level MEMORY.md. Mirrors the symlink discipline established in
// sync-engine/clone-writer.ts's readAllUnder: lstatSync (not statSync) is
// used so symlink entries are detected without being dereferenced, and any
// symlink — whether a file or a directory — is skipped entirely rather than
// followed. This avoids both infinite loops via symlink cycles and reading
// arbitrary content from outside the memory directory via a planted link.
// relativeSegments accumulates the path (relative to memoryDir) using
// forward slashes regardless of OS, matching this project's relativeKeyPath
// convention.
function walkMemoryDir(currentDir: string, memoryDir: string, relativeSegments: string[]): FileRef[] {
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
      refs.push(...walkMemoryDir(entryPath, memoryDir, [...relativeSegments, entry]));
      continue;
    }
    if (relativeSegments.length === 0 && entry === "MEMORY.md") continue;
    if (!entry.endsWith(".md")) continue;
    const relativePath = [...relativeSegments, entry].join("/");
    refs.push({
      absolutePath: entryPath,
      relativeKeyPath: `claude/memory/${relativePath}`,
      exists: true,
    });
  }
  return refs;
}

export const claudeCodeDetector: Detector = {
  name: "claude-code",

  findProjectFiles(projectDir: string, homeDir: string): FileRef[] {
    const encoded = encodeClaudeProjectPath(projectDir);
    const memoryDir = join(homeDir, ".claude", "projects", encoded, "memory");
    if (!existsSync(memoryDir)) {
      return [];
    }
    const refs: FileRef[] = [];
    const memoryMdPath = join(memoryDir, "MEMORY.md");
    refs.push({
      absolutePath: memoryMdPath,
      relativeKeyPath: "claude/MEMORY.md",
      exists: existsSync(memoryMdPath),
    });
    // If the top-level memoryDir became unreadable between the existsSync
    // check above and now (permission revoked, etc.), walkMemoryDir's
    // internal try/catch degrades gracefully to [] and we still return the
    // MEMORY.md FileRef already computed above.
    refs.push(...walkMemoryDir(memoryDir, memoryDir, []));
    return refs;
  },

  findGlobalFiles(homeDir: string): FileRef[] {
    const claudeMd = join(homeDir, "CLAUDE.md");
    if (!existsSync(claudeMd)) {
      return [];
    }
    return [{ absolutePath: claudeMd, relativeKeyPath: "claude/CLAUDE.md", exists: true }];
  },

  resolveLocalPath(
    relativeKeyPath: string,
    projectDir: string,
    homeDir: string,
    scope: "project" | "global",
  ): string {
    const encoded = encodeClaudeProjectPath(projectDir);
    // "claude/CLAUDE.md" is this detector's ONLY global-scope key, and the
    // project keys below are the only project-scope ones. Resolving a key
    // outside its own scope is refused: a gist entry stored under
    // `<projectKey>/claude/CLAUDE.md` must never be able to overwrite the real
    // `$HOME/CLAUDE.md`, even though the string itself is traversal-safe.
    if (relativeKeyPath === "claude/CLAUDE.md") {
      if (scope !== "global") {
        throw new Error(
          `claude-code detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`,
        );
      }
      return join(homeDir, "CLAUDE.md");
    }
    const memoryPrefix = "claude/memory/";
    if (relativeKeyPath === "claude/MEMORY.md" || relativeKeyPath.startsWith(memoryPrefix)) {
      if (scope !== "project") {
        throw new Error(
          `claude-code detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`,
        );
      }
      const memoryDir = join(homeDir, ".claude", "projects", encoded, "memory");
      return relativeKeyPath === "claude/MEMORY.md"
        ? join(memoryDir, "MEMORY.md")
        : join(memoryDir, relativeKeyPath.slice(memoryPrefix.length));
    }
    throw new Error(`claude-code detector cannot resolve local path for ${relativeKeyPath}`);
  },
};
