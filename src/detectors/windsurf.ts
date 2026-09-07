import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector, FileRef } from "../types.js";

export const windsurfDetector: Detector = {
  name: "windsurf",

  findProjectFiles(projectDir: string, _homeDir: string): FileRef[] {
    const rulesFile = join(projectDir, ".windsurfrules");
    return [
      { absolutePath: rulesFile, relativeKeyPath: "windsurf/.windsurfrules", exists: existsSync(rulesFile) },
    ];
  },

  findGlobalFiles(_homeDir: string): FileRef[] {
    return [];
  },

  resolveLocalPath(
    relativeKeyPath: string,
    projectDir: string,
    _homeDir: string,
    scope: "project" | "global",
  ): string {
    // findGlobalFiles always returns [], so this detector never legitimately owns a
    // key under the gist's `global/` prefix — refuse to resolve one rather than
    // silently treating it as project-scoped.
    if (scope !== "project") {
      throw new Error(`windsurf detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`);
    }
    if (relativeKeyPath === "windsurf/.windsurfrules") {
      return join(projectDir, ".windsurfrules");
    }
    throw new Error(`windsurf detector cannot resolve local path for ${relativeKeyPath}`);
  },
};
