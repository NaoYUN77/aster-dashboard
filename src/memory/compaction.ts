// Compaction Adapter (MEM-06): native compaction publishes block B, and the application — not
// the task's terminal state — confirms when a cycle actually switches.
//
// Interface
//   createCompactionExtension(options) -> an extension for `registry.install(...)`; it registers
//       `hook(CompactionTask, { beforeCompact })` and nothing else. `options`:
//         commit        host `Pick<Session, "commit">` — the ONLY persistence channel the hook
//                       uses. `HookApi` has no commit (design §12.6), so usage accounting and the
//                       saved summary result go through this injected host commit, exactly as
//                       MEM-05's archive task injects its model/store through options.
//         model         `{ provider, modelId }` ref of the summary model, resolved per call
//                       through `api.models`.
//         budget        `MemoryBudget`; defaults to `MEMORY_BUDGET_DEFAULTS`.
//         facts         the `SnapshotFacts` B is built from, or a function producing them.
//         maxAttempts   summary attempts per compaction, default 2, range 1..5.
//         onResult      optional observation callback for every settled hook outcome (success,
//                       decline, reuse); it receives identifiers and codes only, never prose.
//   nativeCompactionPolicy(budget, reserveTokens, contextWindow?)
//                     -> the native `settings.compaction` derived from the one budget schema.
//   compactionThresholds(contextWindow, reserveTokens, budget)
//                     -> `{ blocking, background }`, the SDK's own threshold derivation (§10, §14.4).
//   confirmCompactionCycle(deps, conversationId, taskId, context, options?)
//                     -> pending / not-published / switched, judged ONLY by §14.5: a submission
//                       path needs `submission.status === "done"` AND the view head being that
//                       submission's `pi.compaction`; a blocking path needs
//                       `outcome.result.entryId === view.head.id`. Task termination alone, and a
//                       queued submission alone, never switch a cycle.
//   createHarnessConfirmDeps(harness)
//                     -> `confirmCompactionCycle` deps bound to a real Harness + Conversation.
//   recordCompletedUserRequest(commit, conversationId, requestId, context, budget?)
//                     -> `{ completedUserTurns, shouldEvaluate }`; one completed user request
//                       counts once, keyed by `requestId` (06-F). Tool calls, generation retries
//                       and replays of the same requestId never call this twice effectively:
//                       the per-request receipt makes a replay return the stored count.
//   evaluateCompaction(input) -> token (blocking/background) before rounds before none (06-F).
//   requestPrefixFingerprint(input) / comparePrefix(prev, next)
//                     -> per-block digests (instructions / snapshot / tools) and their diff
//                       (06-G). Equal logical blocks do NOT prove a provider cache hit; cache
//                       behaviour stays "to be verified" (design §10, §17).
//   publishedSnapshot(entry) / summaryBodyOfEntry(entry)
//                     -> decode a published head: the application snapshot, or `undefined` for a
//                       native / pre-upgrade summary (narrative-only compatibility, §7).
//   readCompactionSummary / readCompactionTurnCount
//                     -> the persisted hook outcome / turn counter, for diagnosis and re-scan.
//
// Errors: every data or model failure inside `beforeCompact` is settled as `{ decline: true }`
// after the failure fact is persisted — the hook never throws an ordinary error, because the
// native hook runner would report it and fall back to the DEFAULT summary, publishing a B this
// adapter never validated (§2). The one exception is cancellation: when the context's abort
// signal has fired, the hook rethrows through `signal.throwIfAborted()` so the task settles
// `aborted` instead of publishing or declining (§12.5).
//
// Side effects and ordering, per `beforeCompact` invocation:
//   1. Derive the stable result key from the replaced range (firstKept, last replaced entry),
//      the boundary anchor, the previous snapshot's cycle, the facts, the model and the budget.
//   2. A saved, schema-valid result under that key is returned verbatim — no model call, no new
//      usage — so a restarted or re-run task reuses the same summary (recovery, §7).
//   3. Otherwise read the boundary working state (rule below), summarize with the injected
//      model, and after EVERY attempt (failed ones included) accumulate that attempt's usage
//      into `UsageDoc.models["app/summary"]` through the host commit (§12.5: hook-internal
//      calls get no native accounting, so this is the only record — and it cannot double-count).
//   4. On success the result (narrative + rendered B + key + model + attempts) is persisted to
//      the `personal.compaction.summary` doc family BEFORE `{ summary }` is returned, so the
//      native placement that follows can never publish bytes the application has not saved.
//      On failure the failure fact (error code + attempts) is persisted to the same family.
//   Boundary anchor rule: the baseline is read at the LAST `personal.working.anchor` entry
//   inside the replaced range, via `readWorkingAt` — never the newest state, never
//   `firstKept - 1`. With no anchor in the range, the state as of the last replaced entry is
//   probed with `snapshotAsOf`: `undefined` is the only outcome that may be read as the initial
//   state (the boundary then records that probe entry as its anchor); a present value means
//   state exists that no anchor in the range pins, and any read error means the boundary is
//   not covered — both decline with a recorded failure instead of guessing.

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  CompactionTask,
  defineDoc,
  defineDocFamily,
  defineExtension,
  hook,
  UsageDoc,
  type CompactionHooks,
  type ConversationId,
  type DocumentReader,
  type EntryId,
  type EntryRecord,
  type Extension,
  type Harness,
  type HookApi,
  type Session,
  type SubmissionRecord,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import {
  assertSchema,
  canonicalJson,
  CYCLE_SNAPSHOT_KIND,
  initialWorkingState,
  MEMORY_BUDGET_DEFAULTS,
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
  MemoryBudgetSchema,
  MemoryError,
  WORKING_ANCHOR_KIND,
  WorkingDoc,
  type CycleSnapshot,
  type MemoryBudget,
  type MemoryErrorCode,
  type SnapshotFacts,
  type SourceRange,
  type WorkingState,
} from "./contracts.js";
import { buildSnapshot, renderSnapshot, snapshotFromHead } from "./context.js";
import { readWorkingAt } from "./working.js";

/** The application-owned usage bucket for summary calls (§12.5); native keys never overlap it. */
export const SUMMARY_USAGE_KEY = "app/summary";
export const COMPACTION_SUMMARY_KIND = "personal.compaction.summary";
export const COMPACTION_TURN_KIND = "personal.compaction.turn";
export const COMPACTION_TURN_COUNTER_KIND = "personal.compaction.turn-counter";

/** The host operation this adapter needs: one atomic Session commit (cf. Working's `Committer`). */
export type CompactionCommitter = Pick<Session, "commit">;

/** A summary model reference, resolved through `api.models` at call time. */
export type SummaryModelRef = { readonly provider: string; readonly modelId: string };

/** Identifiers-and-codes-only observation of one settled hook outcome; never memory prose. */
export type CompactionObservation = {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly key: string;
  readonly outcome: "succeeded" | "reused" | "declined";
  readonly attempts: number;
  readonly errorCode: MemoryErrorCode | null;
};

export type CompactionExtensionOptions = {
  readonly commit: CompactionCommitter;
  readonly model: SummaryModelRef;
  readonly budget?: MemoryBudget;
  readonly facts?: SnapshotFacts | (() => SnapshotFacts | Promise<SnapshotFacts>);
  readonly maxAttempts?: number;
  readonly onResult?: (observation: CompactionObservation) => void;
};

// ---------------------------------------------------------------------------
// Persisted hook outcomes (doc family, seed pattern of `WorkingReceiptDoc`)
// ---------------------------------------------------------------------------

const Version = Type.Literal(MEMORY_SCHEMA_VERSION);
const Identifier = Type.String({ pattern: "^[A-Za-z0-9._:#-]{1,64}$" });
const Timestamp = Type.Integer({ minimum: 0 });
const EntryIdSchema = Type.Unsafe<EntryId>(Type.Integer({ minimum: 1 }));

/**
 * One settled summary outcome, keyed by the stable derivation below. A stored record always has
 * a non-negative `at`; the `at: -1` seed only exists inside the commit that replaces it.
 */
export const CompactionSummaryRecordSchema = Type.Object(
  {
    version: Version,
    key: Identifier,
    status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
    cycleId: Type.Union([Identifier, Type.Null()]),
    narrative: Type.Union([Type.String({ maxLength: MEMORY_LIMITS.narrative }), Type.Null()]),
    rendered: Type.Union([Type.String({ maxLength: MEMORY_LIMITS.snapshotText }), Type.Null()]),
    provider: Type.String({ minLength: 1, maxLength: 64 }),
    modelId: Type.String({ minLength: 1, maxLength: 64 }),
    attempts: Type.Integer({ minimum: 0, maximum: 16 }),
    errorCode: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    errorMessage: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    firstKept: EntryIdSchema,
    through: Type.Union([EntryIdSchema, Type.Null()]),
    at: Timestamp,
  },
  { additionalProperties: false },
);
export type CompactionSummaryRecord = Static<typeof CompactionSummaryRecordSchema>;

export const CompactionSummaryDoc = defineDocFamily({
  kind: COMPACTION_SUMMARY_KIND,
  version: MEMORY_SCHEMA_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed: CompactionSummaryRecord): CompactionSummaryRecord => seed,
});

/** Seed of a summary member that does not exist yet; identified by the sentinel before validation. */
const UNSET_SUMMARY = { at: -1 } as unknown as CompactionSummaryRecord;

/** The persisted outcome under `key`, or `undefined` when no attempt ever settled under it. */
export async function readCompactionSummary(
  reader: DocumentReader,
  conversationId: ConversationId,
  key: string,
  context: Context,
): Promise<CompactionSummaryRecord | undefined> {
  const stored = await reader.snapshot(CompactionSummaryDoc, conversationId, key, context);
  if (stored === undefined || (stored as CompactionSummaryRecord).at === UNSET_SUMMARY.at) return undefined;
  return assertSchema<CompactionSummaryRecord>(CompactionSummaryRecordSchema, stored, "corrupt-state");
}

async function persistSummaryRecord(
  committer: CompactionCommitter,
  conversationId: ConversationId,
  record: CompactionSummaryRecord,
  context: Context,
): Promise<void> {
  await committer.commit(async (tx) => {
    const slot = await tx.doc(CompactionSummaryDoc, conversationId, record.key, UNSET_SUMMARY);
    Object.assign(slot, detach(record));
  }, context);
}

/**
 * The stable key of one summary: same replaced range, same boundary, same previous cycle, same
 * facts, same model and same narrative/snapshot budget ⇒ same result, reusable across restarts.
 * A later compaction over an identical range chains after a different previous cycle, so it
 * derives a different key and never reuses a snapshot whose `sources.after` would rewind.
 */
export function deriveCompactionKey(input: {
  readonly conversationId: ConversationId;
  readonly firstKept: EntryId;
  readonly through: EntryId | null;
  readonly anchor: EntryId | null;
  readonly previousCycleId: string | null;
  readonly previousThrough: EntryId | null;
  readonly facts: SnapshotFacts;
  readonly model: SummaryModelRef;
  readonly budget: MemoryBudget;
}): string {
  const digest = createHash("sha256")
    .update(canonicalJson({
      conversationId: input.conversationId,
      firstKept: input.firstKept,
      through: input.through,
      anchor: input.anchor,
      previousCycleId: input.previousCycleId,
      previousThrough: input.previousThrough,
      facts: input.facts,
      provider: input.model.provider,
      modelId: input.model.modelId,
      narrativeTokens: input.budget.narrativeTokens,
      snapshotTokens: input.budget.snapshotTokens,
    }))
    .digest("hex");
  return `s${digest.slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Turn counting (06-F)
// ---------------------------------------------------------------------------

export const CompactionTurnReceiptSchema = Type.Object(
  {
    version: Version,
    requestId: Identifier,
    /** The 1-based ordinal this request was counted as. */
    turn: Type.Integer({ minimum: 1 }),
    at: Timestamp,
  },
  { additionalProperties: false },
);
export type CompactionTurnReceipt = Static<typeof CompactionTurnReceiptSchema>;

export const CompactionTurnDoc = defineDocFamily({
  kind: COMPACTION_TURN_KIND,
  version: MEMORY_SCHEMA_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed: CompactionTurnReceipt): CompactionTurnReceipt => seed,
});

const CompactionTurnCounterSchema = Type.Object(
  { version: Version, count: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
type CompactionTurnCounter = Static<typeof CompactionTurnCounterSchema>;

export const CompactionTurnCounterDoc = defineDoc({
  kind: COMPACTION_TURN_COUNTER_KIND,
  version: MEMORY_SCHEMA_VERSION,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): CompactionTurnCounter => ({ version: MEMORY_SCHEMA_VERSION, count: 0 }),
});

const UNSET_TURN = { at: -1 } as unknown as CompactionTurnReceipt;

/**
 * Count one completed user request. The receipt (keyed by `requestId`) and the counter move in
 * one commit, so a replay — a recovered request, a redelivered submission — returns the stored
 * count instead of counting again. Callers invoke this once per completed user request;
 * generation retries and tool calls are not user requests and must not call it (06-F).
 */
export async function recordCompletedUserRequest(
  committer: CompactionCommitter,
  conversationId: ConversationId,
  requestId: string,
  context: Context,
  budget: MemoryBudget = MEMORY_BUDGET_DEFAULTS,
): Promise<{ readonly completedUserTurns: number; readonly shouldEvaluate: boolean }> {
  if (!/^[A-Za-z0-9._:#-]{1,64}$/.test(requestId)) {
    throw new MemoryError("invalid-input", "A request id must be a memory identifier", { detail: { requestId } });
  }
  const evaluateAfter = budget.evaluateAfterUserTurns;
  const completedUserTurns = await committer.commit(async (tx) => {
    const slot = await tx.doc(CompactionTurnDoc, conversationId, requestId, UNSET_TURN);
    const counter = await tx.doc(CompactionTurnCounterDoc, conversationId);
    if ((slot as CompactionTurnReceipt).at !== UNSET_TURN.at) {
      return assertSchema<CompactionTurnCounter>(CompactionTurnCounterSchema, counter, "corrupt-state").count;
    }
    const count = assertSchema<CompactionTurnCounter>(CompactionTurnCounterSchema, counter, "corrupt-state").count + 1;
    counter.count = count;
    Object.assign(slot, { version: MEMORY_SCHEMA_VERSION, requestId, turn: count, at: Date.now() });
    return count;
  }, context);
  return {
    completedUserTurns,
    shouldEvaluate: completedUserTurns > 0 && completedUserTurns % evaluateAfter === 0,
  };
}

/** The persisted count of completed user requests; `0` before the first one. */
export async function readCompactionTurnCount(
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<number> {
  const stored = await reader.snapshot(CompactionTurnCounterDoc, conversationId, context);
  if (stored === undefined) return 0;
  return assertSchema<CompactionTurnCounter>(CompactionTurnCounterSchema, stored, "corrupt-state").count;
}

// ---------------------------------------------------------------------------
// Policy, thresholds and evaluation (06-F)
// ---------------------------------------------------------------------------

/**
 * The native compaction settings derived from the one budget schema (§10): the background target
 * and the verbatim tail come from the budget, the reserve is the caller's answer room. When a
 * `contextWindow` is given, the window relations are validated — the background threshold must
 * stay below the blocking threshold and the verbatim tail must fit under it — and an impossible
 * combination is an explicit `MemoryError`, never a silently clamped policy.
 */
export function nativeCompactionPolicy(
  budget: MemoryBudget,
  reserveTokens: number,
  contextWindow?: number,
): { readonly enabled: true; readonly reserveTokens: number; readonly keepRecentTokens: number; readonly backgroundTokens: number } {
  assertSchema<MemoryBudget>(MemoryBudgetSchema, budget, "invalid-input");
  if (!Number.isInteger(reserveTokens) || reserveTokens <= 0) {
    throw new MemoryError("invalid-input", "reserveTokens must be a positive integer", { detail: { reserveTokens } });
  }
  if (contextWindow !== undefined) {
    if (!Number.isInteger(contextWindow) || contextWindow <= reserveTokens) {
      throw new MemoryError("budget-exceeded", "The context window leaves no room beyond the reserve", {
        detail: { contextWindow, reserveTokens },
      });
    }
    const { blocking, background } = compactionThresholds(contextWindow, reserveTokens, budget);
    if (background <= 0) {
      throw new MemoryError("budget-exceeded", "The background target must stay below the blocking threshold", {
        detail: { contextWindow, reserveTokens, backgroundTargetTokens: budget.backgroundTargetTokens, blocking },
      });
    }
    if (budget.recentVerbatimTokens >= blocking) {
      throw new MemoryError("budget-exceeded", "The verbatim tail must fit below the blocking threshold", {
        detail: { recentVerbatimTokens: budget.recentVerbatimTokens, blocking },
      });
    }
  }
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: budget.recentVerbatimTokens,
    backgroundTokens: budget.backgroundTargetTokens,
  };
}

/** The SDK's thresholds from one window (§14.4): blocking `C - R`, background one target lower. */
export function compactionThresholds(
  contextWindow: number,
  reserveTokens: number,
  budget: MemoryBudget,
): { readonly blocking: number; readonly background: number } {
  const blocking = contextWindow - reserveTokens;
  return { blocking, background: blocking - budget.backgroundTargetTokens };
}

export type CompactionEvaluation =
  | { readonly kind: "token"; readonly level: "blocking" | "background" }
  | { readonly kind: "rounds" }
  | { readonly kind: "none" };

/**
 * Decide whether this request should evaluate compaction. Token pressure wins and never waits
 * for the round count — one large tool turn can trigger it (§10). Rounds only *evaluate*: they
 * yield a `rounds` decision when there is something worth summarizing, and `none` otherwise,
 * so twenty short requests evaluate without being force-compacted (06-F).
 */
export function evaluateCompaction(input: {
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly reserveTokens: number;
  readonly budget: MemoryBudget;
  readonly completedUserTurns: number;
  readonly compactableTokens: number;
}): CompactionEvaluation {
  const { blocking, background } = compactionThresholds(input.contextWindow, input.reserveTokens, input.budget);
  if (input.inputTokens >= blocking) return { kind: "token", level: "blocking" };
  if (input.inputTokens >= background) return { kind: "token", level: "background" };
  if (input.completedUserTurns >= input.budget.evaluateAfterUserTurns && input.compactableTokens > 0) {
    return { kind: "rounds" };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Prefix fingerprint (06-G)
// ---------------------------------------------------------------------------

/** Digests of the three logical prefix blocks and of the prefix as a whole. Bytes, not claims. */
export type PrefixFingerprint = {
  readonly digest: string;
  readonly instructions: string;
  readonly snapshot: string;
  readonly tools: string;
};

/**
 * Fingerprint one adapted request's prefix: block A (instructions text), block B (the rendered
 * snapshot text, empty before the first cycle) and the offered tool names, in offer order. The
 * fingerprint is a local byte identity: the same logical blocks produce the same digest, and a
 * changed digest says the prefix moved. It does NOT prove a provider cache hit — TTL, cache
 * granularity and billing are provider behaviour and remain to be verified (design §10).
 */
export function requestPrefixFingerprint(input: {
  readonly instructionsText: string;
  readonly snapshotText: string;
  readonly toolNames: readonly string[];
}): PrefixFingerprint {
  const instructions = digestText(input.instructionsText);
  const snapshot = digestText(input.snapshotText);
  const tools = digestText(canonicalJson([...input.toolNames]));
  return { digest: digestText(canonicalJson({ instructions, snapshot, tools })), instructions, snapshot, tools };
}

export type PrefixBlock = "instructions" | "snapshot" | "tools";

/** Which prefix blocks moved between two requests; loading a new tool schema moves `tools`. */
export function comparePrefix(
  previous: PrefixFingerprint,
  next: PrefixFingerprint,
): { readonly prefixChanged: boolean; readonly changedBlocks: readonly PrefixBlock[] } {
  const changedBlocks: PrefixBlock[] = [];
  if (previous.instructions !== next.instructions) changedBlocks.push("instructions");
  if (previous.snapshot !== next.snapshot) changedBlocks.push("snapshot");
  if (previous.tools !== next.tools) changedBlocks.push("tools");
  return { prefixChanged: changedBlocks.length > 0, changedBlocks };
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Published heads: decoding and the native-summary compatibility path (§7)
// ---------------------------------------------------------------------------

const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";

/** The summary body a published entry carries, without the native wrapper; `undefined` if none. */
export function summaryBodyOfEntry(entry: EntryRecord): string | undefined {
  for (const message of entry.model ?? []) {
    const text = messageText(message);
    const open = text.indexOf(SUMMARY_OPEN);
    if (open === -1) continue;
    const close = text.lastIndexOf(SUMMARY_CLOSE);
    if (close <= open) continue;
    let body = text.slice(open + SUMMARY_OPEN.length, close);
    if (body.startsWith("\n")) body = body.slice(1);
    if (body.endsWith("\n")) body = body.slice(0, -1);
    return body;
  }
  return undefined;
}

/**
 * The application snapshot a published head carries. `undefined` is the compatibility path: a
 * native or pre-upgrade summary, whose whole body is narrative. A present-but-corrupt or
 * unknown-version block throws (`snapshotFromHead`), never a silent narrative downgrade.
 */
export function publishedSnapshot(entry: EntryRecord): CycleSnapshot | undefined {
  const body = summaryBodyOfEntry(entry);
  return body === undefined ? undefined : snapshotFromHead(body);
}

// ---------------------------------------------------------------------------
// Cycle-switch confirmation (§14.5)
// ---------------------------------------------------------------------------

/** The durable reads a confirmation needs; `createHarnessConfirmDeps` binds a real Harness. */
export type CompactionConfirmDeps = {
  readonly getTask: (
    taskId: TaskId,
    context: Context,
  ) => Promise<
    | {
        readonly state: {
          readonly status: string;
          readonly outcome?: {
            readonly status: string;
            readonly result?: { readonly entryId?: EntryId; readonly submissionId?: unknown };
          };
        };
      }
    | undefined
  >;
  readonly submissionByRequest: (
    conversationId: ConversationId,
    requestId: string,
    context: Context,
  ) => Promise<SubmissionRecord | undefined>;
  readonly contextView: (
    conversationId: ConversationId,
    context: Context,
  ) => Promise<{ readonly head: EntryRecord | undefined }>;
};

export type CompactionConfirmation =
  | { readonly status: "pending"; readonly reason: string }
  | { readonly status: "not-published"; readonly reason: string }
  | {
      readonly status: "switched";
      readonly entryId: EntryId;
      /** The decoded snapshot; `undefined` with `native: true` for a native summary head. */
      readonly snapshot: CycleSnapshot | undefined;
      readonly native: boolean;
      /** `(after, through]` this switch newly archives; `after` never rewinds (see §8). */
      readonly archiveRange: SourceRange | null;
    };

/**
 * Confirm a cycle switch from durable facts only. Both §14.5 paths end at the same test — the
 * new entry IS the active head — so a restart re-scan answers exactly what the live run saw:
 * submission `done` after reopen, or the blocking task's `outcome.result.entryId` against the
 * head. `archivedThrough` is the caller's continuous archive cursor; the returned range starts
 * at the later of the snapshot's own `after` and that cursor, so a late confirmation of an old
 * switch cannot rewind archiving.
 */
export async function confirmCompactionCycle(
  deps: CompactionConfirmDeps,
  conversationId: ConversationId,
  taskId: TaskId,
  context: Context,
  options: { readonly archivedThrough?: EntryId | null } = {},
): Promise<CompactionConfirmation> {
  const task = await deps.getTask(taskId, context);
  if (task === undefined) return { status: "not-published", reason: "task-not-found" };
  if (task.state.status !== "terminal") return { status: "pending", reason: "task-not-terminal" };
  const outcome = task.state.outcome;
  if (outcome === undefined) return { status: "pending", reason: "task-not-terminal" };
  if (outcome.status === "failed" || outcome.status === "aborted" || outcome.status === "faulted" || outcome.status === "orphaned") {
    return { status: "not-published", reason: `task-${outcome.status}` };
  }
  if (outcome.status !== "completed") return { status: "not-published", reason: `task-${outcome.status}` };

  const result = outcome.result ?? {};
  // Blocking path: the generation-owned compaction appended directly; there is no submission.
  if (result.entryId !== undefined) {
    const view = await deps.contextView(conversationId, context);
    if (view.head === undefined || view.head.id !== result.entryId) {
      return { status: "not-published", reason: "head-mismatch" };
    }
    return switched(view.head, conversationId, options.archivedThrough ?? null);
  }
  // Submission path: the conversation-owned compaction queued its summary write.
  const submission = await deps.submissionByRequest(conversationId, `compaction:${taskId}`, context);
  if (submission === undefined) {
    // A completed task with no entry and no submission selected nothing to compact.
    return { status: "not-published", reason: "nothing-compacted" };
  }
  if (submission.status === "queued" || submission.status === "placed") {
    return { status: "pending", reason: `submission-${submission.status}` };
  }
  if (submission.status === "unanswered") {
    return { status: "not-published", reason: `submission-unanswered:${submission.reason ?? "stale"}` };
  }
  // `done`: the write landed; it switches the cycle only as the active head.
  const view = await deps.contextView(conversationId, context);
  if (view.head === undefined || submission.entry === undefined || view.head.id !== submission.entry) {
    return { status: "not-published", reason: "head-mismatch" };
  }
  return switched(view.head, conversationId, options.archivedThrough ?? null);
}

function switched(head: EntryRecord, conversationId: ConversationId, archivedThrough: EntryId | null): CompactionConfirmation {
  const snapshot = publishedSnapshot(head);
  let archiveRange: SourceRange | null = null;
  if (snapshot?.sources !== null && snapshot?.sources !== undefined) {
    const after = laterOf(snapshot.sources.after, archivedThrough);
    archiveRange = after !== null && after >= snapshot.sources.through
      ? null
      : { conversationId, after, through: snapshot.sources.through };
  }
  return { status: "switched", entryId: head.id, snapshot, native: snapshot === undefined, archiveRange };
}

function laterOf(left: EntryId | null, right: EntryId | null): EntryId | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}

/** Bind the confirmation deps to a Harness: task records, submissions and the live context view. */
export function createHarnessConfirmDeps(harness: Harness): CompactionConfirmDeps {
  return {
    getTask: async (taskId, context) => (await harness.getTask(taskId, context)) as never,
    submissionByRequest: (conversationId, requestId, context) =>
      harness.commit(async (tx) => tx.submissionByRequest(conversationId, requestId), context),
    contextView: async (conversationId, context) => {
      const conversation = await harness.conversation(conversationId, context);
      if (conversation === undefined) {
        throw new MemoryError("not-covered", "Conversation is not visible to this harness", { detail: { conversationId } });
      }
      const view = await conversation.context(context);
      return { head: view.head };
    },
  };
}

// ---------------------------------------------------------------------------
// The beforeCompact adapter
// ---------------------------------------------------------------------------

export const SUMMARY_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a continuity narrative that another LLM will use to continue the work.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the narrative.

Preserve, in concise prose or short lists: the goal, key decisions and their rationale, constraints and preferences, what is done, what is in progress, what is blocked, the next steps, and critical references (exact file paths, function names, error messages). If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it. Do not invent facts. Preserve dates and times exactly as stated: never invent or complete a missing year, month, or day — when the source gives only a month and a day, write only the month and the day. Do not emit any structured state block: the host appends the exact working state separately.`;

/** Longest tool-result text the serialized summary source keeps; truncation is always marked. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/**
 * Build the compaction extension. The factory validates its options eagerly — a bad attempt
 * budget or an unusable budget schema is a host configuration error, reported before any
 * compaction runs, not discovered inside a hook.
 */
export function createCompactionExtension(options: CompactionExtensionOptions): Extension {
  if (options.commit === undefined || typeof options.commit.commit !== "function") {
    throw new MemoryError("invalid-input", "createCompactionExtension requires a host commit");
  }
  if (options.model.provider.length === 0 || options.model.modelId.length === 0) {
    throw new MemoryError("invalid-input", "createCompactionExtension requires a summary model ref");
  }
  const budget = options.budget ?? MEMORY_BUDGET_DEFAULTS;
  assertSchema<MemoryBudget>(MemoryBudgetSchema, budget, "invalid-input");
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new MemoryError("invalid-input", "maxAttempts must be an integer in 1..5", { detail: { maxAttempts } });
  }
  const config: Required<Omit<CompactionExtensionOptions, "onResult" | "budget" | "facts" | "maxAttempts">> & {
    readonly budget: MemoryBudget;
    readonly facts: CompactionExtensionOptions["facts"];
    readonly maxAttempts: number;
    readonly onResult: CompactionExtensionOptions["onResult"];
  } = { commit: options.commit, model: options.model, budget, facts: options.facts, maxAttempts, onResult: options.onResult };

  return defineExtension({
    name: "memory-compaction",
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, ctx) => {
          // Cancellation is the only throw: once the signal has fired, propagate it so the
          // task settles `aborted` (§12.5). Every other failure declines, below.
          ctx.abortSignal?.throwIfAborted();
          const facts = await resolveFacts(config.facts);
          const outcome = await runCompaction(config, compaction, api, ctx, facts).catch((error: unknown) => {
            if ((ctx.abortSignal?.aborted ?? false) || isAbortError(error)) throw error;
            return {
              kind: "declined" as const,
              key: undefined,
              attempts: 0,
              error: error instanceof MemoryError ? error : new MemoryError("model-failure", "Compaction failed unexpectedly"),
            };
          });
          if (outcome.key !== undefined) {
            notify(config, {
              taskId: api.taskId,
              conversationId: api.conversationId,
              key: outcome.key,
              outcome: outcome.kind,
              attempts: outcome.attempts,
              errorCode: outcome.kind === "declined" ? outcome.error.code : null,
            });
          }
          return outcome.kind === "declined" ? { decline: true as const } : { summary: outcome.rendered };
        },
      }),
    ],
  });
}

type HookOutcome =
  | { readonly kind: "succeeded" | "reused"; readonly key: string; readonly attempts: number; readonly rendered: string }
  | { readonly kind: "declined"; readonly key: string | undefined; readonly attempts: number; readonly error: MemoryError };

/** The compaction the hook receives, exactly as the SDK declares it — no copied shape. */
type BeforeCompactInput = Parameters<CompactionHooks["beforeCompact"]>[0];

async function runCompaction(
  config: {
    readonly commit: CompactionCommitter;
    readonly model: SummaryModelRef;
    readonly budget: MemoryBudget;
    readonly facts: CompactionExtensionOptions["facts"];
    readonly maxAttempts: number;
  },
  compaction: BeforeCompactInput,
  api: HookApi,
  ctx: Context,
  facts: SnapshotFacts,
): Promise<HookOutcome> {
  const { conversationId } = api;
  const entries = compaction.entries;
  const through = entries.length === 0 ? null : entries[entries.length - 1]!.id;

  // --- The previous cycle (pure decode of the replaced head, §7) ---------------------------
  let previous: CycleSnapshot | undefined;
  let previousNarrative = "";
  const headEntry = entries[0];
  if (headEntry !== undefined && (headEntry.kind === "pi.compaction" || headEntry.kind === CYCLE_SNAPSHOT_KIND)) {
    const body = summaryBodyOfEntry(headEntry);
    if (body !== undefined) {
      try {
        previous = snapshotFromHead(body);
      } catch (error) {
        // A corrupt or unknown-version application block is an explicit failure (§7): decline
        // and record it; never reinterpret the block as narrative and publish over it.
        const failure = error instanceof MemoryError ? error : new MemoryError("corrupt-state", "Previous snapshot is unreadable");
        const key = deriveCompactionKey({
          conversationId, firstKept: compaction.firstKept, through, anchor: lastAnchor(entries),
          previousCycleId: null, previousThrough: null, facts, model: config.model, budget: config.budget,
        });
        await persistFailure(config, conversationId, key, compaction.firstKept, through, 0, failure, ctx);
        return { kind: "declined", key, attempts: 0, error: failure };
      }
      // A decoded snapshot contributes its narrative; a native body is narrative in full.
      previousNarrative = previous === undefined ? body : previous.narrative;
    }
  }
  const previousThrough = previous?.sources?.through ?? null;

  // --- The stable key and the saved-result reuse (§7 recovery) ------------------------------
  const anchor = lastAnchor(entries);
  const key = deriveCompactionKey({
    conversationId, firstKept: compaction.firstKept, through, anchor,
    previousCycleId: previous?.cycleId ?? null, previousThrough, facts, model: config.model, budget: config.budget,
  });
  const saved = await readCompactionSummary(api, conversationId, key, ctx).catch(() => undefined);
  if (saved !== undefined && saved.status === "succeeded" && saved.rendered !== null && saved.narrative !== null) {
    const reused = validateSaved(saved, compaction.firstKept, through);
    if (reused !== undefined) return { kind: "reused", key, attempts: saved.attempts, rendered: reused };
    // A saved record that no longer validates is not trusted and not returned; recompute below
    // and overwrite it with this run's settled outcome.
  }

  // --- The boundary working state (anchor rule, see the file header) ------------------------
  let baseline: WorkingState;
  let boundaryAnchor: EntryId;
  if (anchor !== null) {
    try {
      baseline = await readWorkingAt(api, conversationId, anchor, ctx);
    } catch (error) {
      const failure = error instanceof MemoryError ? error : new MemoryError("not-covered", "Boundary state is unreadable");
      await persistFailure(config, conversationId, key, compaction.firstKept, through, 0, failure, ctx);
      return { kind: "declined", key, attempts: 0, error: failure };
    }
    boundaryAnchor = anchor;
  } else {
    // No anchor in the replaced range: probe the state as of the last replaced entry.
    const probe = through;
    if (probe === null) {
      const failure = new MemoryError("invalid-input", "Compaction replaced no entries");
      await persistFailure(config, conversationId, key, compaction.firstKept, through, 0, failure, ctx);
      return { kind: "declined", key, attempts: 0, error: failure };
    }
    let probed: Readonly<WorkingState> | undefined;
    try {
      probed = await api.snapshotAsOf(WorkingDoc, conversationId, probe, ctx);
    } catch (error) {
      const failure = new MemoryError("not-covered", "Working state is not addressable at the boundary", { cause: error });
      await persistFailure(config, conversationId, key, compaction.firstKept, through, 0, failure, ctx);
      return { kind: "declined", key, attempts: 0, error: failure };
    }
    if (probed !== undefined) {
      const failure = new MemoryError(
        "not-covered",
        "Working state exists at the boundary but no anchor in the replaced range pins it; refusing to guess the boundary revision",
      );
      await persistFailure(config, conversationId, key, compaction.firstKept, through, 0, failure, ctx);
      return { kind: "declined", key, attempts: 0, error: failure };
    }
    baseline = initialWorkingState();
    boundaryAnchor = probe;
  }

  // --- The summary call: attempts, usage, cancellation (§12.5) ------------------------------
  const model = api.models.getModel(config.model.provider, config.model.modelId);
  if (model === undefined) {
    const failure = new MemoryError("model-failure", `Summary model ${config.model.provider}/${config.model.modelId} is not available`);
    await persistFailure(config, conversationId, key, compaction.firstKept, through, 0, failure, ctx);
    return { kind: "declined", key, attempts: 0, error: failure };
  }
  const hasPrevious = previous !== undefined || previousNarrative.length > 0;
  const source = summarySource(compaction.messages, previousNarrative, hasPrevious, compaction.instructions);
  const maxTokens = model.maxTokens > 0
    ? Math.min(config.budget.narrativeTokens, model.maxTokens)
    : config.budget.narrativeTokens;

  let attempts = 0;
  let narrative: string | undefined;
  let lastFailure: MemoryError | undefined;
  while (attempts < config.maxAttempts) {
    attempts += 1;
    const now = Date.now();
    const message = await api.models.completeSimple(model, {
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT, timestamp: now },
        { role: "user", content: [{ type: "text", text: source }], timestamp: now },
      ],
    }, { signal: ctx.abortSignal, cacheRetention: "none", maxTokens });
    // Every attempt is real model I/O: account it before judging the result (§12.5).
    if (message.usage !== undefined) {
      await recordSummaryUsage(config.commit, conversationId, message.usage, ctx);
    }
    if (message.stopReason === "aborted") {
      // Propagate the task's own cancellation; an abort from elsewhere is a failed attempt.
      ctx.abortSignal?.throwIfAborted();
      lastFailure = new MemoryError("cancelled", "Summary call was aborted");
      break;
    }
    const judged = judgeSummary(message, config.budget.narrativeTokens);
    if ("narrative" in judged) {
      narrative = judged.narrative;
      break;
    }
    lastFailure = judged.error;
    // Only a provider `error` is worth another attempt; an incomplete summary (length, empty,
    // tool call, over the narrative budget) declines rather than republishing a guess.
    if (message.stopReason !== "error") break;
  }
  if (narrative === undefined) {
    const failure = lastFailure ?? new MemoryError("model-failure", "Summary produced no usable narrative");
    await persistFailure(config, conversationId, key, compaction.firstKept, through, attempts, failure, ctx);
    return { kind: "declined", key, attempts, error: failure };
  }

  // --- Assemble B: the narrative plus the exact boundary state ------------------------------
  const cycleId = `cycle:${api.taskId}`;
  let rendered: string;
  try {
    const snapshot = buildSnapshot({
      cycleId,
      narrative,
      baseline,
      boundary: { kind: "compaction", firstKept: compaction.firstKept, anchor: boundaryAnchor },
      sources: { conversationId, after: previousThrough, through: through ?? compaction.firstKept },
      facts,
    });
    rendered = renderSnapshot(snapshot);
  } catch (error) {
    // Exact state over its bound is refused, never truncated or paraphrased into the narrative.
    const failure = error instanceof MemoryError ? error : new MemoryError("budget-exceeded", "Snapshot cannot be rendered within its bound");
    await persistFailure(config, conversationId, key, compaction.firstKept, through, attempts, failure, ctx);
    return { kind: "declined", key, attempts, error: failure };
  }

  // Persist BEFORE returning: a later re-run of this task reuses these exact bytes.
  await persistSummaryRecord(config.commit, conversationId, {
    version: MEMORY_SCHEMA_VERSION,
    key,
    status: "succeeded",
    cycleId,
    narrative,
    rendered,
    provider: config.model.provider,
    modelId: config.model.modelId,
    attempts,
    errorCode: null,
    errorMessage: null,
    firstKept: compaction.firstKept,
    through,
    at: Date.now(),
  }, ctx);
  return { kind: "succeeded", key, attempts, rendered };
}

/** A saved result is reused only if its rendered bytes still decode to this exact range. */
function validateSaved(saved: CompactionSummaryRecord, firstKept: EntryId, through: EntryId | null): string | undefined {
  if (saved.rendered === null || saved.firstKept !== firstKept) return undefined;
  try {
    const decoded = snapshotFromHead(saved.rendered);
    if (decoded === undefined) return undefined;
    if (decoded.cycleId !== saved.cycleId) return undefined;
    if (decoded.boundary.kind !== "compaction" || decoded.boundary.firstKept !== firstKept) return undefined;
    if (through !== null && decoded.sources?.through !== through) return undefined;
    return saved.rendered;
  } catch {
    return undefined;
  }
}

async function persistFailure(
  config: { readonly commit: CompactionCommitter; readonly model: SummaryModelRef },
  conversationId: ConversationId,
  key: string,
  firstKept: EntryId,
  through: EntryId | null,
  attempts: number,
  error: MemoryError,
  ctx: Context,
): Promise<void> {
  // Best effort: the decline itself is the contract; a failed failure-record must not turn a
  // decline into a thrown hook error (which would fall back to the default summary).
  await persistSummaryRecord(config.commit, conversationId, {
    version: MEMORY_SCHEMA_VERSION,
    key,
    status: "failed",
    cycleId: null,
    narrative: null,
    rendered: null,
    provider: config.model.provider,
    modelId: config.model.modelId,
    attempts,
    errorCode: error.code,
    errorMessage: error.message.slice(0, 500),
    firstKept,
    through,
    at: Date.now(),
  }, ctx).catch(() => {});
}

async function resolveFacts(facts: CompactionExtensionOptions["facts"]): Promise<SnapshotFacts> {
  if (facts === undefined) return { instructionsDigest: null, memoryDigest: null };
  return typeof facts === "function" ? await facts() : facts;
}

function notify(config: { readonly onResult: CompactionExtensionOptions["onResult"] }, observation: CompactionObservation): void {
  try {
    config.onResult?.(observation);
  } catch {
    // Observation never fails a compaction.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

/** The last working anchor inside the replaced range, or `null` when the range holds none. */
function lastAnchor(entries: readonly EntryRecord[]): EntryId | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.kind === WORKING_ANCHOR_KIND) return entries[index]!.id;
  }
  return null;
}

/**
 * Accumulate one attempt's usage into the application bucket, in the 01-E shape. Hook-internal
 * calls produce no native usage record, so this is the only accounting — and because native
 * generation/summarization keep their own keys, nothing is counted twice (§12.5).
 */
async function recordSummaryUsage(
  committer: CompactionCommitter,
  conversationId: ConversationId,
  usage: Usage,
  context: Context,
): Promise<void> {
  await committer.commit(async (tx) => {
    const bucket = (await tx.doc(UsageDoc, conversationId)).models;
    const total = bucket[SUMMARY_USAGE_KEY] ?? {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
    total.cost.input += usage.cost?.input ?? 0;
    total.cost.output += usage.cost?.output ?? 0;
    total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
    total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
    total.cost.total += usage.cost?.total ?? 0;
    bucket[SUMMARY_USAGE_KEY] = total;
  }, context);
}

/** Judge one summary response: only a clean `stop` with bounded plain text is a narrative. */
function judgeSummary(
  message: AssistantMessage,
  narrativeTokens: number,
): { readonly narrative: string } | { readonly error: MemoryError } {
  const fail = (reason: string): { readonly error: MemoryError } => ({
    error: new MemoryError("model-failure", `Summary is incomplete: ${reason}`, { detail: { reason } }),
  });
  if (message.stopReason === "error") return fail("provider error");
  if (message.stopReason === "length") return fail("hit the token limit");
  if (message.stopReason !== "stop") return fail(`stop reason ${message.stopReason}`);
  if (message.content.some((block) => block.type === "toolCall")) return fail("attempted a tool call");
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
  if (text.length === 0) return fail("produced no text");
  if (estimateTextTokens(text) > narrativeTokens) return fail("exceeds the narrative token budget");
  return { narrative: text };
}

/**
 * The summarizer's source: the previous narrative first (the head message itself is not
 * repeated), then the replaced messages serialized as plain text — visible text, tool calls and
 * tool results, system messages omitted. Tool results are truncated at a fixed bound and the
 * truncation is stated, never presented as the complete result.
 */
function summarySource(
  messages: readonly Message[],
  previousNarrative: string,
  hasPrevious: boolean,
  instructions: string | undefined,
): string {
  const parts: string[] = [];
  parts.push(`<previous-summary>\n${hasPrevious && previousNarrative.length > 0 ? previousNarrative : "(none — this is the first compaction)"}\n</previous-summary>`);
  parts.push(`<conversation>\n${serializeMessages(messages, hasPrevious)}\n</conversation>`);
  if (instructions !== undefined && instructions.length > 0) parts.push(`Additional focus: ${instructions}`);
  parts.push("Write the new continuity narrative now.");
  return parts.join("\n\n");
}

function serializeMessages(messages: readonly Message[], skipHeadSummary: boolean): string {
  const parts: string[] = [];
  let skipped = false;
  for (const message of messages) {
    if (message.role === "system") continue;
    if (skipHeadSummary && !skipped && message.role === "user") {
      // The head marker's own message restates the previous summary, already given above.
      const text = messageText(message);
      if (text.includes("compacted into the following summary")) {
        skipped = true;
        continue;
      }
    }
    if (message.role === "user") {
      const text = messageText(message);
      if (text.length > 0) parts.push(`[User]: ${text}`);
    } else if (message.role === "assistant") {
      const texts = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
      const calls = message.content.flatMap((block) => (block.type === "toolCall"
        ? [`${block.name}(${Object.entries(block.arguments).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(", ")})`]
        : []));
      if (texts.length > 0) parts.push(`[Assistant]: ${texts.join("\n")}`);
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (message.role === "toolResult") {
      const text = messageText(message);
      if (text.length > 0) parts.push(`[Tool result]: ${truncateToolResult(text)}`);
    }
  }
  return parts.join("\n\n");
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated — the full tool result remains in the stored entries]`;
}

/** The plain text of one message: its string content or its text blocks, nothing else. */
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
}

/** A detached JSON copy; a transaction draft cannot leave its commit (cf. working.ts). */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
