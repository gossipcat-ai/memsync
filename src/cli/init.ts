import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRemoteBackend } from "../types.js";
import { loadMachineConfig, saveMachineConfig } from "../machine-config.js";
import { DEFAULT_IGNORE_PATTERNS } from "../ignore.js";

export interface RunInitOptions {
  homeDir: string;
  clonePath: string;
  projectDir: string;
  existingGistId?: string;
  backendFactory: (clonePath: string) => GitRemoteBackend;
}

export async function runInit(opts: RunInitOptions): Promise<{ gistId: string | undefined }> {
  const backend = opts.backendFactory(opts.clonePath);
  await backend.initRemote(opts.existingGistId);
  await backend.ensureLocalClone();

  const gistId = (backend as { gistId?: string }).gistId;
  const configPath = join(opts.homeDir, "config.json");
  saveMachineConfig(configPath, { ...loadMachineConfig(configPath), gistId });

  const ignorePath = join(opts.projectDir, ".memsyncignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, DEFAULT_IGNORE_PATTERNS.join("\n") + "\n");
  }

  return { gistId };
}
