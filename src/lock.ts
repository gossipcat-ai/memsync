import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export class LockHeldError extends Error {
  constructor(lockPath: string) {
    super(`Another memsync operation is already running (lock: ${lockPath})`);
    this.name = "LockHeldError";
  }
}

export function acquireLock(lockPath: string): () => void {
  // The lock file's parent directory (e.g. ~/.memsync/) may not exist yet
  // on first use. mkdirSync with recursive:true is a safe no-op when the
  // directory already exists, so it never interferes with the EEXIST check
  // below for an already-held lock.
  mkdirSync(dirname(lockPath), { recursive: true });

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockHeldError(lockPath);
    }
    throw err;
  }
  closeSync(fd);
  return () => {
    unlinkSync(lockPath);
  };
}
