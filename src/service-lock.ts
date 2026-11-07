// One writer per data directory.
//
// Interface: `acquireServiceLock(dataDir)` claims `<dataDir>/service.lock` for this process and
// returns a handle whose `release()` gives it up; `serviceLockHolder(dataDir)` answers who holds it
// without claiming anything. The offline removal command claims the same lock before it opens any
// database, so it refuses to touch a store a running service owns.
//
// Why: the service is a single long-lived process that never closes the harness, so the only safe
// window for a physical removal is *outside* it. There is deliberately no override flag: the two
// writers are the one thing that must not overlap, and a caller that "knows better" is exactly the
// caller that corrupts the store.
//
// Inputs: the data directory. The lock records this process's id and start time, nothing else.
//
// Errors: a lock held by another live process is a StateError naming that pid. A lock whose process is
// gone is taken over — a crash must not leave a deployment that cannot start again.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateError } from "./errors.js";

export const SERVICE_LOCK_NAME = "service.lock";

export interface ServiceLock {
  readonly path: string;
  readonly pid: number;
  /** True when a previous holder was gone (a crash) or this process already held the lock. */
  readonly tookOver: boolean;
  release(): void;
}

export function acquireServiceLock(dataDir: string): ServiceLock {
  const path = join(dataDir, SERVICE_LOCK_NAME);
  let previous: Holder | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    previous = readHolder(path);
    if (previous !== undefined) {
      // Two services in one process (a test embedding two starts) share the writer this lock
      // protects; two processes never do. Anything else is a real second writer.
      if (previous.pid === process.pid) return handle(path, true);
      if (alive(previous.pid)) {
        throw new StateError(`Another process (pid ${previous.pid}, started ${previous.startedAt}) owns this data directory`);
      }
      rmSync(path, { force: true });
    }
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      return handle(path, previous !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process created the lock between the check and the write; read it on the next pass.
    }
  }
  throw new StateError("The data directory lock could not be acquired");
}

function handle(path: string, tookOver: boolean): ServiceLock {
  let released = false;
  return Object.freeze({
    path,
    pid: process.pid,
    tookOver,
    release: (): void => {
      if (released) return;
      released = true;
      // Only ever remove our own claim: another process may have taken the lock after ours.
      const holder = readHolder(path);
      if (holder !== undefined && holder.pid !== process.pid) return;
      rmSync(path, { force: true });
    },
  });
}

interface Holder {
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Who claims this data directory, if anyone. Read-only, and deliberately not a check-then-act: it is
 * for reporting the other writer's pid, never for deciding whether to proceed — `acquireServiceLock`
 * is the only thing that may decide that, and it re-reads the file under its own claim.
 */
export function serviceLockHolder(dataDir: string): Holder | undefined {
  return readHolder(join(dataDir, SERVICE_LOCK_NAME));
}

function readHolder(path: string): Holder | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown };
    const pid = Number(parsed.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return { pid, startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown" };
  } catch {
    // An unreadable lock is not a claim: treat it as gone rather than blocking every future start.
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; anything else means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
