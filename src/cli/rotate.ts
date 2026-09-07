import { join } from "node:path";
import type { GistBackend } from "../backends/gist-backend.js";
import { loadMachineConfig, saveMachineConfig } from "../machine-config.js";

export interface RunRotateOptions {
  homeDir: string;
  backend: GistBackend;
}

export async function runRotate(
  opts: RunRotateOptions,
): Promise<{ newGistId: string; oldGistId: string | undefined }> {
  const result = await opts.backend.rotate();
  const configPath = join(opts.homeDir, "config.json");
  saveMachineConfig(configPath, { ...loadMachineConfig(configPath), gistId: result.newGistId });
  return result;
}
