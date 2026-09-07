import type { Detector, GitRemoteBackend } from "../types.js";

export interface RunDoctorDeps {
  detectors: Detector[];
  homeDir: string;
  projectDir: string;
  backend: GitRemoteBackend;
}

export async function runDoctor(deps: RunDoctorDeps): Promise<{
  toolReport: { tool: string; relativeKeyPath: string; exists: boolean }[];
  visibility: "private" | "public" | "unknown";
}> {
  const toolReport: { tool: string; relativeKeyPath: string; exists: boolean }[] = [];
  for (const detector of deps.detectors) {
    for (const ref of detector.findProjectFiles(deps.projectDir, deps.homeDir)) {
      toolReport.push({ tool: detector.name, relativeKeyPath: ref.relativeKeyPath, exists: ref.exists });
    }
  }
  const visibility = await deps.backend.checkVisibility();
  return { toolReport, visibility };
}
