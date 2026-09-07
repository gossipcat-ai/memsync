import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig, saveMachineConfig } from "../src/machine-config.js";

describe("machine-config", () => {
  it("returns {} when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cfg-"));
    try {
      expect(loadMachineConfig(join(dir, "config.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips gistId through save/load", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cfg-"));
    try {
      const path = join(dir, "config.json");
      saveMachineConfig(path, { gistId: "abc123" });
      expect(loadMachineConfig(path)).toEqual({ gistId: "abc123" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveMachineConfig corrects permissions back to 0600 on a file that already has wider permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cfg-"));
    try {
      const path = join(dir, "config.json");
      // Simulate a pre-existing config file with overly-permissive mode
      // (e.g. created by a different umask or hand-edited).
      writeFileSync(path, "{}");
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);

      saveMachineConfig(path, { gistId: "abc123" });

      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveMachineConfig creates the parent directory if it does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-cfg-"));
    try {
      const path = join(dir, "nested", "does", "not", "exist", "config.json");
      expect(() => saveMachineConfig(path, { gistId: "abc123" })).not.toThrow();
      expect(existsSync(path)).toBe(true);
      expect(loadMachineConfig(path)).toEqual({ gistId: "abc123" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
