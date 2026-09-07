import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMdDetector } from "../../src/detectors/agents-md.js";

describe("agentsMdDetector.findProjectFiles", () => {
  it("returns AGENTS.md as exists:true when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "instructions");
      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        { absolutePath: join(dir, "AGENTS.md"), relativeKeyPath: "agents-md/AGENTS.md", exists: true },
      ]);

      expect(agentsMdDetector.resolveLocalPath("agents-md/AGENTS.md", dir, "/unused/home", "project")).toBe(
        join(dir, "AGENTS.md"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns AGENTS.md as exists:false when absent (no separate config dir to gate on)", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    try {
      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");
      expect(refs).toEqual([
        { absolutePath: join(dir, "AGENTS.md"), relativeKeyPath: "agents-md/AGENTS.md", exists: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findGlobalFiles returns an empty array (no documented AGENTS.md global memory)", () => {
    expect(agentsMdDetector.findGlobalFiles("/any/home")).toEqual([]);
  });
});

describe("agentsMdDetector.resolveLocalPath scope isolation", () => {
  // TypeScript's structural typing cannot force a Detector implementation to actually
  // consult its `scope` argument, so this rejection is only guarded by a test.
  // AGENTS.md's findGlobalFiles always returns [], so it owns no key under the gist's
  // `global/` prefix — a global-scope entry must never resolve to a real project file.
  it("rejects a project-scope key presented in global scope", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-agents-md-scope-"));
    try {
      expect(() =>
        agentsMdDetector.resolveLocalPath("agents-md/AGENTS.md", projectDir, "/unused/home", "global"),
      ).toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("agentsMdDetector nested AGENTS.md discovery", () => {
  it("discovers a nested AGENTS.md one level deep with the correct key, and round-trips via resolveLocalPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    try {
      mkdirSync(join(dir, "packages", "api"), { recursive: true });
      writeFileSync(join(dir, "packages", "api", "AGENTS.md"), "api instructions");

      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");
      const nested = refs.find((r) => r.relativeKeyPath === "agents-md/nested/packages/api/AGENTS.md");
      expect(nested).toEqual({
        absolutePath: join(dir, "packages", "api", "AGENTS.md"),
        relativeKeyPath: "agents-md/nested/packages/api/AGENTS.md",
        exists: true,
      });

      expect(
        agentsMdDetector.resolveLocalPath(
          "agents-md/nested/packages/api/AGENTS.md",
          dir,
          "/unused/home",
          "project",
        ),
      ).toBe(join(dir, "packages", "api", "AGENTS.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers a nested AGENTS.md 2+ levels deep", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    try {
      mkdirSync(join(dir, "packages", "web", "src", "widgets"), { recursive: true });
      writeFileSync(join(dir, "packages", "web", "src", "widgets", "AGENTS.md"), "widget instructions");

      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");
      const key = "agents-md/nested/packages/web/src/widgets/AGENTS.md";
      const nested = refs.find((r) => r.relativeKeyPath === key);
      expect(nested).toEqual({
        absolutePath: join(dir, "packages", "web", "src", "widgets", "AGENTS.md"),
        relativeKeyPath: key,
        exists: true,
      });

      expect(agentsMdDetector.resolveLocalPath(key, dir, "/unused/home", "project")).toBe(
        join(dir, "packages", "web", "src", "widgets", "AGENTS.md"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers multiple nested AGENTS.md files in different subdirectories alongside the root, with no duplication or key collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "root instructions");
      mkdirSync(join(dir, "packages", "api"), { recursive: true });
      mkdirSync(join(dir, "packages", "web"), { recursive: true });
      writeFileSync(join(dir, "packages", "api", "AGENTS.md"), "api instructions");
      writeFileSync(join(dir, "packages", "web", "AGENTS.md"), "web instructions");

      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");
      const keys = refs.map((r) => r.relativeKeyPath);

      expect(keys).toContain("agents-md/AGENTS.md");
      expect(keys).toContain("agents-md/nested/packages/api/AGENTS.md");
      expect(keys).toContain("agents-md/nested/packages/web/AGENTS.md");

      // no duplicates, and root key doesn't collide with nested keys
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.filter((k) => k === "agents-md/AGENTS.md")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recurse into excluded directories such as node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    try {
      mkdirSync(join(dir, "node_modules", "some-package"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "some-package", "AGENTS.md"), "should not be found");

      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");
      expect(refs.some((r) => r.relativeKeyPath.includes("node_modules"))).toBe(false);
      expect(refs.some((r) => r.absolutePath.includes("node_modules"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked subdirectory containing an AGENTS.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    let outsideDir = "";
    try {
      mkdirSync(join(dir, "packages"), { recursive: true });
      outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-dir-"));
      writeFileSync(join(outsideDir, "AGENTS.md"), "should not be picked up");
      symlinkSync(outsideDir, join(dir, "packages", "linked"), "dir");

      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.some((r) => r.relativeKeyPath.includes("linked"))).toBe(false);
      expect(refs.some((r) => r.absolutePath === join(outsideDir, "AGENTS.md"))).toBe(false);
    } finally {
      if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pick up a symlinked AGENTS.md file directly under a real subdirectory", () => {
    const dir = mkdtempSync(join(tmpdir(), "memsync-agents-md-"));
    let outsideDir = "";
    try {
      mkdirSync(join(dir, "packages", "api"), { recursive: true });
      outsideDir = mkdtempSync(join(tmpdir(), "memsync-outside-file-"));
      const outsideFile = join(outsideDir, "real_AGENTS.md");
      writeFileSync(outsideFile, "outside content");
      symlinkSync(outsideFile, join(dir, "packages", "api", "AGENTS.md"), "file");

      const refs = agentsMdDetector.findProjectFiles(dir, "/unused/home");

      expect(refs.some((r) => r.relativeKeyPath === "agents-md/nested/packages/api/AGENTS.md")).toBe(false);
    } finally {
      if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
