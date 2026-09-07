import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GistBackend, extractGistId, listMyMemsyncGists } from "../backends/gist-backend.js";
import { selectGistInteractively } from "./gist-picker.js";
import { loadMachineConfig } from "../machine-config.js";
import { ALL_DETECTORS } from "../detectors/index.js";
import { runInit } from "./init.js";
import { runPush } from "./push.js";
import { runPull } from "./pull.js";
import { runStatus } from "./status.js";
import { runDoctor } from "./doctor.js";
import { runRotate } from "./rotate.js";
import { startWatch, generateInstallInstructions } from "./watch.js";
import type { SyncEngineDeps } from "../sync-engine/push.js";

// package.json sits two directories above this file's compiled location
// (dist/cli/program.js -> ../../package.json), and one directory above the
// source location during ts-node/tsx dev runs is not relied upon — only the
// compiled dist/ layout matters since that's what actually ships and runs.
function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  return version;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("memsync")
    .description("Sync AI coding agent memory across machines via a private Gist")
    .version(readPackageVersion());

  program
    .command("init")
    .option("--gist <idOrUrl>", "attach to an existing gist instead of creating a new one")
    .action(async (options: { gist?: string }) => {
      const home = join(homedir(), ".memsync");
      const existingGistId = options.gist ? extractGistId(options.gist) : undefined;
      const result = await runInit({
        homeDir: home,
        clonePath: join(home, "repo"),
        projectDir: process.cwd(),
        existingGistId,
        backendFactory: (clonePath) => new GistBackend(clonePath),
      });
      if (result.gistId) {
        console.log(`Gist URL: https://gist.github.com/${result.gistId}`);
      }
      console.log(
        "memsync initialized. Keep the gist URL safe — it's the only thing you need to restore on another machine.",
      );
      console.log(
        "NOTE: the gist is private (unlisted), not access-controlled — anyone with the URL can read it, and its git history is permanent even if you later remove a file.",
      );
    });

  program.command("setup").action(async () => {
    const home = join(homedir(), ".memsync");
    const initResult = await runInit({
      homeDir: home,
      clonePath: join(home, "repo"),
      projectDir: process.cwd(),
      existingGistId: undefined,
      backendFactory: (clonePath) => new GistBackend(clonePath),
    });
    if (initResult.gistId) {
      console.log(`Gist URL: https://gist.github.com/${initResult.gistId}`);
    }
    console.log(
      "memsync initialized. Keep the gist URL safe — it's the only thing you need to restore on another machine.",
    );
    console.log(
      "NOTE: the gist is private (unlisted), not access-controlled — anyone with the URL can read it, and its git history is permanent even if you later remove a file.",
    );
    await runPush(buildSyncEngineDeps(), { projectDir: process.cwd() });
  });

  program
    .command("clone [gistIdOrUrl]")
    .action(async (gistIdOrUrl?: string) => {
      const home = join(homedir(), ".memsync");
      let existingGistId: string;
      if (gistIdOrUrl) {
        existingGistId = extractGistId(gistIdOrUrl);
      } else {
        const gists = await listMyMemsyncGists();
        if (gists.length === 0) {
          console.error(
            "No memsync gists found on your GitHub account. Run `memsync setup` on another machine first, or pass a gist id/URL directly: `memsync clone <id-or-url>`.",
          );
          process.exitCode = 1;
          return;
        } else if (gists.length === 1) {
          existingGistId = gists[0].id;
          console.log(`Found one memsync gist, attaching to it: https://gist.github.com/${existingGistId}`);
        } else {
          const selected = await selectGistInteractively(gists);
          if (!selected) {
            process.exitCode = 1;
            return;
          }
          existingGistId = selected;
        }
      }
      await runInit({
        homeDir: home,
        clonePath: join(home, "repo"),
        projectDir: process.cwd(),
        existingGistId,
        backendFactory: (clonePath) => new GistBackend(clonePath),
      });
      console.log(`memsync attached to gist ${existingGistId}.`);
      console.log(
        "NOTE: the gist is private (unlisted), not access-controlled — anyone with the URL can read it, and its git history is permanent even if you later remove a file.",
      );
      await runPull(buildSyncEngineDeps(), { projectDir: process.cwd() });
    });

  function buildSyncEngineDeps(): SyncEngineDeps {
    const home = join(homedir(), ".memsync");
    const { gistId } = loadMachineConfig(join(home, "config.json"));
    const clonePath = join(home, "repo");
    const backend = new GistBackend(clonePath);
    if (gistId) {
      void backend.initRemote(gistId);
    }
    return {
      backend,
      detectors: ALL_DETECTORS,
      homeDir: homedir(),
      registryPath: join(home, "registry.json"),
      lockPath: join(home, "repo.lock"),
    };
  }

  program
    .command("push")
    .option("--all", "push every project in the local registry")
    .option("--project-key <key>", "use this projectKey instead of resolving it from cwd")
    .action(async (options: { all?: boolean; projectKey?: string }) => {
      await runPush(buildSyncEngineDeps(), {
        projectDir: process.cwd(),
        all: options.all,
        projectKeyOverride: options.projectKey,
      });
    });

  program
    .command("pull")
    .option("--all", "pull every project in the local registry")
    .option("--dry-run", "show what would change without writing anything")
    .option("--project-key <key>", "use this projectKey instead of resolving it from cwd")
    .action(async (options: { all?: boolean; dryRun?: boolean; projectKey?: string }) => {
      await runPull(buildSyncEngineDeps(), {
        projectDir: process.cwd(),
        all: options.all,
        dryRun: options.dryRun,
        projectKeyOverride: options.projectKey,
      });
    });

  program
    .command("status")
    .option("--json", "output as JSON")
    .action((options: { json?: boolean }) => {
      const home = join(homedir(), ".memsync");
      const rows = runStatus(join(home, "registry.json"));
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(`${row.projectKey}\t${row.absolutePath}\tlast synced ${row.lastSyncedAt}`);
      }
    });

  program
    .command("doctor")
    .option("--json", "output as JSON")
    .action(async (options: { json?: boolean }) => {
      const deps = buildSyncEngineDeps();
      const report = await runDoctor({
        detectors: deps.detectors,
        homeDir: deps.homeDir,
        projectDir: process.cwd(),
        backend: deps.backend,
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const row of report.toolReport) {
          console.log(`${row.tool} [${row.scope}]: ${row.relativeKeyPath} — ${row.exists ? "found" : "expected, not found"}`);
        }
        console.log(`remote visibility: ${report.visibility}`);
      }
      if (report.visibility === "public") {
        console.error("WARNING: the backing gist is public — your agent memory is world-readable.");
      }
    });

  program.command("rotate").action(async () => {
    const deps = buildSyncEngineDeps();
    const home = join(homedir(), ".memsync");
    const result = await runRotate({ homeDir: home, backend: deps.backend as GistBackend });
    console.log(`Rotated to a new gist: https://gist.github.com/${result.newGistId}`);
    console.log(
      `The old gist${result.oldGistId ? ` (https://gist.github.com/${result.oldGistId})` : ""} still exists ` +
        `with your previous data and was NOT deleted automatically.`,
    );
    console.log(
      "On every OTHER machine you use, run `memsync init --gist " + result.newGistId + "` to switch it over too.",
    );
    console.log(
      "Once every machine has switched, delete the old gist yourself" +
        (result.oldGistId ? ` (\`gh gist delete ${result.oldGistId}\`)` : "") + " if you no longer need it.",
    );
  });

  program
    .command("watch")
    .option("--install", "register memsync watch to run automatically (macOS/Linux only)")
    .action((options: { install?: boolean }) => {
      if (options.install) {
        const result = generateInstallInstructions(process.platform);
        if (!result.ok) {
          console.error(result.reason);
          process.exitCode = 1;
          return;
        }
        console.log(result.script);
        return;
      }
      console.log("watching registered projects for changes (Ctrl+C to stop)...");
      startWatch(buildSyncEngineDeps());
    });

  return program;
}
