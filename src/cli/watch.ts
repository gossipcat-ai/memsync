import { watch as chokidarWatchReal } from "chokidar";
import type { SyncEngineDeps } from "../sync-engine/push.js";
import { pushAllRegistered as pushAllRegisteredReal } from "../sync-engine/push.js";
import { loadRegistry } from "../registry.js";

export interface StartWatchOptions {
  chokidarWatch?: typeof chokidarWatchReal;
  debounceMs?: number;
  pushAllRegisteredFn?: typeof pushAllRegisteredReal;
}

export function startWatch(deps: SyncEngineDeps, opts: StartWatchOptions = {}): { stop(): void } {
  const watchFn = opts.chokidarWatch ?? chokidarWatchReal;
  const debounceMs = opts.debounceMs ?? 2000;
  const pushAll = opts.pushAllRegisteredFn ?? pushAllRegisteredReal;

  const registry = loadRegistry(deps.registryPath);
  const paths = Object.values(registry).map((entry) => entry.absolutePath);
  const watcher = watchFn(paths, { ignoreInitial: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // pushAllRegistered isolates per-project failures (including a genuine
      // non-fast-forward conflict) into resolved Map entries, so it never
      // rejects for those — inspecting the Map is the only way `watch` can
      // leave the visible warning the spec requires instead of retrying
      // silently. The .catch below remains as a last-resort guard for a
      // genuinely unexpected top-level rejection (e.g. a corrupt registry).
      pushAll(deps)
        .then((results) => {
          for (const [key, result] of results) {
            if ("failed" in result) {
              console.error(`watch: push failed for ${key} — ${result.error}`);
            }
          }
        })
        .catch((err) => console.error("watch: push failed", err));
    }, debounceMs);
  };

  watcher.on("change", trigger);
  watcher.on("add", trigger);
  watcher.on("unlink", trigger);

  return {
    stop() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

export function generateInstallInstructions(
  platform: NodeJS.Platform,
): { ok: true; script: string } | { ok: false; reason: string } {
  if (platform === "darwin") {
    return {
      ok: true,
      script:
        "launchctl load -w ~/Library/LaunchAgents/com.memsync.watch.plist  # generate this plist to run `memsync watch` at login",
    };
  }
  if (platform === "linux") {
    return { ok: true, script: "(crontab -l 2>/dev/null; echo '@reboot memsync watch') | crontab -" };
  }
  return { ok: false, reason: "memsync watch --install is not supported on Windows in v1" };
}
