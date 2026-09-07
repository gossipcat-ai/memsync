import type { Detector, GitRemoteBackend } from "../types.js";

export interface RunDoctorDeps {
  detectors: Detector[];
  homeDir: string;
  projectDir: string;
  backend: GitRemoteBackend;
}

export async function runDoctor(deps: RunDoctorDeps): Promise<{
  toolReport: { tool: string; relativeKeyPath: string; exists: boolean; scope: "project" | "global" }[];
  visibility: "private" | "public" | "unknown";
}> {
  const toolReport: { tool: string; relativeKeyPath: string; exists: boolean; scope: "project" | "global" }[] = [];
  for (const detector of deps.detectors) {
    for (const ref of detector.findProjectFiles(deps.projectDir, deps.homeDir)) {
      toolReport.push({ tool: detector.name, relativeKeyPath: ref.relativeKeyPath, exists: ref.exists, scope: "project" });
    }
    for (const ref of detector.findGlobalFiles(deps.homeDir)) {
      toolReport.push({ tool: detector.name, relativeKeyPath: ref.relativeKeyPath, exists: ref.exists, scope: "global" });
    }
  }
  const visibility = await deps.backend.checkVisibility();
  return { toolReport, visibility };
}
