// Memory composition root (MEM-07): the one entry the application uses to wire the verified
// memory modules into the request lifecycle. It constructs the modules, registers their native
// tools, hooks and tasks, and performs the per-request durable steps in the frozen order:
//
//   startup   migration record + archive origin (the current tail; never a history backfill),
//             then a bounded archive re-scan from persisted facts.
//   prepare   an already-admitted requestId is classified (done = replay, unsettled = recovery)
//             and gets no new projection, model call or archive trigger. A new request first
//             re-checks compaction confirmations and archive coverage from durable facts, then
//             plans with the pure Context module: establish B, project a working revision into
//             C, or ask the native machinery to compact. A committed projection whose input was
//             never submitted is reused as written, never recomputed over.
//   complete  the finished request is counted once by requestId; at the evaluation point the
//             token-first evaluation may start a native compaction, and the boundary re-scan
//             picks up completions and published compactions for the archive.
//
// Business errors stay `MemoryError`s with the frozen mapping (MEM-01): the request layer turns
// them into `MEMORY_*` application errors, never `AGENT_SESSION_FAILED`. Storage failures are not
// `MemoryError`s and keep the Session failure path. Archive and compaction housekeeping at the
// boundaries is best-effort by design (§8, §11): a failed archive never fails a chat, its failure
// fact is persisted by the archive module itself, and the next boundary retries from facts.
//
// Observation carries identifiers, versions, counts, durations and safe error codes only —
// never memory text (design §11).

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  defineDocFamily,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Storage,
  type EntryId,
  type EntryRecord,
  type Extension,
  type Harness,
  type Session,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import {
  CYCLE_SNAPSHOT_KIND,
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  type CycleSnapshot,
  type MemoryBudget,
  type SnapshotFacts,
} from "./contracts.js";
import {
  measureRequest,
  planRequest,
  sameFacts,
  snapshotOfProjection,
} from "./context.js";
import { readWorking } from "./working.js";
import { requireCurrentProfileEvidence } from "./profile.js";
import { createWorkingExtension } from "./working-tools.js";
import { openDaily } from "./daily.js";
import { createArchiveTask, initializeArchive, readArchive, reconcileArchive, requestArchive, type ArchiveTask } from "./archive-task.js";
import {
  confirmCompactionCycle,
  createCompactionExtension,
  createHarnessConfirmDeps,
  evaluateCompaction,
  nativeCompactionPolicy,
  publishedSnapshot,
  readCompactionTurnCount,
  recordCompletedUserRequest,
} from "./compaction.js";
import { memoryToolsExtension } from "./memory-tools.js";

export type MemoryIntegrationOptions = {
  /** Host data root: the daily store lives under `<root>/memory/daily` (design §3). */
  readonly root: string;
  /** The exact instructions text configured on the conversation (block A, application part). */
  readonly instructions: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  /** The model's context window when the catalog states one; thresholds derive from it. */
  readonly contextWindow?: number;
  readonly budget: MemoryBudget;
  readonly reserveTokens: number;
  readonly timezone: string;
  readonly archiveTimeoutMs?: number;
  /** When false, confirmed archive batches do not update the working profile. Default true. */
  readonly profile?: boolean;
  /** Identifiers-and-codes-only observation; defaults to a one-line stderr log. */
  readonly log?: (event: MemoryLogEvent) => void;
};

export type MemoryLogEvent = {
  readonly event: string;
  readonly conversationId?: number;
  readonly requestId?: string;
  readonly action?: string;
  readonly code?: string | null;
  readonly turns?: number;
  readonly durationMs?: number;
};

export type PreparedRequest =
  | { readonly kind: "replay" }
  | { readonly kind: "recover" }
  | { readonly kind: "new"; readonly action: string };

const MIGRATION_KIND = "personal.memory.upgrade";
const REVISION_PROJECTION_KIND = "personal.context.projection";
const RECONCILE_MAX_SWEEPS = 32;
/** Window assumed only when the model catalog omits one; production models state theirs. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

const MigrationRecordSchema = Type.Object(
  {
    version: Type.Literal(MEMORY_SCHEMA_VERSION),
    /** The entry the archive starts from: history at or before it is never backfilled. */
    archiveOrigin: Type.Union([Type.Unsafe<EntryId>(Type.Integer({ minimum: 1 })), Type.Null()]),
    hadHistory: Type.Boolean(),
    at: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
type MigrationRecord = Static<typeof MigrationRecordSchema>;

const MigrationDoc = defineDocFamily({
  kind: MIGRATION_KIND,
  version: MEMORY_SCHEMA_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed: MigrationRecord): MigrationRecord => seed,
});

const UNSET_MIGRATION = { at: -1 } as unknown as MigrationRecord;

/** An error in the shape the request layer surfaces: the frozen application code, nothing else. */
export function memoryAppError(error: MemoryError): Error {
  return Object.assign(new Error(`Memory operation failed: ${error.message}`, { cause: error }), { code: error.appCode });
}

/** True for a memory business error (frozen codes), as opposed to a base/storage failure. */
export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}

export class MemoryIntegration {
  readonly #options: MemoryIntegrationOptions;
  readonly #log: (event: MemoryLogEvent) => void;
  readonly #store;
  readonly #archiveTask: ArchiveTask;
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #initialized = false;
  #closed = false;

  constructor(options: MemoryIntegrationOptions) {
    this.#options = options;
    this.#log = options.log ?? ((event) => console.error(`Memory ${event.event}: ${JSON.stringify(event)}`));
    this.#store = openDaily(options.root);
    this.#archiveTask = createArchiveTask({
      store: this.#store,
      model: options.model,
      ...(options.archiveTimeoutMs === undefined ? {} : { timeoutMs: options.archiveTimeoutMs }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
  }

  /** The native compaction policy for the harness settings, derived from the one budget (§10). */
  compactionSettings() {
    return nativeCompactionPolicy(this.#options.budget, this.#options.reserveTokens, this.#options.contextWindow);
  }

  get contextWindow(): number {
    return this.#options.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  }

  /**
   * Extensions for the tool registry, in install order: working tools, retrieval tools, the
   * compaction hook and the archive task. The compaction hook persists through a late-bound host
   * commit — the harness only exists after the registry is installed — and hooks cannot run
   * before `attach`, which the application calls immediately after opening the harness.
   */
  extensions(): Extension[] {
    const commit: Pick<Session, "commit"> = {
      commit: (change, context) => this.#session().commit(change, context),
    };
    return [
      createWorkingExtension({
        resolveProfileEvidence: (refs) => requireCurrentProfileEvidence(this.#store, refs),
      }),
      memoryToolsExtension({ store: this.#store, budget: this.#options.budget }),
      createCompactionExtension({
        commit,
        model: this.#options.model,
        budget: this.#options.budget,
        facts: () => this.currentFacts(),
        onResult: (observation) => this.#log({
          event: "compaction.result",
          conversationId: observation.conversationId,
          action: observation.outcome,
          code: observation.errorCode,
          turns: observation.attempts,
        }),
      }),
      { name: "memory-archive", tasks: [this.#archiveTask] },
    ];
  }

  /** Bind the opened harness and its root conversation. Call once, before `initialize`. */
  attach(harness: Harness, root: Conversation): void {
    if (this.#harness !== undefined) throw new MemoryError("invalid-input", "Memory integration is already attached");
    this.#harness = harness;
    this.#root = root;
  }

  /**
   * First-upgrade migration and startup re-scan, idempotent across restarts. The archive origin
   * is the conversation's current tail: pre-upgrade history is never backfilled unless an
   * operator later moves the target explicitly. A timezone that contradicts the initialized
   * archive is a `revision-conflict`, not a silent change.
   */
  async initialize(context: Context): Promise<void> {
    if (this.#initialized) return;
    const session = this.#session();
    const root = this.#conversation();
    const state = await readArchive(session, root.id, context);
    if (state?.initialized === true) {
      if (state.timezone !== this.#options.timezone) {
        throw new MemoryError("revision-conflict", "Archive timezone is already fixed", {
          detail: { initialized: state.timezone, configured: this.#options.timezone },
        });
      }
    } else {
      const tail = await session.commit(async (tx) => {
        const page = await tx.scanEntries({ conversationId: root.id, order: "descending" }, 1);
        return page.items[0]?.id ?? null;
      }, context);
      await session.commit(async (tx) => {
        const slot = await tx.doc(MigrationDoc, root.id, "v1", UNSET_MIGRATION);
        if ((slot as MigrationRecord).at === UNSET_MIGRATION.at) {
          Object.assign(slot, {
            version: MEMORY_SCHEMA_VERSION,
            archiveOrigin: tail,
            hadHistory: tail !== null,
            at: Date.now(),
          } satisfies MigrationRecord);
        }
      }, context);
      await initializeArchive(session, root.id, tail, this.#options.timezone, context);
      this.#log({ event: "memory.upgrade", conversationId: root.id, action: tail === null ? "fresh" : "origin-at-tail" });
    }
    this.#initialized = true;
    await this.#rescan(context);
  }

  /**
   * The durable steps before a user input is submitted. Throws a `MEMORY_*`-coded error for a
   * plan-level refusal (the request must not run), and lets storage failures propagate untouched.
   */
  async prepareRequest(request: { readonly requestId: string; readonly text: string }, context: Context): Promise<PreparedRequest> {
    try {
      return await this.#prepareRequest(request, context);
    } catch (error) {
      // Every memory business error leaves this module in its mapped application shape, so the
      // request layer can never mistake one for a Session failure (MEM-01 mapping).
      if (error instanceof MemoryError) throw memoryAppError(error);
      throw error;
    }
  }

  async #prepareRequest(request: { readonly requestId: string; readonly text: string }, context: Context): Promise<PreparedRequest> {
    this.#assertOpen();
    const started = Date.now();
    const session = this.#session();
    const root = this.#conversation();
    const existing = await session.commit(
      async (tx) => tx.submissionByRequest(root.id, request.requestId),
      context,
    );
    if (existing !== undefined) {
      const kind = existing.status === "done" ? "replay" : "recover";
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: kind, durationMs: Date.now() - started });
      return { kind };
    }

    await this.#rescan(context);

    // A projection committed for this request whose input was never submitted is reused as
    // written (§6): recomputing it could publish different bytes for the same fact.
    const projectionId = projectionRequestId(request.requestId);
    const priorProjection = await session.commit(
      async (tx) => tx.submissionByRequest(root.id, projectionId),
      context,
    );
    if (priorProjection !== undefined && priorProjection.status !== "unanswered") {
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: "reuse-projection", durationMs: Date.now() - started });
      return { kind: "new", action: "reuse-projection" };
    }

    const facts = await this.currentFacts();
    let view = await root.context(context);
    let cycle = scanCycle(view.entries);
    const working = await readWorking(session, root.id, context);
    let compactable = compactableTokens(view, this.#options.budget.recentVerbatimTokens);
    if (cycle.snapshot !== undefined && compactable <= 0 && !sameFacts(cycle.snapshot.facts, facts)) {
      // The inputs B was built from changed and there is nothing to summarize (§14.2 step 6
      // would refuse the request outright). The design's own rule for a change that cannot be
      // carried by a tail revision is to end the cycle explicitly (§6): reset, then let the
      // plan below establish the new B behind it. Durable history, working state and the
      // archive cursors are untouched; only the active context restarts. With compactable
      // content the planner's compact/facts path handles the same change without a reset.
      await root.reset(undefined, context);
      view = await root.context(context);
      cycle = scanCycle(view.entries);
      compactable = compactableTokens(view, this.#options.budget.recentVerbatimTokens);
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: "facts-restart" });
    }
    const plan = planRequest({
      budget: this.#options.budget,
      instructionsText: this.#options.instructions,
      snapshot: cycle.snapshot,
      working,
      workingInContext: cycle.workingInContext(working.revision),
      inputTokens: measureRequest([...view.messages, userMessage(request.text)])
        + estimateTextTokens(this.#options.instructions),
      contextWindow: this.contextWindow,
      reserveTokens: this.#options.reserveTokens,
      userTurns: countUserTurns(view.entries),
      compactableTokens: compactable,
      facts,
    });
    if (plan.action.kind === "error") {
      const error = new MemoryError(plan.action.error.code, plan.action.error.message, { detail: plan.action.error.detail });
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: "error", code: error.appCode, durationMs: Date.now() - started });
      throw memoryAppError(error);
    }
    if (plan.action.kind === "project") {
      for (const draft of plan.action.drafts) {
        const submission = await root.submit({ type: "write", entry: draft, requestId: projectionId }, context);
        await submission.status(context);
      }
    } else if (plan.action.kind === "compact") {
      // The native machinery owns placement and recovery; the adapter's hook builds B and the
      // switch is confirmed from durable facts at a later boundary, never from this call.
      await root.compact(undefined, context);
    }
    this.#log({
      event: "memory.prepare", conversationId: root.id, requestId: request.requestId,
      action: plan.action.kind, turns: await readCompactionTurnCount(session, root.id, context),
      durationMs: Date.now() - started,
    });
    return { kind: "new", action: plan.action.kind };
  }

  /**
   * The durable steps after a request completed with an answer: count it once, evaluate
   * compaction at the boundary, and re-scan archive coverage. Counting is idempotent by
   * requestId, so a recovered request that completes now is counted exactly once and a replay
   * is filtered by the caller. Housekeeping failures are logged, never thrown into a finished
   * request; storage failures still propagate.
   */
  async afterRequest(requestId: string, context: Context): Promise<void> {
    this.#assertOpen();
    const session = this.#session();
    const root = this.#conversation();
    const started = Date.now();
    let counted: { completedUserTurns: number; shouldEvaluate: boolean } | undefined;
    try {
      counted = await recordCompletedUserRequest(session, root.id, requestId, context, this.#options.budget);
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      this.#log({ event: "memory.count", conversationId: root.id, requestId, action: "failed", code: error.appCode });
    }
    if (counted?.shouldEvaluate === true) {
      const view = await root.context(context);
      const decision = evaluateCompaction({
        inputTokens: measureRequest(view.messages) + estimateTextTokens(this.#options.instructions),
        contextWindow: this.contextWindow,
        reserveTokens: this.#options.reserveTokens,
        budget: this.#options.budget,
        completedUserTurns: counted.completedUserTurns,
        compactableTokens: compactableTokens(view, this.#options.budget.recentVerbatimTokens),
      });
      this.#log({ event: "memory.evaluate", conversationId: root.id, requestId, action: decision.kind, turns: counted.completedUserTurns });
      if (decision.kind !== "none") await root.compact(undefined, context);
    }
    await this.#rescan(context);
    this.#log({ event: "memory.complete", conversationId: root.id, requestId, turns: counted?.completedUserTurns, durationMs: Date.now() - started });
  }

  /**
   * End the current context cycle. The reset itself is admitted by the base; the next request's
   * prepare step establishes the new B behind it (§12.4), so no snapshot is written here.
   */
  async resetConversation(context: Context): Promise<void> {
    try {
      this.#assertOpen();
      await this.#conversation().reset(undefined, context);
      this.#log({ event: "memory.reset", conversationId: this.#conversation().id });
    } catch (error) {
      if (error instanceof MemoryError) throw memoryAppError(error);
      throw error;
    }
  }

  /**
   * Stop accepting new memory work. The integration holds no I/O of its own: durable tasks and
   * pending publications are the harness's records and survive its close, ready to resume on
   * the next open (§16.3). Call before closing the harness.
   */
  close(): void {
    this.#closed = true;
  }

  /**
   * Facts B is built from. The instructions are one: B is rendered to sit behind this exact
   * block A, so an upgraded prompt ends the cycle (§14.2). There is no external memory file:
   * workspace/MEMORY.md was retired (ADR-0004); long-term facts live in the working state and
   * daily archives this integration manages, whose changes flow through the cycle machinery
   * itself — so there is no memory version B depends on, and `memoryDigest` is honestly
   * `null`. A host that ever loads external memory content into B must supply its digest
   * here and accept cycle invalidation.
   */
  async currentFacts(): Promise<SnapshotFacts> {
    return { instructionsDigest: digestText(this.#options.instructions), memoryDigest: null };
  }

  /**
   * Boundary re-scan from persisted facts (§8): confirm every settled compaction task and, for
   * each confirmed switch, offer its newly covered range to the archive; then sweep the archive
   * reconciler until this pass is done. Best-effort per item — one failure is logged with its
   * safe code and never blocks the request or the other items.
   */
  async #rescan(context: Context): Promise<void> {
    const session = this.#session();
    const root = this.#conversation();
    try {
      const tasks = await session.commit(
        async (tx) => (await tx.scanTasks({ conversationId: root.id, kind: "pi.compaction" }, 40)).items,
        context,
      );
      const deps = createHarnessConfirmDeps(this.#harness!);
      for (const task of tasks) {
        if (task.state.status !== "terminal") continue;
        try {
          const archive = await readArchive(session, root.id, context);
          const confirmation = await confirmCompactionCycle(deps, root.id, task.id, context, {
            archivedThrough: archive?.archivedThrough ?? null,
          });
          if (confirmation.status === "switched" && confirmation.archiveRange !== null) {
            await requestArchive(session, root.id, confirmation.archiveRange.through, this.#archiveTask, context);
            this.#log({ event: "memory.archive.trigger", conversationId: root.id, action: "compaction-switch" });
          }
        } catch (error) {
          if (!(error instanceof MemoryError)) throw error;
          this.#log({ event: "memory.confirm", conversationId: root.id, action: "failed", code: error.appCode });
        }
      }
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      this.#log({ event: "memory.confirm", conversationId: root.id, action: "failed", code: error.appCode });
    }
    for (let sweep = 0; sweep < RECONCILE_MAX_SWEEPS; sweep += 1) {
      try {
        const { more } = await reconcileArchive(session, root.id, this.#archiveTask, Date.now(), context);
        if (!more) return;
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error;
        this.#log({ event: "memory.archive.reconcile", conversationId: root.id, action: "failed", code: error.appCode });
        return;
      }
    }
  }

  #session(): Harness {
    if (this.#harness === undefined) throw new MemoryError("invalid-input", "Memory integration is not attached to a harness");
    return this.#harness;
  }

  #conversation(): Conversation {
    if (this.#root === undefined) throw new MemoryError("invalid-input", "Memory integration is not attached to a conversation");
    return this.#root;
  }

  #assertOpen(): void {
    if (this.#closed) throw new MemoryError("cancelled", "Memory integration is closed");
  }
}

/** Construct the composition root; the application owns the returned object's lifecycle. */
export function createMemoryIntegration(options: MemoryIntegrationOptions): MemoryIntegration {
  return new MemoryIntegration(options);
}

/** A committed projection is unfinished application work until its input is admitted. */
export async function hasUnsubmittedMemoryProjection(storage: Storage, conversationId: ConversationId, context: Context): Promise<boolean> {
  const prefix = projectionRequestId("");
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId, status: "done" }, 100, cursor, context);
    for (const submission of page.items) {
      if (submission.type !== "write" || !submission.requestId?.startsWith(prefix)) continue;
      const input = await storage.submissionByRequest(conversationId, submission.requestId.slice(prefix.length), context);
      if (input === undefined) return true;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

/** The submission key of one request's context projection; stable across its retries. */
export function projectionRequestId(requestId: string): string {
  return `memory:projection:${requestId}`;
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function countUserTurns(entries: readonly { readonly kind: string }[]): number {
  return entries.filter((entry) => entry.kind === "pi.user").length;
}

type CycleScan = {
  readonly snapshot: CycleSnapshot | undefined;
  readonly workingInContext: (revision: number) => boolean;
};

/**
 * The active cycle as the view's own entries state it. The view starts at the head marker, so
 * everything visible here belongs to the active context: a compaction head decodes through the
 * MEM-06 compatibility path (a native summary yields no snapshot and blocks no projection), and
 * the newest application projection after it — boundary or revision — is read from its stored
 * data, never recomputed. `workingInContext` is decided by those recorded projections and the
 * snapshot's own baseline (§14.5 seam note): tool results are deliberately not parsed for it.
 */
function scanCycle(entries: readonly EntryRecord[]): CycleScan {
  let snapshot: CycleSnapshot | undefined;
  let snapshotIndex = -1;
  const projections: { index: number; revision: number }[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === "pi.compaction") {
      const decoded = publishedSnapshot(entry);
      if (decoded !== undefined) {
        snapshot = decoded;
        snapshotIndex = index;
      }
    } else if (entry.kind === CYCLE_SNAPSHOT_KIND) {
      const decoded = snapshotOfProjection(entry.data);
      if (decoded !== undefined) {
        snapshot = decoded;
        snapshotIndex = index;
        projections.push({ index, revision: decoded.baseline.revision });
      }
    } else if (entry.kind === REVISION_PROJECTION_KIND) {
      const data = entry.data as { baseline?: { revision?: unknown } } | undefined;
      if (typeof data?.baseline?.revision === "number") projections.push({ index, revision: data.baseline.revision });
    }
  });
  return {
    snapshot,
    workingInContext: (revision) =>
      (snapshot !== undefined && snapshot.baseline.revision === revision)
      || projections.some((projection) => projection.index >= snapshotIndex && projection.revision === revision),
  };
}

/**
 * Tokens the next compaction could actually replace: the active entries older than the retained
 * verbatim tail. The head marker (block B itself) and application projections are not content to
 * summarize, so they never count as compactable.
 */
function compactableTokens(
  view: { readonly entries: readonly { readonly kind: string }[]; readonly contributions: readonly (readonly Message[])[] },
  recentVerbatimTokens: number,
): number {
  let tail = 0;
  let compactable = 0;
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]!;
    if (entry.kind === "pi.compaction" || entry.kind === CYCLE_SNAPSHOT_KIND || entry.kind === REVISION_PROJECTION_KIND || entry.kind === "pi.reset") continue;
    const tokens = estimateTextTokens(messageText(view.contributions[index] ?? []));
    if (tail < recentVerbatimTokens) tail += tokens;
    else compactable += tokens;
  }
  return compactable;
}

function messageText(messages: readonly Message[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
  }).join("\n");
}
