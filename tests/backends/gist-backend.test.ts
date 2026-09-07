import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { GistBackend, listMyMemsyncGists } from "../../src/backends/gist-backend.js";

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

  it("rotate() creates a new gist, retargets the existing clone at it, force-pushes, and returns old+new ids", async () => {
    let createCallArgs: string[] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
        createCallArgs = args;
        return { stdout: "https://gist.github.com/user/abc456\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone-rotate", exec);
    await backend.initRemote("oldid123");

    const result = await backend.rotate();

    expect(result.oldGistId).toBe("oldid123");
    expect(result.newGistId).toBe("abc456");
    expect(backend.gistId).toBe("abc456");
    expect(createCallArgs).toEqual(expect.arrayContaining(["gist", "create"]));

    expect(exec).toHaveBeenCalledWith(
      "git",
      ["remote", "set-url", "origin", "https://gist.github.com/abc456.git"],
      { cwd: "/tmp/unused-clone-rotate" },
    );
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["push", "--force", "origin", "HEAD:main"],
      { cwd: "/tmp/unused-clone-rotate" },
    );
  });

  it("rotate() cleans up its throwaway placeholder file after creating the new gist", async () => {
    let capturedArgs: string[] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
        capturedArgs = args;
        return { stdout: "https://gist.github.com/user/abc456\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone-rotate-2", exec);
    await backend.initRemote("oldid123");
    await backend.rotate();

    const filePathArg = capturedArgs.find(
      (arg) => !arg.startsWith("-") && arg !== "gist" && arg !== "create" && arg !== "memsync agent memory store",
    );
    expect(typeof filePathArg).toBe("string");
    expect(existsSync(filePathArg as string)).toBe(false);
  });

  it("rotate() aborts and never creates a new gist when the local clone cannot be fast-forwarded to the current gist (stale local clone)", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "merge") {
        throw new Error("fatal: Not possible to fast-forward, aborting.");
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone-rotate-stale", exec);
    await backend.initRemote("oldid123");

    await expect(backend.rotate()).rejects.toThrow(/not up to date/);
    expect(backend.gistId).toBe("oldid123");

    const createCalls = exec.mock.calls.filter(
      ([cmd, args]) => cmd === "gh" && args[0] === "gist" && args[1] === "create",
    );
    expect(createCalls.length).toBe(0);
  });

  it("rotate() reverts origin back to the OLD gist's clone URL when force-push fails after set-url already succeeded, and rethrows the original error", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
        return { stdout: "https://gist.github.com/user/abc456\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push" && args[1] === "--force") {
        throw new Error(
          "fatal: unable to access 'https://gist.github.com/abc456.git/': Could not resolve host: gist.github.com",
        );
      }
      return { stdout: "", stderr: "" };
    });
    const backend = new GistBackend("/tmp/unused-clone-rotate-revert", exec);
    await backend.initRemote("oldid123");

    await expect(backend.rotate()).rejects.toThrow(/Could not resolve host/);

    // gistId was never advanced past the old id, matching config.json (which the
    // CLI layer only writes after rotate() resolves successfully).
    expect(backend.gistId).toBe("oldid123");

    const setUrlCalls = exec.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args[0] === "remote" && args[1] === "set-url",
    );
    expect(setUrlCalls.length).toBe(2);
    expect(setUrlCalls[0][1]).toEqual(["remote", "set-url", "origin", "https://gist.github.com/abc456.git"]);
    expect(setUrlCalls[1][1]).toEqual(["remote", "set-url", "origin", "https://gist.github.com/oldid123.git"]);
    expect(setUrlCalls[1][2]).toEqual({ cwd: "/tmp/unused-clone-rotate-revert" });
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

describe("listMyMemsyncGists", () => {
  it("returns only memsync-managed gists, sorted most-recently-updated first", async () => {
    const stdout = [
      JSON.stringify({ description: "memsync agent memory store", id: "8dc98d448007b4675804c253acb120e4", updated_at: "2026-09-07T16:43:31Z" }),
      JSON.stringify({ description: "some other unrelated gist", id: "unrelated1", updated_at: "2026-09-08T00:00:00Z" }),
      JSON.stringify({ description: "memsync agent memory store", id: "olderGistId0000000000000000000000", updated_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ description: "memsync agent memory store", id: "newestGistId000000000000000000000", updated_at: "2026-09-07T20:00:00Z" }),
    ].join("\n");
    const exec = vi.fn(async () => ({ stdout, stderr: "" }));

    const result = await listMyMemsyncGists(exec);

    expect(exec).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "gists",
        "--paginate",
        "--jq",
        ".[] | {id: .id, description: .description, updated_at: .updated_at}",
      ],
    );
    expect(result).toEqual([
      { id: "newestGistId000000000000000000000", description: "memsync agent memory store", updatedAt: "2026-09-07T20:00:00Z" },
      { id: "8dc98d448007b4675804c253acb120e4", description: "memsync agent memory store", updatedAt: "2026-09-07T16:43:31Z" },
      { id: "olderGistId0000000000000000000000", description: "memsync agent memory store", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("returns an empty array when the user has no memsync gists", async () => {
    const stdout = [
      JSON.stringify({ description: "some other unrelated gist", id: "unrelated1", updated_at: "2026-09-08T00:00:00Z" }),
    ].join("\n");
    const exec = vi.fn(async () => ({ stdout, stderr: "" }));

    const result = await listMyMemsyncGists(exec);
    expect(result).toEqual([]);
  });

  it("skips a malformed/partial JSON line instead of crashing the whole lookup", async () => {
    const stdout = [
      JSON.stringify({ description: "memsync agent memory store", id: "goodgist1", updated_at: "2026-09-07T16:43:31Z" }),
      "{not valid json",
      "",
      JSON.stringify({ description: "memsync agent memory store", id: "goodgist2", updated_at: "2026-09-06T00:00:00Z" }),
    ].join("\n");
    const exec = vi.fn(async () => ({ stdout, stderr: "" }));

    const result = await listMyMemsyncGists(exec);
    expect(result).toEqual([
      { id: "goodgist1", description: "memsync agent memory store", updatedAt: "2026-09-07T16:43:31Z" },
      { id: "goodgist2", description: "memsync agent memory store", updatedAt: "2026-09-06T00:00:00Z" },
    ]);
  });
});
