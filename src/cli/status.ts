import { loadRegistry } from "../registry.js";

export function runStatus(registryPath: string): { projectKey: string; absolutePath: string; lastSyncedAt: string }[] {
  const registry = loadRegistry(registryPath);
  return Object.entries(registry).map(([projectKey, entry]) => ({ projectKey, ...entry }));
}
