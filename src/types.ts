export interface FileRef {
  absolutePath: string;
  relativeKeyPath: string; // tool-relative, e.g. "claude/MEMORY.md"
  exists: boolean;
}

export interface Detector {
  name: string; // e.g. "claude-code" — also the first path segment of every relativeKeyPath this detector produces
  findProjectFiles(projectDir: string, homeDir: string): FileRef[];
  findGlobalFiles(homeDir: string): FileRef[];
  // `scope` tells the detector whether the caller read this relativeKeyPath from the
  // project-scoped (`<projectKey>/`) or the global (`global/`) prefix of the gist. A
  // detector MUST throw when the key does not belong to that scope — otherwise a
  // project-scoped entry whose key collides with a global one (e.g. "claude/CLAUDE.md")
  // would resolve to, and overwrite, the real global file. See the spec's
  // "Path güvenliği" → scope conflation clause.
  resolveLocalPath(
    relativeKeyPath: string,
    projectDir: string,
    homeDir: string,
    scope: "project" | "global",
  ): string;
}

export interface PullResult {
  fastForward: boolean;
  changedFiles: string[];
  skippedUnsafe: string[];
}

export interface GitRemoteBackend {
  ensureLocalClone(): Promise<string>;
  initRemote(existingId?: string): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<PullResult>;
  checkVisibility(): Promise<"private" | "public" | "unknown">;
}
