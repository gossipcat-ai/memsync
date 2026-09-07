import { describe, it, expect, vi } from "vitest";
import { selectGistInteractively } from "../../src/cli/gist-picker.js";
import type { GistSummary } from "../../src/backends/gist-backend.js";

const gists: GistSummary[] = [
  { id: "firstgist", description: "memsync agent memory store", updatedAt: "2026-09-07T20:00:00Z" },
  { id: "secondgist", description: "memsync agent memory store", updatedAt: "2026-09-06T20:00:00Z" },
];

describe("selectGistInteractively", () => {
  it("returns the id of the gist at the picked 1-based index", async () => {
    const promptFn = vi.fn(async () => "2");
    const result = await selectGistInteractively(gists, promptFn);
    expect(result).toBe("secondgist");
    expect(promptFn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and does not throw on an out-of-range answer", async () => {
    const promptFn = vi.fn(async () => "99");
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: string) => {
      errs.push(msg);
    });
    const result = await selectGistInteractively(gists, promptFn);
    expect(result).toBeUndefined();
    expect(errs.some((l) => l.includes("Invalid selection"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("returns undefined and does not throw on a non-numeric answer", async () => {
    const promptFn = vi.fn(async () => "not-a-number");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await selectGistInteractively(gists, promptFn);
    expect(result).toBeUndefined();
    vi.restoreAllMocks();
  });
});
