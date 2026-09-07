import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";

// Everything the vi.mock factory below needs must come from vi.hoisted:
// vi.mock calls are hoisted above regular statements (including imports'
// evaluated bodies), so a plain module-scope const/function declared later
// in this file is not yet initialized when the factory closes over it.
//
// Mocks the exact same node:child_process.execFile that GistBackend's
// `realExec` wraps with `promisify`, so `memsync setup` / `memsync clone`
// exercise the real GistBackend/runInit/runPush/runPull code paths without
// ever shelling out to a real `gh` or `git`. Scoped to this file only —
// other CLI tests (e.g. push-pull.test.ts) rely on LocalBareGitBackend
// actually invoking real git via the same execFile, so this mock must not
// leak module-wide.
const { execCalls, fakeExecFile } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");

  const execCalls: { cmd: string; args: string[] }[] = [];

  function fakeExecFile(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    execCalls.push({ cmd, args });

    if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
      return Promise.resolve({ stdout: "https://gist.github.com/testuser/abc123def456\n", stderr: "" });
    }
    if (cmd === "git" && args[0] === "clone") {
      // args: ["clone", <url>, <destPath>]
      const dest = args[2];
      fs.mkdirSync(dest, { recursive: true });
      // Seed a flat gist file so a subsequent pull has real content to
      // restore — matches clone-writer.ts's `global/claude/CLAUDE.md` ->
      // `global%2Fclaude%2FCLAUDE.md` flattening.
      fs.writeFileSync(path.join(dest, "global%2Fclaude%2FCLAUDE.md"), "gist content");
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      return Promise.resolve({ stdout: "deadbeef\n", stderr: "" });
    }
    if (cmd === "git" && args[0] === "status") {
      return Promise.resolve({ stdout: "M placeholder\n", stderr: "" });
    }
    // git fetch / merge --ff-only / add -A / commit / push / remote set-url,
    // and `gh api gists/<id> --jq .public` (checkVisibility) all just need
    // to succeed with no interesting stdout for these tests.
    return Promise.resolve({ stdout: "", stderr: "" });
  }

  return { execCalls, fakeExecFile };
});

// Node's real `child_process.execFile` carries a `util.promisify.custom`
// implementation that resolves to `{ stdout, stderr }` (not just the first
// callback arg) — `promisify(execFile)` in gist-backend.ts relies on that.
// A plain callback-shaped mock without the custom symbol would instead
// resolve to just `stdout` under generic promisify semantics, so the custom
// symbol is replicated here too.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = (
    cmd: string,
    args: string[],
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    // Nothing in this codebase calls execFile directly (only via
    // promisify), but implement the callback shape anyway for safety.
    fakeExecFile(cmd, args)
      .then((r) => callback?.(null, r.stdout, r.stderr))
      .catch((e) => callback?.(e as Error, "", ""));
  };
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (cmd: string, args: string[]) =>
    fakeExecFile(cmd, args);
  return { execFile };
});

describe("memsync setup / clone", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  let projectDir: string;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    execCalls.length = 0;
  });

  it("`memsync setup` creates a new gist, then pushes", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "memsync-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    process.env.HOME = tempHome;
    // Give the push step something real to find and send.
    writeFileSync(join(tempHome, "CLAUDE.md"), "hello");

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await buildProgram().parseAsync(["node", "memsync", "setup"]);

    expect(
      execCalls.some((c) => c.cmd === "gh" && c.args[0] === "gist" && c.args[1] === "create"),
    ).toBe(true);

    const gistLineIdx = logs.findIndex((l) => l.startsWith("Gist URL:"));
    const pushLineIdx = logs.findIndex((l) => /^pushed .+: \d+ file\(s\)$/.test(l));
    expect(gistLineIdx).toBeGreaterThanOrEqual(0);
    expect(pushLineIdx).toBeGreaterThan(gistLineIdx);

    cwdSpy.mockRestore();
  });

  it("`memsync clone <id>` attaches to an existing gist (no gist create) and pulls", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "memsync-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    process.env.HOME = tempHome;

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await buildProgram().parseAsync(["node", "memsync", "clone", "abc123def456"]);

    expect(
      execCalls.some((c) => c.cmd === "gh" && c.args[0] === "gist" && c.args[1] === "create"),
    ).toBe(false);
    expect(logs.some((l) => l.includes("memsync attached to gist abc123def456"))).toBe(true);

    // The pull actually happened: the seeded gist content landed on disk.
    expect(readFileSync(join(tempHome, "CLAUDE.md"), "utf8")).toBe("gist content");
    expect(logs.some((l) => /: \d+ file\(s\) changed$/.test(l))).toBe(true);

    cwdSpy.mockRestore();
  });
});
