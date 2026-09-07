import type { SyncEngineDeps } from "../sync-engine/push.js";
import { pullProject, pullAllRegistered } from "../sync-engine/pull.js";
import { resolveProjectKeyForDir } from "../project-key.js";

export interface RunPullOptions {
  projectDir: string;
  all?: boolean;
  dryRun?: boolean;
  projectKeyOverride?: string;
}

export async function runPull(deps: SyncEngineDeps, opts: RunPullOptions): Promise<void> {
  if (opts.all) {
    const results = await pullAllRegistered(deps, { dryRun: opts.dryRun });
    // A scripted / cron-driven `--all` run must be able to tell that something went
    // wrong. Per-project isolation is preserved (the loop still runs to completion and
    // reports every project); only the final exit code reflects the failures, matching
    // what the single-project branch below already does.
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
        // A single registered project's genuine pull failure must not
        // prevent the rest of the registry from being processed and
        // reported — pullAllRegistered already isolates this per-project.
        console.error(`${key}: failed — ${result.error}`);
      } else if (!result.fastForward) {
        anyFailure = true;
        console.error(`${key}: not fast-forward — run without --all to resolve manually`);
      } else {
        if (result.skippedUnsafe.length > 0) {
          anyFailure = true;
        }
        // A skipped unsafe path is data pullProject already collected but the
        // user never saw — report it here, without aborting the loop (same
        // treatment as the failed / not-fast-forward branches above).
        for (const skipped of result.skippedUnsafe) {
          console.error(`${key}: skipped unsafe path ${skipped}`);
        }
        console.log(`${key}: ${result.changedFiles.length} file(s) ${opts.dryRun ? "would change" : "changed"}`);
      }
    }
    if (anyFailure) {
      process.exitCode = 1;
    }
    return;
  }
  const projectKey = opts.projectKeyOverride ?? resolveProjectKeyForDir(opts.projectDir);
  const result = await pullProject(deps, opts.projectDir, projectKey, { dryRun: opts.dryRun });
  if (!result.fastForward) {
    console.error("pull rejected: local clone is not fast-forward with the remote");
    process.exitCode = 1;
    return;
  }
  for (const skipped of result.skippedUnsafe) {
    console.error(`${projectKey}: skipped unsafe path ${skipped}`);
  }
  if (result.skippedUnsafe.length > 0) {
    process.exitCode = 1;
  }
  console.log(`${projectKey}: ${result.changedFiles.length} file(s) ${opts.dryRun ? "would change" : "changed"}`);
}
