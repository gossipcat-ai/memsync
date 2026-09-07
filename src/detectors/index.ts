import type { Detector } from "../types.js";
import { claudeCodeDetector } from "./claude-code.js";
import { cursorDetector } from "./cursor.js";
import { windsurfDetector } from "./windsurf.js";

export const ALL_DETECTORS: Detector[] = [claudeCodeDetector, cursorDetector, windsurfDetector];
