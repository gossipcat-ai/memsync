import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeKeyPath,
  UnsafePathError,
  resolveSafeAbsolutePath,
  resolveSafeAbsolutePathAnyRoot,
  resolveSafeAbsolutePathNoSymlinks,
  resolveSafeAbsolutePathNoSymlinksAnyRoot,
} from "../src/path-safety.js";

describe("assertSafeKeyPath", () => {
  it("accepts a normal relative key", () => {
    expect(() => assertSafeKeyPath("claude/MEMORY.md")).not.toThrow();
  });

  it("rejects a key containing ..", () => {
    expect(() => assertSafeKeyPath("../../etc/passwd")).toThrow(UnsafePathError);
  });

  it("rejects a key that is an absolute path", () => {
    expect(() => assertSafeKeyPath("/etc/passwd")).toThrow(UnsafePathError);
  });

  it("rejects a key with an embedded .. segment", () => {
    expect(() => assertSafeKeyPath("claude/../../secret")).toThrow(UnsafePathError);
  });

  it("rejects a Windows drive-relative traversal string", () => {
    expect(() => assertSafeKeyPath("C:foo\\..\\..\\secret")).toThrow(UnsafePathError);
  });

  it("rejects a bare Windows absolute path", () => {
    expect(() => assertSafeKeyPath("C:\\Users\\x")).toThrow(UnsafePathError);
  });

  it("rejects a backslash-separated traversal string on any platform", () => {
    expect(() => assertSafeKeyPath("..\\..\\etc\\passwd")).toThrow(UnsafePathError);
  });

  it("rejects a mixed-separator traversal", () => {
    expect(() => assertSafeKeyPath("claude/..\\secret")).toThrow(UnsafePathError);
  });

  // A trailing separator produces an empty final segment, which used to pass. That
  // made a key like "claude/memory/" resolve (via join(memoryDir, "")) to the memory
  // DIRECTORY itself rather than a file inside it — pull would then rename the user's
  // whole memory directory to .bak and write a regular file in its place.
  it("rejects a key with a trailing separator (empty final segment)", () => {
    expect(() => assertSafeKeyPath("claude/memory/")).toThrow(UnsafePathError);
    expect(() => assertSafeKeyPath("claude/memory\\")).toThrow(UnsafePathError);
  });

  it("rejects an empty key", () => {
    expect(() => assertSafeKeyPath("")).toThrow(UnsafePathError);
  });

  it("rejects a key containing a . segment", () => {
    expect(() => assertSafeKeyPath("claude/./MEMORY.md")).toThrow(UnsafePathError);
    expect(() => assertSafeKeyPath(".")).toThrow(UnsafePathError);
  });

  it("still accepts a legitimate nested detector key with a dotfile basename", () => {
    expect(() => assertSafeKeyPath("cursor/rules/.cursorrules")).not.toThrow();
    expect(() => assertSafeKeyPath("claude/memory/feedback_testing.md")).not.toThrow();
  });
});

describe("resolveSafeAbsolutePath", () => {
  it("returns the realpath when the file is a plain file inside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "memsync-safe-"));
    try {
      const file = join(root, "MEMORY.md");
      writeFileSync(file, "hello");
      expect(resolveSafeAbsolutePath(file, root)).toBe(realpathSync(file));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the leaf is a symlink escaping the root", () => {
    const root = mkdtempSync(join(tmpdir(), "memsync-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    try {
      const secret = join(outside, "secret");
      writeFileSync(secret, "top secret");
      const link = join(root, "MEMORY.md");
      symlinkSync(secret, link);
      expect(resolveSafeAbsolutePath(link, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns null when an intermediate directory segment is a symlink escaping the root", () => {
    const root = mkdtempSync(join(tmpdir(), "memsync-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    try {
      mkdirSync(join(outside, "real-project"));
      writeFileSync(join(outside, "real-project", "MEMORY.md"), "hi");
      const linkedDir = join(root, "project");
      symlinkSync(join(outside, "real-project"), linkedDir);
      const candidate = join(linkedDir, "MEMORY.md");
      expect(resolveSafeAbsolutePath(candidate, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns null when the candidate does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "memsync-safe-"));
    try {
      expect(resolveSafeAbsolutePath(join(root, "nope.md"), root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSafeAbsolutePathAnyRoot", () => {
  it("succeeds when the candidate is inside the second root but not the first", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const homeDir = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      const file = join(homeDir, "CLAUDE.md");
      writeFileSync(file, "global prefs");
      expect(resolveSafeAbsolutePathAnyRoot(file, [projectDir, homeDir])).toBe(realpathSync(file));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns null when the candidate escapes every given root", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const homeDir = mkdtempSync(join(tmpdir(), "memsync-home-"));
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    try {
      const file = join(outside, "secret");
      writeFileSync(file, "top secret");
      expect(resolveSafeAbsolutePathAnyRoot(file, [projectDir, homeDir])).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveSafeAbsolutePathNoSymlinks", () => {
  it("returns the realpath for an ordinary nested path reached through zero symlinks, including under a tmpdir root", () => {
    // os.tmpdir() is itself an OS-level symlink on macOS (/var -> /private/var). A walk
    // that re-examined the ROOT's own path would misfire on every tmpdir-rooted path;
    // only segments BETWEEN the root and the candidate are the caller's concern.
    const root = mkdtempSync(join(tmpdir(), "memsync-nosym-"));
    try {
      mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
      const file = join(root, ".cursor", "rules", "notes.md");
      writeFileSync(file, "hello");
      expect(resolveSafeAbsolutePathNoSymlinks(file, root)).toBe(realpathSync(file));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when an intermediate segment is a symlink that stays INSIDE the same root", () => {
    // The whole point of the segment walk: realpath containment alone accepts this,
    // because the resolved path really is under the root. It is still not the path
    // the caller asked for.
    const root = mkdtempSync(join(tmpdir(), "memsync-nosym-"));
    try {
      mkdirSync(join(root, "elsewhere"), { recursive: true });
      writeFileSync(join(root, "elsewhere", "notes.md"), "hi");
      mkdirSync(join(root, ".cursor"), { recursive: true });
      symlinkSync(join(root, "elsewhere"), join(root, ".cursor", "rules"));
      const candidate = join(root, ".cursor", "rules", "notes.md");

      // Containment on its own says yes — this is exactly the gap being closed.
      expect(resolveSafeAbsolutePath(candidate, root)).not.toBeNull();
      expect(resolveSafeAbsolutePathNoSymlinks(candidate, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the root itself: zero segments to walk is not the same as a symlinked segment", () => {
    // `.cursorrules` lives directly under projectDir, so its nearest existing ancestor
    // IS the root. Conflating "no segments below the root" with "a segment is a
    // symlink" would reject every such legitimate destination.
    const root = mkdtempSync(join(tmpdir(), "memsync-nosym-"));
    try {
      expect(resolveSafeAbsolutePathNoSymlinks(root, root)).toBe(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the candidate escapes the root entirely", () => {
    const root = mkdtempSync(join(tmpdir(), "memsync-nosym-"));
    const outside = mkdtempSync(join(tmpdir(), "memsync-outside-"));
    try {
      writeFileSync(join(outside, "secret"), "top secret");
      expect(resolveSafeAbsolutePathNoSymlinks(join(outside, "secret"), root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveSafeAbsolutePathNoSymlinksAnyRoot", () => {
  it("returns null when a symlinked segment under one root lands inside ANOTHER allowed root", () => {
    // The mirror-image failure of the escaping-symlink case: $HOME is an allowed root
    // on purpose, so a link planted under the project dir pointing into $HOME passes
    // containment against homeDir and passes it cleanly. Anchoring the containment
    // check and the segment walk to the SAME root is what rejects it.
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const homeDir = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      writeFileSync(join(homeDir, ".zshrc"), "real shell config");
      mkdirSync(join(projectDir, ".cursor"), { recursive: true });
      symlinkSync(homeDir, join(projectDir, ".cursor", "rules"));
      const candidate = join(projectDir, ".cursor", "rules", ".zshrc");

      expect(resolveSafeAbsolutePathAnyRoot(candidate, [projectDir, homeDir])).not.toBeNull();
      expect(resolveSafeAbsolutePathNoSymlinksAnyRoot(candidate, [projectDir, homeDir])).toBeNull();
    } finally {
      rmSync(join(projectDir, ".cursor", "rules"), { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("succeeds when the candidate is a symlink-free path under the second root", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const homeDir = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });
      const file = join(homeDir, ".claude", "projects", "CLAUDE.md");
      writeFileSync(file, "global prefs");
      expect(resolveSafeAbsolutePathNoSymlinksAnyRoot(file, [projectDir, homeDir])).toBe(realpathSync(file));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("accepts a root itself even when an earlier root does not contain it", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "memsync-proj-"));
    const homeDir = mkdtempSync(join(tmpdir(), "memsync-home-"));
    try {
      expect(resolveSafeAbsolutePathNoSymlinksAnyRoot(homeDir, [projectDir, homeDir])).toBe(realpathSync(homeDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
