import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GitRemoteBackend, PullResult } from "../types.js";

const run = promisify(execFile);

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return run("git", args, { cwd });
}

export class LocalBareGitBackend implements GitRemoteBackend {
  constructor(
    private readonly bareRepoPath: string,
    private readonly localClonePath: string,
  ) {}

  async initRemote(_existingId?: string): Promise<void> {
    mkdirSync(this.bareRepoPath, { recursive: true });
    // Pin the bare repo's default branch to "main" explicitly (via -b) rather
    // than relying on the host's git config (init.defaultBranch), which
    // varies across environments (older git / unconfigured hosts default to
    // "master"). Without this, a fresh clone's initial branch name would not
    // match "main", and the hardcoded refs/heads/main pushes below would
    // diverge instead of fast-forwarding.
    await git(["init", "--bare", "-q", "-b", "main"], this.bareRepoPath);
  }

  async ensureLocalClone(): Promise<string> {
    if (!existsSync(this.localClonePath)) {
      mkdirSync(dirname(this.localClonePath), { recursive: true });
      await git(["clone", "-q", this.bareRepoPath, this.localClonePath], dirname(this.localClonePath));
      await git(["config", "user.email", "memsync@local"], this.localClonePath);
      await git(["config", "user.name", "memsync"], this.localClonePath);
      // A brand-new clone of an empty bare repo has no commits yet; seed one so push/pull work.
      await git(["commit", "--allow-empty", "-q", "-m", "memsync: init"], this.localClonePath);
      await git(["push", "-q", "origin", "HEAD:refs/heads/main"], this.localClonePath);
      await git(["branch", "-q", "-M", "main"], this.localClonePath);
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
    await git(["fetch", "-q", "origin"], this.localClonePath);
    try {
      await git(["merge", "--ff-only", "-q", "origin/main"], this.localClonePath);
    } catch {
      throw new Error("push rejected: local clone is not fast-forward with origin/main");
    }
    await git(["add", "-A"], this.localClonePath);
    const status = await git(["status", "--porcelain"], this.localClonePath);
    if (status.stdout.trim().length > 0) {
      await git(["commit", "-q", "-m", "memsync: sync"], this.localClonePath);
      // If the REMOTE rejects the push (another machine won the race in the window
      // between the ff-check above and this call), the commit just created is
      // orphaned: the clone is now ahead of its last known-good state AND behind the
      // new remote, which neither --ff-only pull nor a retried push can undo. Discard
      // it. This is safe precisely because the clone only ever holds REGENERATED
      // copies of live local files — it is a derived artifact with no unique data,
      // the same reasoning pushProject's pre-sync already relies on.
      try {
        await git(["push", "-q", "origin", "main"], this.localClonePath);
      } catch {
        try {
          await git(["fetch", "-q", "origin"], this.localClonePath);
          await git(["reset", "--hard", "-q", "origin/main"], this.localClonePath);
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
    await git(["fetch", "-q", "origin"], this.localClonePath);
    const before = await git(["rev-parse", "HEAD"], this.localClonePath);
    try {
      await git(["merge", "--ff-only", "-q", "origin/main"], this.localClonePath);
    } catch {
      return { fastForward: false, changedFiles: [], skippedUnsafe: [] };
    }
    const after = await git(["rev-parse", "HEAD"], this.localClonePath);
    if (before.stdout === after.stdout) {
      return { fastForward: true, changedFiles: [], skippedUnsafe: [] };
    }
    const diff = await git(["diff", "--name-only", before.stdout.trim(), after.stdout.trim()], this.localClonePath);
    const changedFiles = diff.stdout.split("\n").filter((line) => line.length > 0);
    return { fastForward: true, changedFiles, skippedUnsafe: [] };
  }

  async checkVisibility(): Promise<"private" | "public" | "unknown"> {
    return "private";
  }
}
