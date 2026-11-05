// Durable archive adapter (MEM-05). A conversation-owned background Task is the single writer.
// The Document owns target/coverage and pending publication, not agent execution or delivery.
// All body and receipt writes precede the cursor commit. Closing preserves the current phase;
// explicit abort keeps pending work and requires retryArchive to resume it.
// When profile extraction is on, the cursor commit also puts current user-requirement segments
// into the working profile. Preferences are not changed.
import type { Context } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  defineDoc, defineTask, UsageDoc,
  type ConversationId, type EntryId, type Session, type TaskId, type TaskRuntime, type Tx,
} from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import {
  ArchiveBatchSchema, assertSchema, DAILY_MAX_PAGES, eventDate, MemoryError,
  MemoryErrorSchema, MemorySegmentSchema, SourceRangeSchema, WORKING_COMPLETED_KIND,
  WorkingDoc, WorkingStateSchema,
  type ArchiveBatch, type MemorySegment, type WorkingState,
} from "./contracts.js";
import {
  ARCHIVE_INSTRUCTIONS, ARCHIVE_LIMITS, ArchiveExtractionSchema, archiveSource, validateExtraction,
  type ArchiveSource,
} from "./archive.js";
import { identityOfSegment, publishSegments, readSegment, type DailyStore } from "./daily.js";
import {
  extractProfileDrafts,
  profileOperationId,
  profilePutChangesWithinLimit,
  requireCurrentProfileEvidence,
} from "./profile.js";
import { applyWorkingUpdateInTx } from "./working.js";

const Entry = SourceRangeSchema.properties.through;
const NullableEntry = Type.Union([Entry, Type.Null()]);
const PendingSchema = Type.Object({
  batch: ArchiveBatchSchema,
  body: Type.Union([Type.Array(MemorySegmentSchema, { maxItems: 200 }), Type.Null()]),
  confirmed: Type.Array(Type.String({ pattern: "^[a-f0-9]{16}$" }), { maxItems: 200 }),
  attempts: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export const ArchiveStateSchema = Type.Object({
  version: Type.Literal(1),
  initialized: Type.Boolean(),
  timezone: Type.String({ minLength: 1, maxLength: 64 }),
  archivedThrough: NullableEntry,
  target: NullableEntry,
  scanAfter: NullableEntry,
  activeTask: Type.Union([Type.Unsafe<TaskId>(Type.Integer({ minimum: 1 })), Type.Null()]),
  pending: Type.Union([PendingSchema, Type.Null()]),
  failure: Type.Union([MemoryErrorSchema, Type.Null()]),
}, { additionalProperties: false });
export type ArchiveState = Static<typeof ArchiveStateSchema>;

export const ArchiveDoc = defineDoc({
  kind: "personal.archive", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): ArchiveState => ({ version: 1, initialized: false, timezone: "UTC", archivedThrough: null,
    target: null, scanAfter: null, activeTask: null, pending: null, failure: null }),
});

type Checkpoint = { phase: "run"; step: number } | { phase: "retry"; until: number };
type Result = { archivedThrough: EntryId | null };
type Runtime = TaskRuntime<Record<string, never>, Checkpoint, Result, object>;
export type ArchiveBoundary = "extracted" | "saved" | "published" | "confirmed" | "before-cursor" | "profile";
export type ArchiveTaskOptions = {
  store: DailyStore;
  model: { provider: string; modelId: string };
  timeoutMs?: number;
  /**
   * Copy current user-requirement segments into the working profile when a batch is confirmed.
   * Default true. `false` still publishes the daily log and advances the cursor.
   */
  profile?: boolean;
  /** Optional host instrumentation; rejecting a boundary faults the Task, leaving its checkpoint. */
  boundary?: (name: ArchiveBoundary, signal: AbortSignal) => Promise<void>;
};

async function stateIn(tx: Tx, id: ConversationId) {
  const state = await tx.doc(ArchiveDoc, id);
  assertSchema<ArchiveState>(ArchiveStateSchema, state, "corrupt-state");
  return state;
}

export async function readArchive(reader: Pick<Session, "snapshot">, id: ConversationId, context: Context): Promise<ArchiveState | undefined> {
  const state = await reader.snapshot(ArchiveDoc, id, context);
  return state === undefined ? undefined : assertSchema<ArchiveState>(ArchiveStateSchema, state, "corrupt-state");
}

/** Explicit migration boundary: null enables full history only for a fresh conversation/test. */
export async function initializeArchive(session: Pick<Session, "commit">, id: ConversationId,
  after: EntryId | null, timezone: string, context: Context): Promise<void> {
  eventDate(0, timezone);
  await session.commit(async (tx) => {
    const conversation = await tx.conversation(id);
    if (conversation === undefined || conversation.parent !== undefined) {
      throw new MemoryError("not-covered", "Archive requires an unforked conversation");
    }
    if (after !== null && (await tx.entry(after))?.conversationId !== id) {
      throw new MemoryError("not-covered", "Archive origin is not in this conversation");
    }
    const state = await stateIn(tx, id);
    if (state.initialized) {
      if (state.timezone !== timezone) throw new MemoryError("revision-conflict", "Archive timezone is already fixed");
      return;
    }
    Object.assign(state, { initialized: true, timezone, archivedThrough: after, target: after, scanAfter: after });
  }, context);
}

function requireInitialized(state: ArchiveState): void {
  if (!state.initialized) throw new MemoryError("not-covered", "Archive migration boundary is not initialized");
}

/** Instantiate once per registry. Persistent configuration is the archive timezone; model is host-owned. */
export function createArchiveTask(options: ArchiveTaskOptions) {
  const timeoutMs = options.timeoutMs ?? ARCHIVE_LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new MemoryError("invalid-input", "Archive timeout must be 1..300000 ms");
  }
  const boundary = async (name: ArchiveBoundary, runtime: Runtime) => {
    await options.boundary?.(name, runtime.signal);
    runtime.signal.throwIfAborted();
  };
  const task = defineTask<Record<string, never>, Checkpoint, Result>({
    name: "personal.archive", version: 1, initial: () => ({ phase: "run", step: 0 }),
    phases: {
      run: async (_task, runtime, context) => {
        const state = await readArchive(runtime, runtime.conversationId, context);
        if (state === undefined) throw new MemoryError("corrupt-state", "Archive state is missing");
        requireInitialized(state);
        if (state.activeTask !== runtime.taskId) throw new MemoryError("revision-conflict", "Archive writer is not the owner");
        if (state.pending === null) {
          // Fix a bounded contiguous range before any model I/O. Read native history, not active context.
          await runtime.commit(async (tx) => {
            const current = await stateIn(tx, runtime.conversationId);
            if (current.target === null || (current.archivedThrough ?? 0) >= current.target) {
              current.activeTask = null;
              return { status: "terminal", outcome: { status: "completed", result: { archivedThrough: current.archivedThrough } } };
            }
            const page = await tx.scanEntries({ conversationId: runtime.conversationId, order: "ascending",
              minEntryId: ((current.archivedThrough ?? 0) + 1) as EntryId, maxEntryId: current.target }, ARCHIVE_LIMITS.entries);
            if (page.items.length === 0) throw new MemoryError("not-covered", "Archive target contains no visible entries");
            let bytes = 0;
            let through: EntryId | undefined;
            for (const entry of page.items) {
              const source = archiveSource(entry, current.timezone);
              const size = source === undefined ? 0 : Buffer.byteLength(JSON.stringify(source));
              if (bytes + size > ARCHIVE_LIMITS.sourceBytes && through !== undefined) break;
              // Keep an oversized first entry in a fixed batch; extraction fails explicitly without skipping it.
              bytes += size;
              through = entry.id;
              if (bytes > ARCHIVE_LIMITS.sourceBytes) break;
            }
            const batch: ArchiveBatch = {
              version: 1, id: `archive:${runtime.conversationId}:${current.archivedThrough ?? 0}:${through!}`,
              conversationId: runtime.conversationId,
              sources: { conversationId: runtime.conversationId, after: current.archivedThrough, through: through! },
              formatVersion: 1, timezone: current.timezone, createdAt: runtime.now(), segments: [],
            };
            assertSchema(ArchiveBatchSchema, batch, "invalid-input");
            current.pending = { batch, body: null, confirmed: [], attempts: 0 };
            return { status: "running", checkpoint: { phase: "run", step: _task.state.checkpoint.step + 1 } };
          }, context);
          return;
        }
        const pending = state.pending;
        if (pending.body === null) {
          let sources: ArchiveSource[] = [];
          await runtime.commit(async (tx) => {
            const page = await tx.scanEntries({ conversationId: runtime.conversationId, order: "ascending",
              minEntryId: ((pending.batch.sources.after ?? 0) + 1) as EntryId,
              maxEntryId: pending.batch.sources.through }, ARCHIVE_LIMITS.entries);
            sources = page.items.flatMap((entry) => {
              const source = archiveSource(entry, pending.batch.timezone);
              return source === undefined ? [] : [source];
            });
          }, context);
          if (Buffer.byteLength(JSON.stringify(sources)) > ARCHIVE_LIMITS.sourceBytes) {
            await fail(runtime, new MemoryError("budget-exceeded", "Archive source exceeds its input bound"), context, false);
            return;
          }
          // Budget attempts durably before I/O: repeated crashes cannot cause unbounded automatic calls.
          if (pending.attempts >= ARCHIVE_LIMITS.attempts) {
            await fail(runtime, new MemoryError("model-failure", "Archive extraction attempts exhausted"), context, false);
            return;
          }
          await runtime.commit(async (tx) => { (await stateIn(tx, runtime.conversationId)).pending!.attempts++; }, context);
          let body: MemorySegment[];
          if (sources.length === 0) body = [];
          else {
            const model = runtime.models.getModel(options.model.provider, options.model.modelId);
            if (model === undefined) {
              await fail(runtime, new MemoryError("model-failure", "Archive model is unavailable"), context, false);
              return;
            }
            let message;
            try {
              message = await runtime.models.completeSimple(model, { messages: [
                { role: "system", content: `${ARCHIVE_INSTRUCTIONS}\n${JSON.stringify(ArchiveExtractionSchema)}`, timestamp: pending.batch.createdAt },
                { role: "user", content: JSON.stringify(sources), timestamp: pending.batch.createdAt },
              ] }, { signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(timeoutMs)]),
                cacheRetention: "none", maxTokens: Math.min(8192, model.maxTokens || 8192) });
            } catch (error) {
              runtime.signal.throwIfAborted();
              await fail(runtime, new MemoryError("model-failure", "Archive model transport failed", { cause: error }), context, true);
              return;
            }
            runtime.signal.throwIfAborted();
            // Usage and the accepted body share a commit. A pre-commit crash may repeat model I/O;
            // provider spend for that uncommitted response is unknown, as with native generation.
            let extractionError: MemoryError | undefined;
            try {
              if (message.stopReason !== "stop") throw new MemoryError("model-failure", "Archive model did not complete");
              const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
              if (Buffer.byteLength(text) > ARCHIVE_LIMITS.outputBytes) throw new MemoryError("budget-exceeded", "Archive output is too large");
              body = validateExtraction(pending.batch, sources, JSON.parse(text));
            } catch (error) {
              extractionError = error instanceof MemoryError ? error : new MemoryError("invalid-input", "Archive model returned invalid JSON");
              body = [];
            }
            await boundary("extracted", runtime);
            await runtime.commit(async (tx) => {
              await addUsage(tx, runtime.conversationId, message.usage);
              if (extractionError === undefined) saveBody(await stateIn(tx, runtime.conversationId), body);
            }, context);
            if (extractionError !== undefined) {
              await fail(runtime, extractionError, context, true);
              return;
            }
          }
          if (sources.length === 0) await runtime.commit(async (tx) => { saveBody(await stateIn(tx, runtime.conversationId), body); }, context);
          await boundary("saved", runtime);
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", step: _task.state.checkpoint.step + 1 } }), context);
          return;
        }
        const index = pending.confirmed.length;
        if (index < pending.body.length) {
          const segment = pending.body[index]!;
          if (pending.attempts >= ARCHIVE_LIMITS.attempts) {
            await fail(runtime, new MemoryError("io-failure", "Archive publication attempts exhausted"), context, false);
            return;
          }
          await runtime.commit(async (tx) => { (await stateIn(tx, runtime.conversationId)).pending!.attempts++; }, context);
          runtime.signal.throwIfAborted();
          try {
            // Daily publication is finite and awaited even on abort. Its atomic replacement cannot
            // be interrupted halfway; cancellation stops the next I/O and recovery checks this ID.
            const receipts = await publishSegments(options.store, [segment]);
            if (receipts[0]?.digest !== identityOfSegment(segment)) throw new MemoryError("corrupt-state", "Archive receipt does not match saved body");
          } catch (error) {
            runtime.signal.throwIfAborted();
            if (!(error instanceof MemoryError)) throw error;
            if (error.code === "budget-exceeded" && segment.page < DAILY_MAX_PAGES) {
              await runtime.commit(async (tx) => {
                const current = (await stateIn(tx, runtime.conversationId)).pending!;
                current.body![index]!.page++;
                current.batch.segments[index]!.page++;
                current.attempts = 0;
                return { status: "running", checkpoint: { phase: "run", step: _task.state.checkpoint.step + 1 } };
              }, context);
              return;
            }
            await fail(runtime, error, context, error.code === "io-failure");
            return;
          }
          await boundary("published", runtime);
          await runtime.commit(async (tx) => {
            const current = (await stateIn(tx, runtime.conversationId)).pending!;
            current.confirmed.push(identityOfSegment(segment));
            current.attempts = 0;
            return { status: "running", checkpoint: { phase: "run", step: _task.state.checkpoint.step + 1 } };
          }, context);
          await boundary("confirmed", runtime);
          return;
        }
        await boundary("before-cursor", runtime);
        let profileDrafts: ReturnType<typeof extractProfileDrafts> = [];
        if (options.profile !== false) {
          try {
            profileDrafts = await publishedProfileDrafts(options.store, pending.body ?? []);
          } catch (error) {
            runtime.signal.throwIfAborted();
            const failure = error instanceof MemoryError
              ? error
              : new MemoryError("io-failure", "Profile update failed", { cause: error });
            await runtime.commit(async (tx) => {
              const current = await stateIn(tx, runtime.conversationId);
              if (current.pending !== null) current.pending.attempts++;
            }, context);
            const retryable = failure.code === "io-failure" || failure.code === "missing-evidence";
            await fail(runtime, failure, context, retryable);
            return;
          }
        }
        await runtime.commit(async (tx) => {
          const current = await stateIn(tx, runtime.conversationId);
          const saved = current.pending!;
          if (saved.batch.sources.after !== current.archivedThrough || saved.body === null ||
              saved.body.length !== saved.confirmed.length || saved.body.some((segment, i) => identityOfSegment(segment) !== saved.confirmed[i])) {
            throw new MemoryError("corrupt-state", "Archive confirmation is not a continuous complete prefix");
          }
          if (profileDrafts.length > 0) {
            const working = assertSchema<WorkingState>(
              WorkingStateSchema,
              await tx.doc(WorkingDoc, runtime.conversationId),
              "corrupt-state",
            );
            const changes = profilePutChangesWithinLimit(working.profile, profileDrafts);
            if (changes.length > 0) {
              await applyWorkingUpdateInTx(tx, {
                conversationId: runtime.conversationId,
                operationId: profileOperationId(saved.batch.id),
                expectedRevision: working.revision,
                evidence: [],
                changes,
                now: runtime.now(),
                resolveProfileEvidence: (refs) => requireCurrentProfileEvidence(options.store, refs),
              });
            }
          }
          current.archivedThrough = saved.batch.sources.through;
          current.pending = null;
          current.failure = null;
          return { status: "running", checkpoint: { phase: "run", step: _task.state.checkpoint.step + 1 } };
        }, context);
        if (options.profile !== false) await boundary("profile", runtime);
      },
      retry: async (task, runtime, context) => {
        await runtime.sleep(task.state.checkpoint.until, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", step: 0 } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await stateIn(tx, runtime.conversationId);
        state.activeTask = null;
        state.failure = new MemoryError("cancelled", "Archive was cancelled; pending publication retained").toJSON();
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
  return task;
}
export type ArchiveTask = ReturnType<typeof createArchiveTask>;

/**
 * Drafts for the profile write that shares the cursor commit. A published segment that is not in
 * the daily log is `missing-evidence`. A segment a later record has superseded is not current and
 * is left out. File reads stay outside the session commit.
 */
async function publishedProfileDrafts(store: DailyStore, body: readonly MemorySegment[]) {
  const current: MemorySegment[] = [];
  for (const segment of body) {
    const found = await readSegment(store, { id: segment.id, date: segment.date, page: segment.page });
    if (!found.found) {
      throw new MemoryError("missing-evidence", "Published profile source is not in the daily log", {
        detail: { id: segment.id, date: segment.date, page: segment.page, reason: found.reason },
      });
    }
    if (found.record.segment.supersededBy !== null) continue;
    current.push(found.record.segment);
  }
  return extractProfileDrafts(current);
}

function saveBody(state: ArchiveState, body: MemorySegment[]): void {
  state.pending!.body = body;
  state.pending!.batch.segments = body.map(({ id, date, page }) => ({ id, date, page }));
  state.pending!.attempts = 0;
  state.failure = null;
}

async function addUsage(tx: Tx, id: ConversationId, usage: Usage): Promise<void> {
  const buckets = (await tx.doc(UsageDoc, id)).models;
  const total = buckets["app/archive"] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
  buckets["app/archive"] = total;
}

async function fail(runtime: Runtime, error: MemoryError, context: Context, retryable: boolean): Promise<void> {
  await runtime.commit(async (tx) => {
    const state = await stateIn(tx, runtime.conversationId);
    state.failure = error.toJSON();
    if (retryable && state.pending!.attempts < ARCHIVE_LIMITS.attempts) {
      return { status: "running", checkpoint: { phase: "retry", until: runtime.now() + ARCHIVE_LIMITS.retryMs } };
    }
    state.activeTask = null;
    return { status: "terminal", outcome: { status: "failed", error: { message: error.message, detail: error.toJSON() } } };
  }, context);
}

async function startIn(tx: Tx, id: ConversationId, state: ArchiveState, task: ArchiveTask, retry: boolean): Promise<TaskId | null> {
  requireInitialized(state);
  if (state.activeTask !== null) {
    const running = await tx.task(state.activeTask);
    if (running === undefined) throw new MemoryError("corrupt-state", "Archive writer task is missing");
    if (running.state.status !== "terminal") return state.activeTask;
    // Unexpected phase faults retain the durable diagnostic and require an explicit retry.
    state.failure ??= new MemoryError("io-failure", "Archive task stopped before confirmation").toJSON();
    state.activeTask = null;
  }
  if (state.failure !== null && !retry) return null;
  if (state.target === null || (state.archivedThrough ?? 0) >= state.target) return null;
  if (retry) {
    state.failure = null;
    if (state.pending !== null) state.pending.attempts = 0;
  }
  state.activeTask = await tx.createTask(task, {}, { conversationId: id, ownership: { kind: "conversation" }, background: true });
  return state.activeTask;
}

/** Trusted host boundary: pass only a confirmed completion/compaction cutoff, never a queued summary. */
export async function requestArchive(session: Pick<Session, "commit">, id: ConversationId, through: EntryId,
  task: ArchiveTask, context: Context): Promise<TaskId | null> {
  return session.commit(async (tx) => {
    if ((await tx.entry(through))?.conversationId !== id) throw new MemoryError("not-covered", "Archive target is not in this conversation");
    const state = await stateIn(tx, id);
    requireInitialized(state);
    if (through > (state.target ?? 0)) state.target = through;
    return startIn(tx, id, state, task, false);
  }, context);
}

export async function retryArchive(session: Pick<Session, "commit">, id: ConversationId, task: ArchiveTask,
  context: Context): Promise<TaskId | null> {
  return session.commit(async (tx) => startIn(tx, id, await stateIn(tx, id), task, true), context);
}

/** One bounded durable sweep. Repeat while more=true, at startup/request boundaries (MEM-07).
 * The latest persisted head proves publication, including native blocking compactions. Completed
 * events and past event dates are discovered from Entries; notifications are only an optimization.
 */
export async function reconcileArchive(session: Pick<Session, "commit">, id: ConversationId, task: ArchiveTask,
  now: number, context: Context): Promise<{ more: boolean; taskId: TaskId | null }> {
  if (!Number.isFinite(now) || now < 0) throw new MemoryError("invalid-input", "Archive clock is invalid");
  return session.commit(async (tx) => {
    const state = await stateIn(tx, id);
    requireInitialized(state);
    let target = state.target;
    const marker = await tx.latestHeadMarker(id);
    if (marker?.kind === "pi.compaction") {
      const prefix = await tx.scanEntries({ conversationId: id, maxEntryId: (marker.head - 1) as EntryId, order: "descending" }, 1);
      const cutoff = prefix.items[0]?.id;
      if (cutoff !== undefined && cutoff > (target ?? 0)) target = cutoff;
    }
    const page = await tx.scanEntries({ conversationId: id, order: "ascending",
      minEntryId: (Math.max(state.scanAfter ?? 0, state.archivedThrough ?? 0) + 1) as EntryId }, ARCHIVE_LIMITS.entries);
    const today = eventDate(now, state.timezone);
    for (const entry of page.items) {
      const source = archiveSource(entry, state.timezone);
      if (entry.kind === WORKING_COMPLETED_KIND || (source !== undefined && source.date !== "unknown" && source.date < today)) {
        if (entry.id > (target ?? 0)) target = entry.id;
      }
    }
    state.target = target;
    const more = page.next !== undefined;
    state.scanAfter = more ? page.items.at(-1)!.id : state.archivedThrough;
    return { more, taskId: await startIn(tx, id, state, task, false) };
  }, context);
}
