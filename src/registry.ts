import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RegistryEntry {
  absolutePath: string;
  lastSyncedAt: string;
}

export type Registry = Record<string, RegistryEntry>;

export function loadRegistry(registryPath: string): Registry {
  if (!existsSync(registryPath)) {
    return {};
  }
  return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
}

export function saveRegistry(registryPath: string, registry: Registry): void {
  // The parent directory (e.g. ~/.memsync/) may not exist yet on first use.
  mkdirSync(dirname(registryPath), { recursive: true });
  // `mode` on writeFileSync only applies when the file is newly created
  // (subject to umask); it has no effect if the file already exists with
  // different permissions. Since this registry can contain absolute local
  // filesystem paths, explicitly chmod after write to guarantee 0600
  // regardless of umask or prior file state.
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
  chmodSync(registryPath, 0o600);
}

export function upsertRegistryEntry(
  registryPath: string,
  projectKey: string,
  absolutePath: string,
  now: () => string = () => new Date().toISOString(),
): void {
  const registry = loadRegistry(registryPath);
  registry[projectKey] = { absolutePath, lastSyncedAt: now() };
  saveRegistry(registryPath, registry);
}
