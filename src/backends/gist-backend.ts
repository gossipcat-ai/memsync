import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { GitRemoteBackend, PullResult } from "../types.js";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const run = promisify(execFile);

async function realExec(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await run(cmd, args, { cwd: opts.cwd });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function extractGistId(input: string): string {
  const match = input.trim().match(/([a-f0-9]+)\s*$/i);
  if (!match) {
    throw new Error(`Could not extract gist id from: ${input}`);
  }
  return match[1];
}

export class GistBackend implements GitRemoteBackend {
  public gistId: string | undefined;

  constructor(
    private readonly localClonePath: string,
    private readonly exec: ExecFn = realExec,
  ) {}

  async initRemote(existingId?: string): Promise<void> {
    if (existingId) {
      this.gistId = existingId;
      return;
    }
    // `gh gist create` cannot create a completely empty gist — it requires
    // at least one real file argument (or `-` for stdin). Write a throwaway
    // placeholder file to seed the gist; it is superseded by real project
    // files on the first `memsync push`.
    const placeholderPath = join(tmpdir(), `memsync-gist-init-${randomUUID()}.md`);
    writeFileSync(placeholderPath, "# memsync\n\nAgent memory store, managed by memsync.\n");
    try {
      // Gists are secret by default — do NOT pass a visibility flag here.
      // (`--secret` is not a valid flag; only `--public` exists, and memsync
      // never uses it.)
      const { stdout } = await this.exec(
        "gh",
        ["gist", "create", "--desc", "memsync agent memory store", placeholderPath],
        {},
      );
      this.gistId = extractGistId(stdout);
    } finally {
      rmSync(placeholderPath, { force: true });
    }
  }

  private gistCloneUrl(): string {
    return `https://gist.github.com/${this.gistId}.git`;
  }

  async ensureLocalClone(): Promise<string> {
    if (!existsSync(this.localClonePath)) {
      mkdirSync(dirname(this.localClonePath), { recursive: true });
      await this.exec("git", ["clone", this.gistCloneUrl(), this.localClonePath]);
    }
    return this.localClonePath;
  }

  async push(): Promise<void> {
    // The fast-forward check runs BEFORE anything is committed locally. If it
    // ran after the commit (as it once did), a clone that is merely behind
    // origin would create a sibling commit, permanently diverging: `push`
    // would reject and `pull` (also --ff-only) could never recover it. Merging
    // first means a behind-but-not-conflicting clone silently catches up, and
    // a genuine conflict throws with the working tree untouched.
    await this.exec("git", ["fetch", "origin"], { cwd: this.localClonePath });
    try {
      await this.exec("git", ["merge", "--ff-only", "origin/main"], { cwd: this.localClonePath });
    } catch {
      throw new Error(
        "push rejected: local clone is not fast-forward with origin/main — run `memsync pull` first",
      );
    }
    await this.exec("git", ["add", "-A"], { cwd: this.localClonePath });
    const status = await this.exec("git", ["status", "--porcelain"], { cwd: this.localClonePath });
    if (status.stdout.trim().length > 0) {
      await this.exec("git", ["commit", "-m", "memsync: sync"], { cwd: this.localClonePath });
      // If the REMOTE rejects the push (another machine won the race in the window
      // between the ff-check above and this call), the commit just created is
      // orphaned: the clone is now ahead of its last known-good state AND behind the
      // new remote, which neither --ff-only pull nor a retried push can undo. Discard
      // it. This is safe precisely because the clone only ever holds REGENERATED
      // copies of live local files — it is a derived artifact with no unique data,
      // the same reasoning pushProject's pre-sync already relies on.
      try {
        await this.exec("git", ["push", "origin", "main"], { cwd: this.localClonePath });
      } catch {
        try {
          await this.exec("git", ["fetch", "origin"], { cwd: this.localClonePath });
          await this.exec("git", ["reset", "--hard", "origin/main"], { cwd: this.localClonePath });
        } catch {
          throw new Error(
            "push rejected and the local clone could not be rolled back — manually inspect ~/.memsync/repo",
          );
        }
        throw new Error(
          "push rejected: another machine pushed first — your changes were not saved, run `memsync push` again",
        );
      }
    }
  }

  async pull(): Promise<PullResult> {
    await this.exec("git", ["fetch", "origin"], { cwd: this.localClonePath });
    const before = await this.exec("git", ["rev-parse", "HEAD"], { cwd: this.localClonePath });
    try {
      await this.exec("git", ["merge", "--ff-only", "origin/main"], { cwd: this.localClonePath });
    } catch {
      return { fastForward: false, changedFiles: [], skippedUnsafe: [] };
    }
    const after = await this.exec("git", ["rev-parse", "HEAD"], { cwd: this.localClonePath });
    if (before.stdout === after.stdout) {
      return { fastForward: true, changedFiles: [], skippedUnsafe: [] };
    }
    const diff = await this.exec(
      "git",
      ["diff", "--name-only", before.stdout.trim(), after.stdout.trim()],
      { cwd: this.localClonePath },
    );
    return {
      fastForward: true,
      changedFiles: diff.stdout.split("\n").filter((l) => l.length > 0),
      skippedUnsafe: [],
    };
  }

  async checkVisibility(): Promise<"private" | "public" | "unknown"> {
    if (!this.gistId) return "unknown";
    try {
      const { stdout } = await this.exec("gh", [
        "api",
        `gists/${this.gistId}`,
        "--jq",
        ".public",
      ]);
      return stdout.trim() === "true" ? "public" : "private";
    } catch {
      return "unknown";
    }
  }
}
