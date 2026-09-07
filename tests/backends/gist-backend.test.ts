import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { GistBackend } from "../../src/backends/gist-backend.js";

describe("GistBackend", () => {
  it("initRemote without existingId creates a new gist via `gh gist create` and stores its id", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
        return { stdout: "https://gist.github.com/user/abc123\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote();
    expect(backend.gistId).toBe("abc123");
    expect(exec).toHaveBeenCalledWith("gh", expect.arrayContaining(["gist", "create"]), expect.anything());
  });

  it("initRemote with existingId does not call `gh gist create`", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");
    expect(backend.gistId).toBe("abc123");
    expect(exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["gist", "create"]), expect.anything());
  });

  it("checkVisibility maps gh's public field to 'private'/'public'", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes("--jq")) {
        return { stdout: "false\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");
    expect(await backend.checkVisibility()).toBe("private");
  });

  it("push runs fetch+merge --ff-only before push, and throws on merge failure instead of falling back to a plain merge", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "merge") {
        throw new Error("not a fast-forward");
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");
    await expect(backend.push()).rejects.toThrow();
    const mergeCalls = exec.mock.calls.filter(([cmd, args]) => cmd === "git" && args[0] === "merge");
    expect(mergeCalls[0][1]).toEqual(expect.arrayContaining(["--ff-only"]));
  });

  it("push merges --ff-only BEFORE committing, so a rejected push leaves no local commit behind", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "merge") {
        throw new Error("fatal: Not possible to fast-forward, aborting.");
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M acme%2Fwidgets%2Fmeta.json\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");

    await expect(backend.push()).rejects.toThrow(
      "push rejected: local clone is not fast-forward with origin/main",
    );

    const gitArgs = exec.mock.calls.filter(([cmd]) => cmd === "git").map(([, args]) => args[0]);
    expect(gitArgs).not.toContain("commit");
    expect(gitArgs.indexOf("merge")).toBeLessThan(gitArgs.length);
    expect(gitArgs.indexOf("fetch")).toBeLessThan(gitArgs.indexOf("merge"));
  });

  it("push commits and pushes after a successful fast-forward merge", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M acme%2Fwidgets%2Fmeta.json\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");
    await backend.push();

    const gitArgs = exec.mock.calls.filter(([cmd]) => cmd === "git").map(([, args]) => args[0]);
    expect(gitArgs).toEqual(["fetch", "merge", "add", "status", "commit", "push"]);
  });

  it("resets the clone back to origin when the REMOTE rejects the push, so the just-created local commit is not left orphaned", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M acme%2Fwidgets%2Fmeta.json\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        throw new Error("! [rejected] main -> main (fetch first)");
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");

    await expect(backend.push()).rejects.toThrow(/another machine pushed first/);

    const gitCommands = exec.mock.calls
      .filter(([cmd]) => cmd === "git")
      .map(([, args]) => args.join(" "));
    // The rollback must re-fetch first, so `reset --hard` lands on where origin
    // actually is NOW rather than a stale remote-tracking ref.
    expect(gitCommands).toEqual([
      "fetch origin",
      "merge --ff-only origin/main",
      "add -A",
      "status --porcelain",
      "commit -m memsync: sync",
      "push origin main",
      "fetch origin",
      "reset --hard origin/main",
    ]);
  });

  it("rolls back on a rejected push even under a non-English git locale, where stderr never contains the literal string \"[rejected]\", by relying on exit code 1", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M acme%2Fwidgets%2Fmeta.json\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        throw Object.assign(new Error("! [zurückgewiesen] main -> main (fetch first)"), { code: 1 });
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");

    await expect(backend.push()).rejects.toThrow(/another machine pushed first/);

    const gitCommands = exec.mock.calls
      .filter(([cmd]) => cmd === "git")
      .map(([, args]) => args.join(" "));
    expect(gitCommands).toEqual([
      "fetch origin",
      "merge --ff-only origin/main",
      "add -A",
      "status --porcelain",
      "commit -m memsync: sync",
      "push origin main",
      "fetch origin",
      "reset --hard origin/main",
    ]);
  });

  it("does NOT report a conflict and does NOT roll back when the push fails for a non-conflict reason (e.g. broken auth)", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M acme%2Fwidgets%2Fmeta.json\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        throw new Error(
          "fatal: could not read Username for 'https://gist.github.com': terminal prompts disabled",
        );
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");

    let caught: unknown;
    try {
      await backend.push();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/could not read Username/);
    expect(message).not.toMatch(/another machine pushed first/);

    const gitCommands = exec.mock.calls
      .filter(([cmd]) => cmd === "git")
      .map(([, args]) => args.join(" "));
    // No rollback attempted, and no second fetch after the failed push: the
    // command sequence stops right at `push origin main`.
    expect(gitCommands).toEqual([
      "fetch origin",
      "merge --ff-only origin/main",
      "add -A",
      "status --porcelain",
      "commit -m memsync: sync",
      "push origin main",
    ]);
  });

  it("does not roll back on a network-style push failure either, and surfaces the underlying git error", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: " M acme%2Fwidgets%2Fmeta.json\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        throw new Error(
          "fatal: unable to access 'https://gist.github.com/abc123.git/': Could not resolve host: gist.github.com",
        );
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote("abc123");

    let caught: unknown;
    try {
      await backend.push();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/Could not resolve host/);
    expect(message).not.toMatch(/another machine pushed first/);

    const gitCommands = exec.mock.calls
      .filter(([cmd]) => cmd === "git")
      .map(([, args]) => args.join(" "));
    expect(gitCommands).not.toContain("reset --hard origin/main");
  });

  it("initRemote writes a throwaway placeholder file (gh gist create cannot create an empty gist) and cleans it up afterward", async () => {
    let capturedArgs: string[] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
        capturedArgs = args;
        return { stdout: "https://gist.github.com/user/abc123\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone", exec);
    await backend.initRemote();

    const filePathArg = capturedArgs.find(
      (arg) => !arg.startsWith("-") && arg !== "gist" && arg !== "create" && arg !== "memsync agent memory store",
    );
    expect(typeof filePathArg).toBe("string");
    expect(existsSync(filePathArg as string)).toBe(false);
  });
});
