import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRotate } from "../../src/cli/rotate.js";
import { GistBackend } from "../../src/backends/gist-backend.js";
import { loadMachineConfig } from "../../src/machine-config.js";

describe("runRotate", () => {
  it("calls backend.rotate() and persists the newly created gist id to machine-config.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const clonePath = join(home, "repo");
    try {
      const exec = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "gist" && args[1] === "create") {
          return { stdout: "https://gist.github.com/user/abc456\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const backend = new GistBackend(clonePath, exec);
      await backend.initRemote("oldid123");

      const result = await runRotate({ homeDir: home, backend });

      expect(result.newGistId).toBe("abc456");
      expect(result.oldGistId).toBe("oldid123");
      expect(loadMachineConfig(join(home, "config.json")).gistId).toBe("abc456");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
