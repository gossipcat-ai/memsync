import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MachineConfig {
  gistId?: string;
}

export function loadMachineConfig(configPath: string): MachineConfig {
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as MachineConfig;
}

export function saveMachineConfig(configPath: string, config: MachineConfig): void {
  // The parent directory (e.g. ~/.memsync/) may not exist yet on first use.
  mkdirSync(dirname(configPath), { recursive: true });
  // `mode` on writeFileSync only applies when the file is newly created
  // (subject to umask); it has no effect if the file already exists with
  // different permissions. Since this config can contain a gist id tied to
  // the user's identity, explicitly chmod after write to guarantee 0600
  // regardless of umask or prior file state.
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
}
