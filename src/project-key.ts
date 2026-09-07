import { createHash } from "node:crypto";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

export function resolveProjectKeyFallback(absoluteProjectDir: string): string {
  const folderName = basename(absoluteProjectDir);
  const hash = createHash("sha256").update(absoluteProjectDir).digest("hex").slice(0, 6);
  return `${folderName}-${hash}`;
}

export function normalizeGitRemoteUrl(url: string): string {
  let s = url.trim();
  s = s.replace(/\.git$/, "");

  // git@host:owner/repo -> host/owner/repo
  // The leading "git@" here is the fixed SSH username convention, not a
  // leaked credential, so it is intentionally NOT treated as userinfo to strip.
  const sshMatch = s.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, ""); // strip https:// / ssh:// / git://
    // Strip an embedded <user>[:<password>]@ authority component (e.g. a
    // PAT/token in an https remote) so secrets never end up in the
    // persisted/displayed/synced projectKey.
    s = s.replace(/^[^/@]+@/, "");
  }

  // Lowercase only the host component; leave owner/repo path segments as-is
  // so case-sensitive git hosts don't collide two distinct repos into the
  // same projectKey.
  const slashIndex = s.indexOf("/");
  if (slashIndex === -1) {
    s = s.toLowerCase();
  } else {
    s = s.slice(0, slashIndex).toLowerCase() + s.slice(slashIndex);
  }

  s = s.replace(/\/+$/, "");
  return s;
}

export function getGitRemoteUrl(projectDir: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const url = out.toString("utf8").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export function resolveProjectKeyForDir(projectDir: string): string {
  const remote = getGitRemoteUrl(projectDir);
  if (remote) {
    return normalizeGitRemoteUrl(remote);
  }
  return resolveProjectKeyFallback(projectDir);
}
