// The offline half of bot removal: reclaim the rows of already-accepted removals with the service
// stopped.
//
// Interface: `node dist/src/bot-purge.js --data-dir /app-data` runs one removal pass — the same one
// service startup runs, from `runPendingRemovals`, so the two paths cannot drift — and prints a
// one-line JSON report. Exit 0 means every pending removal was carried out.
//
// Why it exists: reclaiming the rows needs a process boundary, because the service never closes the
// harness and `VACUUM` needs exclusive access. Waiting for the next deploy is the default; this is for
// an operator who does not want to wait.
//
// Inputs: the data directory, from `--data-dir` or `DATA_DIR`. The directory is claimed through the
// service lock first, so a running service is refused by name rather than corrupted: there is no
// `--force`, because the two writers are the one thing that must not overlap. Nothing an operator
// types can narrow or widen which rows are removed — the tombstones on the bot rows decide that.
//
// Errors: a data directory that is missing or uninitialized, an unrecognized conversation-store
// schema and a failed removal are each reported by code, and none of them is reported as success.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runPendingRemovals, type RemovalPassReport } from "./bot-removal.js";
import { ConversationPurgeError, openConversationPurger, type ConversationPurgeCode } from "./conversation-purge.js";
import { Inbox } from "./inbox.js";
import { acquireServiceLock, serviceLockHolder, type ServiceLock } from "./service-lock.js";

const codes = [
  "ARGUMENTS_INVALID", "DATA_DIR_INVALID", "SERVICE_RUNNING", "LOCK_UNAVAILABLE",
  "REMOVAL_COMPLETE", "REMOVAL_INCOMPLETE", "INTERNAL_ERROR",
] as const;
type Code = typeof codes[number];
/** What a run can be refused for, or by the store it operates on. */
type Reported = Code | ConversationPurgeCode;

export class BotPurgeError extends Error {
  constructor(readonly code: Reported) {
    super(code);
    this.name = "BotPurgeError";
  }
}
function fail(code: Reported): never {
  throw new BotPurgeError(code);
}

export interface BotPurgeReport {
  readonly status: "bot-removal-pass-ok" | "bot-removal-pass-failed";
  readonly code: Reported;
  readonly dataDir: string;
  readonly pending: number;
  readonly removed: readonly {
    readonly botId: string;
    readonly conversationId: string;
    readonly state: "purged" | "absent" | "failed";
    readonly code: string | null;
    readonly rows: Readonly<Record<string, number>>;
  }[];
  readonly deferred: number;
  readonly vacuumed: boolean;
  readonly vacuumError: string | null;
}

/**
 * One offline pass. The intent lives on the bot rows, so this function's only decision is whether it
 * may be the only writer; which bots are removed was decided before it was ever invoked.
 */
export function purgeBots(input: { readonly dataDir: string; readonly log?: (line: string) => void }): BotPurgeReport {
  if (typeof input.dataDir !== "string" || !isAbsolute(input.dataDir) || input.dataDir.includes("\0")) fail("ARGUMENTS_INVALID");
  const dataDir = resolve(input.dataDir);
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) fail("DATA_DIR_INVALID");
  const inboxPath = join(dataDir, "inbox.sqlite");
  const storePath = join(dataDir, "agent.sqlite");
  // An uninitialized directory has no intent to carry out; creating the stores here would report a
  // success that removed nothing while leaving two new files behind.
  if (!existsSync(inboxPath)) fail("DATA_DIR_INVALID");

  // Claim the writer before opening anything. A live holder is named, never displaced: overlapping
  // writers are the one failure this command must not be able to cause.
  const lock = claimWriter(dataDir, input.log);
  try {
    const inbox = new Inbox(inboxPath);
    try {
      const purger = openConversationPurger(storePath);
      try {
        const pass = runPendingRemovals({ store: inbox, purger, log: input.log ?? ((line) => console.error(line)) });
        return report(dataDir, pass);
      } finally {
        purger.close();
      }
    } finally {
      inbox.close();
    }
  } finally {
    lock.release();
  }
}

/** This process, or nobody. A holder that is gone was a crash, and taking over is what keeps a
 * deployment startable; a holder that is alive is refused by name and nothing is touched. */
function claimWriter(dataDir: string, log?: (line: string) => void): ServiceLock {
  try {
    const lock = acquireServiceLock(dataDir);
    if (lock.tookOver) log?.("Took over a lock left by a process that is no longer running");
    return lock;
  } catch (error) {
    const holder = serviceLockHolder(dataDir);
    if (holder === undefined) fail("LOCK_UNAVAILABLE");
    log?.(`The service (pid ${holder.pid}, started ${holder.startedAt}) is running; stop it first.`);
    fail("SERVICE_RUNNING");
  }
}

function report(dataDir: string, pass: RemovalPassReport): BotPurgeReport {
  const failed = pass.outcomes.some((outcome) => outcome.state === "failed");
  return {
    status: failed ? "bot-removal-pass-failed" : "bot-removal-pass-ok",
    code: failed ? "REMOVAL_INCOMPLETE" : "REMOVAL_COMPLETE",
    dataDir,
    pending: pass.pending,
    removed: pass.outcomes.map((outcome) => ({
      botId: outcome.botId,
      conversationId: outcome.conversationId,
      state: outcome.state,
      code: outcome.code,
      rows: outcome.rows,
    })),
    deferred: pass.deferred,
    vacuumed: pass.vacuumed,
    vacuumError: pass.vacuumError,
  };
}

const help = `Usage: node dist/src/bot-purge.js [--data-dir /app-data]
Run with the service stopped to reclaim the rows of bots whose deletion was already accepted.
The directory may also come from DATA_DIR. The service lock is claimed first, so a running service
is refused by pid; there is no --force, because two writers must never overlap.
Which bots are removed comes from the tombstones on the bot rows, never from these arguments.
Exit 0 means every pending removal was carried out; a failed one is reported and stays pending.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, tokens } = parseArgs({
      options: { "data-dir": { type: "string" }, help: { type: "boolean" } },
      strict: true, allowPositionals: false, tokens: true,
    });
    if (new Set(tokens.map((token) => token.kind === "option" ? token.name : "")).size !== tokens.length) fail("ARGUMENTS_INVALID");
    if (values.help === true && tokens.length === 1) {
      console.log(help);
    } else {
      const dataDir = values["data-dir"] ?? process.env.DATA_DIR;
      if (values.help || dataDir === undefined) fail("ARGUMENTS_INVALID");
      const result = purgeBots({ dataDir });
      console.log(JSON.stringify(result));
      // A failed removal is not a crashed command, but it is not a clean exit either: an operator
      // who scripted this must not see success. The intent stays pending for the next attempt.
      if (result.status === "bot-removal-pass-failed") process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({
      status: "bot-removal-pass-failed",
      code: error instanceof BotPurgeError ? error.code
        : error instanceof ConversationPurgeError ? error.code
          : error instanceof TypeError ? "ARGUMENTS_INVALID" : "INTERNAL_ERROR",
    }));
    process.exitCode = 1;
  }
}
