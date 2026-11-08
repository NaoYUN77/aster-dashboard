// One removal pass over the bots whose deletion the operator already accepted.
//
// Interface: `runPendingRemovals({ store, purger })` walks every pending removal, removes the rows
// it names, records the outcome on the bot row and reports what happened. Service startup runs it
// before `openAgent()`; the offline command runs the same function with the service stopped. There
// is one implementation, so the two paths cannot drift.
//
// Inputs: the bot store (durable intent) and a conversation purger (the base's rows). Nothing from a
// request, a model or a bot reaches this function.
//
// Errors: a removal that fails is recorded with its failure code and left pending. The pass never
// marks work it did not do, and it never stops the service — one bot that cannot be reclaimed must
// not keep the others from starting. Every failure is reported to the caller and, when a log is
// given, to it.

import type { BotRecord, BotRemovalKind, Inbox } from "./inbox.js";
import {
  ConversationPurgeError, DURABLE_CONVERSATION_ID, emptyPurgeReport,
  type ConversationPurger, type ConversationPurgeReport, type PurgeTable,
} from "./conversation-purge.js";
import { failureCode } from "./errors.js";

export interface RemovalOutcome {
  readonly botId: string;
  readonly kind: BotRemovalKind;
  readonly conversationId: string;
  /** `absent` means there was nothing left to remove: a transcript that never existed or a re-run. */
  readonly state: "purged" | "absent" | "failed";
  readonly rows: Readonly<Record<PurgeTable, number>>;
  /**
   * Index rows this pass dropped: the bot's background jobs and their completion notices. They live
   * in the bot store rather than the conversation store, so `rows` never accounts for them.
   */
  readonly jobs: number;
  readonly notices: number;
  readonly code: string | null;
}

export interface RemovalPassReport {
  readonly pending: number;
  readonly outcomes: readonly RemovalOutcome[];
  /** Pending removals this pass did not reach, kept for the next one; never silently dropped. */
  readonly deferred: number;
  readonly vacuumed: boolean;
  readonly vacuumError: string | null;
}

/**
 * How many tombstones one start reclaims. `CONSOLE_MAX_BOTS` keeps the realistic number far below
 * this, so reaching the bound means something is wrong rather than that the deployment is busy — and
 * the remainder is reported instead of being dropped.
 */
export const MAX_REMOVALS_PER_PASS = 64;

/** The store side of a pass, so the same code serves service startup and the offline command. */
export type RemovalStore = Pick<
  Inbox,
  | "pendingRemovals" | "deleteBotRequests" | "deleteBotJobs" | "removeProvisioning"
  | "finishRemoval" | "failRemoval" | "vacuum"
>;

export interface RemovalPassOptions {
  readonly store: RemovalStore;
  readonly purger: ConversationPurger;
  readonly log?: (line: string) => void;
  /** Default true: reclaim free pages once the rows are gone. */
  readonly vacuum?: boolean;
}

export function runPendingRemovals(options: RemovalPassOptions): RemovalPassReport {
  const pending = options.store.pendingRemovals();
  const batch = pending.slice(0, MAX_REMOVALS_PER_PASS);
  const deferred = pending.length - batch.length;
  if (deferred > 0) {
    options.log?.(`Bot removal pass: ${batch.length} of ${pending.length} pending removals; ${deferred} left for the next start`);
  }
  const outcomes: RemovalOutcome[] = [];
  let changed = false;
  for (const bot of batch) {
    const removal = bot.removal;
    // A pending removal always carries one; a row without it is not pending.
    if (removal === null) continue;
    try {
      const report = purgeOne(options.purger, bot, removal.kind, removal.forced);
      options.store.removeProvisioning(bot.botId);
      options.store.deleteBotRequests(bot.botId);
      // The job index and its notices belong to the bot that just left; leaving them would keep a
      // deleted bot's ids readable from the console. They are dropped in the same pass, and counted
      // apart from the conversation rows because they are a different store.
      const dropped = options.store.deleteBotJobs(bot.botId);
      // The report is written last: it is the only field that ends the intent's life.
      options.store.finishRemoval(bot.botId, JSON.stringify({
        at: new Date().toISOString(),
        mode: report.mode,
        forced: report.forced,
        removed: report.removed,
        rows: report.rows,
        jobs: dropped.jobs,
        notices: dropped.notices,
      }));
      if (!report.absent || dropped.jobs > 0 || dropped.notices > 0) changed = true;
      outcomes.push(Object.freeze({
        botId: bot.botId,
        kind: removal.kind,
        conversationId: bot.conversationId,
        state: report.absent ? "absent" as const : "purged" as const,
        rows: report.rows,
        jobs: dropped.jobs,
        notices: dropped.notices,
        code: null,
      }));
      options.log?.(`Bot removed: ${bot.botId} (${removal.kind}, ${report.absent ? "already absent" : `conversation ${report.removed.join(",")}`}, ${dropped.jobs} job row(s))`);
    } catch (error) {
      const code = error instanceof ConversationPurgeError ? error.code : failureCode(error);
      options.store.failRemoval(bot.botId, code);
      options.log?.(`Bot removal failed: ${bot.botId} (${code}); it stays pending for the next pass`);
      outcomes.push(Object.freeze({
        botId: bot.botId,
        kind: removal.kind,
        conversationId: bot.conversationId,
        state: "failed" as const,
        rows: emptyPurgeReport(bot.conversationId, mode(removal.kind)).rows,
        // The pass removes no rows when it fails, so nothing was dropped from the job index either;
        // the counts stay for the next pass rather than being reported as done.
        jobs: 0,
        notices: 0,
        code,
      }));
    }
  }
  const reclaim = changed && options.vacuum !== false ? options.store.vacuum() : { vacuumed: false, error: null };
  return Object.freeze({
    pending: pending.length,
    outcomes: Object.freeze(outcomes),
    deferred,
    vacuumed: reclaim.vacuumed,
    vacuumError: reclaim.error,
  });
}

/**
 * One bot's rows. A bot whose transcript was never created (a failed provisioning leaves a
 * `pending:<id>` placeholder) has nothing in the conversation store, which is not the same as an
 * unreadable store and must not be reported as a failure.
 */
function purgeOne(
  purger: ConversationPurger, bot: BotRecord, kind: BotRemovalKind, forced: boolean,
): ConversationPurgeReport {
  const mode: "erase" | "reset" = kind === "reset" ? "reset" : "erase";
  if (!DURABLE_CONVERSATION_ID.test(bot.conversationId)) return emptyPurgeReport(bot.conversationId, mode);
  return purger.purge({ conversationId: bot.conversationId, mode, force: forced });
}

function mode(kind: BotRemovalKind): "erase" | "reset" {
  return kind === "reset" ? "reset" : "erase";
}
