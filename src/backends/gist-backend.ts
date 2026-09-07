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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Git's own fixed wording for a rejected ref update always contains
        // this literal substring (e.g. "! [rejected] main -> main (fetch
        // first)" or "(non-fast-forward)") — but ONLY under an English git
        // locale. Under a translated locale (e.g. LANG=de_DE.UTF-8), git's
        // gettext-wrapped output replaces "[rejected]" with a translated
        // string (e.g. "[zurückgewiesen]"), so the substring check alone
        // would misroute a genuine conflict into the no-rollback branch.
        // Git's process exit code is locale-independent: a rejected
        // non-fast-forward push always exits 1, while a fatal/auth/network
        // failure always exits 128. Treat either signal as sufficient
        // evidence of a genuine rejection.
        const errCode = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        const isRejectedExitCode = typeof errCode === "number" && errCode === 1;
        if (!isRejectedExitCode && !message.includes("[rejected]")) {
          throw new Error(
            `push failed: ${message} — this does not look like a conflict with another machine; check your \`gh\` authentication and network connection, then retry \`memsync push\``,
          );
        }
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

  async rotate(): Promise<{ newGistId: string; oldGistId: string | undefined }> {
    const oldGistId = this.gistId;
    // Ensure we have the CURRENT content locally (against the OLD gist) before
    // we touch anything — rotate has nothing to carry over otherwise.
    await this.ensureLocalClone();

    // ensureLocalClone() is a no-op whenever the clone directory already exists on
    // disk — it never fetches/merges to catch an EXISTING clone up. rotate's realistic
    // audience already ran init/push at least once, so the clone almost always already
    // exists, and ensureLocalClone alone would silently do nothing here. Without an
    // explicit pull, a clone that is behind the OLD gist's true HEAD (another machine
    // pushed since this machine's last sync, or the gist was hand-edited on
    // github.com) would have its stale local snapshot force-pushed into the new gist,
    // discarding newer content with no warning. This mirrors pushProject's pre-sync
    // pull in src/sync-engine/push.ts, which exists for the same reason.
    const freshness = await this.pull();
    if (!freshness.fastForward) {
      throw new Error(
        "rotate aborted: local clone is not up to date with the current gist — run `memsync pull` first, then retry `memsync rotate`",
      );
    }

    // Same placeholder-file mechanism initRemote() already uses — `gh gist
    // create` cannot create a truly empty gist.
    const placeholderPath = join(tmpdir(), `memsync-gist-rotate-${randomUUID()}.md`);
    writeFileSync(placeholderPath, "# memsync\n\nAgent memory store, managed by memsync.\n");
    let newGistId: string;
    try {
      const { stdout } = await this.exec(
        "gh",
        ["gist", "create", "--desc", "memsync agent memory store", placeholderPath],
        {},
      );
      newGistId = extractGistId(stdout);
    } finally {
      rmSync(placeholderPath, { force: true });
    }

    // Retarget the EXISTING clone (which already has the current, real content)
    // at the new gist, then force-push — the new gist only contains the
    // throwaway placeholder we just created, so a normal fast-forward push
    // would be rejected (unrelated histories); force is safe here because we
    // deliberately want to overwrite that placeholder with the real content.
    const newCloneUrl = `https://gist.github.com/${newGistId}.git`;
    await this.exec("git", ["remote", "set-url", "origin", newCloneUrl], { cwd: this.localClonePath });
    try {
      await this.exec("git", ["push", "--force", "origin", "HEAD:main"], { cwd: this.localClonePath });
    } catch (err) {
      // set-url already succeeded, so `origin` on disk now points at the new
      // (still placeholder-only) gist even though this.gistId/config.json were
      // never updated — a state divergence where a later `memsync push` would
      // silently write real content into the new gist while doctor/status still
      // report the old one. Revert `origin` back before rethrowing so on-disk
      // state stays consistent with the in-memory/config state, which was never
      // advanced past oldGistId.
      if (oldGistId) {
        try {
          await this.exec(
            "git",
            ["remote", "set-url", "origin", `https://gist.github.com/${oldGistId}.git`],
            { cwd: this.localClonePath },
          );
        } catch {
          // best-effort revert; the original push failure is the error that matters
        }
      }
      throw err;
    }

    this.gistId = newGistId;
    return { newGistId, oldGistId };
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
