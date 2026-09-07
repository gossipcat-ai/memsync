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

function tokenizeBasename(basename: string): string[] {
  const withCamelBoundaries = basename.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return withCamelBoundaries
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function isSecretShapedFilename(relativeKeyPath: string): boolean {
  const basename = relativeKeyPath.split("/").pop() ?? relativeKeyPath;
  const tokens = new Set(tokenizeBasename(basename));
  if (tokens.has("token")) return true;
  if (tokens.has("api") && tokens.has("key")) return true;
  if (tokens.has("env")) return true;
  for (const token of tokens) {
    // Squashed, no-delimiter forms with a real prefix before "token", e.g.
    // "mytoken" or "authtoken" — but not "tokenizeit"/"tokenizer", which have
    // "token" as a prefix rather than a suffix.
    if (token.endsWith("token") && token !== "token") return true;
    // Squashed, no-delimiter "apikey" — both substrings within one token.
    if (token.includes("api") && token.includes("key")) return true;
  }
  return false;
}

export function filterIgnored(files: FileRef[], patterns: string[]): FileRef[] {
  const customPatterns = patterns.filter((p) => !DEFAULT_IGNORE_PATTERNS.includes(p));
  const ig = ignorePkg().add(customPatterns);
  return files.filter((f) => !isSecretShapedFilename(f.relativeKeyPath) && !ig.ignores(f.relativeKeyPath));
}

function patternToContentRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(escaped, "i");
}

// Fixed, high-confidence secret shapes that are worth flagging regardless of
// what the (glob-derived) `patterns` say — these don't necessarily contain
// "api"/"key"/"token"/"env" anywhere nearby. Kept short and specific to avoid
// over-triggering on short coincidental substrings; this is still
// best-effort, not exhaustive secret-scanning.
const KNOWN_SECRET_SHAPE_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/, // GitHub personal/oauth/user/server access tokens
  /AKIA[0-9A-Z]{16}/, // AWS access key ID
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, // PEM/OpenSSH private key header
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/, // real PGP private key export header always ends in "BLOCK"
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens (bot/app/user/refresh/etc.)
];

export function scanContentForSecretMatches(files: FileRef[], patterns: string[]): string[] {
  const regexes = [...patterns.map(patternToContentRegex), ...KNOWN_SECRET_SHAPE_PATTERNS];
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
