import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector, FileRef } from "../types.js";

export const copilotDetector: Detector = {
  name: "copilot",

  findProjectFiles(projectDir: string, _homeDir: string): FileRef[] {
    const instructionsFile = join(projectDir, ".github", "copilot-instructions.md");
    return [
      {
        absolutePath: instructionsFile,
        relativeKeyPath: "copilot/copilot-instructions.md",
        exists: existsSync(instructionsFile),
      },
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
      throw new Error(`copilot detector cannot resolve local path for ${relativeKeyPath} in scope ${scope}`);
    }
    if (relativeKeyPath === "copilot/copilot-instructions.md") {
      return join(projectDir, ".github", "copilot-instructions.md");
    }
    throw new Error(`copilot detector cannot resolve local path for ${relativeKeyPath}`);
  },
};
