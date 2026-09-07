import type { SyncEngineDeps } from "../sync-engine/push.js";
import { pushProject, pushAllRegistered } from "../sync-engine/push.js";
import { resolveProjectKeyForDir } from "../project-key.js";

export interface RunPushOptions {
  projectDir: string;
  all?: boolean;
  projectKeyOverride?: string;
}

export async function runPush(deps: SyncEngineDeps, opts: RunPushOptions): Promise<void> {
  if (opts.all) {
    const results = await pushAllRegistered(deps);
    // A scripted / cron-driven `--all` run must be able to tell that something went
    // wrong. Per-project isolation is preserved (the loop still runs to completion and
    // reports every project); only the final exit code reflects the failures. In the
    // single-project branch below a failure propagates as a thrown error instead, which
    // the CLI entrypoint already turns into a non-zero exit.
    let anyFailure = false;
    for (const [key, result] of results) {
      if ("skipped" in result) {
        // Deliberately does NOT set anyFailure. Spec, "Eskimiş girdi": a registry
        // entry whose absolutePath no longer exists is skipped with a warning and
        // the run continues — "tek bir eskimiş girdi tüm `--all` çalıştırmasını
        // başarısız kılmaz". It is stale local housekeeping, not a sync failure.
        console.warn(`skipping ${key}: ${result.reason}`);
      } else if ("failed" in result) {
        anyFailure = true;
        // A single registered project's genuine push failure (e.g. a
        // non-fast-forward conflict, per the no-auto-merge requirement) must
        // not prevent the rest of the registry from being processed and
        // reported — pushAllRegistered already isolates this per-project.
        console.error(`${key}: failed — ${result.error}`);
      } else {
        console.log(`pushed ${key}: ${result.pushedFiles.length} file(s)`);
        for (const warning of result.contentWarnings) {
          console.warn(`possible secret in ${warning} — not blocked, review before sharing the gist URL`);
        }
      }
    }
    if (anyFailure) {
      process.exitCode = 1;
    }
    return;
  }
  const projectKey = opts.projectKeyOverride ?? resolveProjectKeyForDir(opts.projectDir);
  const result = await pushProject(deps, opts.projectDir, projectKey);
  console.log(`pushed ${projectKey}: ${result.pushedFiles.length} file(s)`);
  for (const warning of result.contentWarnings) {
    console.warn(`possible secret in ${warning} — not blocked, review before sharing the gist URL`);
  }
}
