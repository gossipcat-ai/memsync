import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";
import type { FileRef } from "./types.js";

// The `ignore` package is CommonJS (`module.exports = factory`) with a
// `.d.ts` that declares an ES `export default`. Under this project's
// ESM + NodeNext module resolution, that mismatch makes a plain
// `import ignore from "ignore"` resolve to the wrong (non-callable)
// type. Loading it via `createRequire` sidesteps the broken interop
// typing while still resolving through the real CJS module at runtime.
const require = createRequire(import.meta.url);
const ignorePkg: (options?: unknown) => Ignore = require("ignore");

export const DEFAULT_IGNORE_PATTERNS = ["*api*key*", "*token*", "*.env*"];

function readPatternsFile(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function loadIgnorePatterns(projectDir: string, homeDir: string): string[] {
  const projectPatterns = readPatternsFile(join(projectDir, ".memsyncignore"));
  const globalPatterns = readPatternsFile(join(homeDir, ".memsync", "ignore"));
  return [...DEFAULT_IGNORE_PATTERNS, ...projectPatterns, ...globalPatterns];
}

export function filterIgnored(files: FileRef[], patterns: string[]): FileRef[] {
  const ig = ignorePkg().add(patterns);
  return files.filter((f) => !ig.ignores(f.relativeKeyPath));
}

function patternToContentRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(escaped, "i");
}

export function scanContentForSecretMatches(files: FileRef[], patterns: string[]): string[] {
  const regexes = patterns.map(patternToContentRegex);
  const flagged: string[] = [];
  for (const file of files) {
    if (!file.exists) continue;
    let content: string;
    try {
      content = readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    if (regexes.some((re) => re.test(content))) {
      flagged.push(file.relativeKeyPath);
    }
  }
  return flagged;
}
