// Working Module (MEM-02): the current business state, the preferences that outlive a task, and the
// observation-period user profile extracted from daily logs.
//
// Interface
//   readWorking(reader, conversationId)                     -> current state (initial when none)
//   readWorkingAt(reader, conversationId, anchor)            -> state at an application anchor
//   readWorkingReceipt(reader, conversationId, operationId)  -> stored result of one operation
//   readCompleted(tx, entryId)                              -> completion fact of a finished task
//   applyWorkingUpdate(session, request)                     -> `WorkingReceipt`
//
// Inputs: the model's `WorkingUpdateArgs` (validated against the schema before this module runs), a
// host-minted `operationId` stable across retries of the same native call, the host clock, and the
// host's conversation id. Entry ids are resolved to `SourceRef`s inside that conversation only, so
// identity, revision, and archive state are never model parameters.
//
// Errors: `invalid-input` (self-inconsistent change, already-expired preference, preference or
// profile limit, a profile evidence date that is not a real calendar day, removing an unknown id),
// `revision-conflict` (`expectedRevision` is not the stored revision), `missing-evidence` (an
// evidence entry or preference source is not committed in this conversation, a `task.set` has
// none, or a `profile.put` has no resolver or the resolver rejects a ref), `corrupt-state` (a
// stored value fails its schema). A rejection writes nothing.
// Profile evidence is a daily-segment ref. This module checks its shape and calendar date, then
// asks the injected resolver whether that segment is current. It does not open daily files.
//
// Side effects: one commit holding the state write, the anchor entry, the completion entry when a
// task was cleared, and the receipt. A replay of a known `operationId` returns its receipt and
// writes nothing; an update with no business effect increments no revision.

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, EntryId, Session, Tx } from "@earendil-works/pi-durable";
import {
  assertSchema,
  canonicalJson,
  dailyFileName,
  initialWorkingState,
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  WorkingAnchorEntry,
  WorkingCompletedEntry,
  WorkingCompletedSchema,
  WorkingDoc,
  WorkingReceiptDoc,
  WorkingReceiptSchema,
  WorkingStateSchema,
  WorkingUpdateArgsSchema,
  type ActiveTask,
  type DailySegmentRef,
  type ProfileItem,
  type ProfileItemDraft,
  type SourceRef,
  type WorkingChangeDraft,
  type WorkingCompleted,
  type WorkingReceipt,
  type WorkingState,
} from "./contracts.js";

/** The one operation this module needs from a Session or a tool's execution API. */
export type Committer = Pick<Session, "commit">;

/** The current state; a conversation without one reads the initial state, never `undefined`. */
export async function readWorking(
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<WorkingState> {
  const value = await reader.snapshot(WorkingDoc, conversationId, context);
  if (value === undefined) return initialWorkingState();
  return assertSchema<WorkingState>(WorkingStateSchema, value, "corrupt-state");
}

/** State at an application anchor; `not-covered` rather than a default or the newest state. */
export async function readWorkingAt(
  reader: Pick<Session, "snapshotAsOf">,
  conversationId: ConversationId,
  anchor: EntryId,
  context: Context,
): Promise<WorkingState> {
  let value: Readonly<WorkingState> | undefined;
  try {
    value = await reader.snapshotAsOf(WorkingDoc, conversationId, anchor, context);
  } catch (cause) {
    throw new MemoryError("not-covered", "Working state is not addressable from this conversation", { cause });
  }
  if (value === undefined) throw new MemoryError("not-covered", "No working state exists at that boundary");
  return assertSchema<WorkingState>(WorkingStateSchema, value, "corrupt-state");
}

/** Result of one operation, as stored. `undefined` means the operation never committed. */
export async function readWorkingReceipt(
  reader: DocumentReader,
  conversationId: ConversationId,
  operationId: string,
  context: Context,
): Promise<WorkingReceipt | undefined> {
  const stored = await reader.snapshot(WorkingReceiptDoc, conversationId, operationId, context);
  return stored === undefined ? undefined : assertSchema<WorkingReceipt>(WorkingReceiptSchema, stored, "corrupt-state");
}

/** The durable completion fact of a finished task, read from the entry its clearing update wrote. */
export async function readCompleted(
  tx: Pick<Tx, "entry">,
  entryId: EntryId,
): Promise<WorkingCompleted | undefined> {
  const entry = await tx.entry(WorkingCompletedEntry, entryId);
  return entry === undefined ? undefined : assertSchema<WorkingCompleted>(WorkingCompletedSchema, entry.data, "corrupt-state");
}

export type WorkingUpdateRequest = {
  readonly conversationId: ConversationId;
  /** Host-minted per native tool call; the idempotency key of this operation. */
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly evidence: readonly EntryId[];
  readonly changes: readonly WorkingChangeDraft[];
  /** Host clock in milliseconds. */
  readonly now: number;
  /**
   * Required when `changes` contain `profile.put`. Called inside the commit, after the receipt
   * replay check, so a retry of a committed operation does not re-resolve evidence. The resolver
   * rejects a ref that is missing or no longer current. This module does not open daily files.
   */
  readonly resolveProfileEvidence?: (refs: readonly DailySegmentRef[]) => Promise<void>;
};

/** Host check that profile evidence names current daily-log segments. */
export type ProfileEvidenceResolver = NonNullable<WorkingUpdateRequest["resolveProfileEvidence"]>;

/**
 * Seed of a receipt member that does not exist yet. A stored receipt always has a non-negative
 * `at`, so the sentinel identifies a first run without a second read.
 */
const UNSET_RECEIPT = { at: -1 } as unknown as WorkingReceipt;

/**
 * Apply one host-issued update. Every rejection happens before the commit writes anything, so a
 * failed call is safe to correct and retry under a new operation id.
 */
export async function applyWorkingUpdate(
  committer: Committer,
  request: WorkingUpdateRequest,
  context: Context,
): Promise<WorkingReceipt> {
  const args = validatedUpdate(request);
  return committer.commit((tx) => applyWorkingUpdateInTx(tx, request, args), context);
}

/** Schema check shared by the session commit and a caller that already holds a transaction. */
function validatedUpdate(request: WorkingUpdateRequest) {
  return assertSchema<{ expectedRevision: number; evidence: EntryId[]; changes: WorkingChangeDraft[] }>(
    WorkingUpdateArgsSchema,
    { expectedRevision: request.expectedRevision, evidence: request.evidence, changes: request.changes },
    "invalid-input",
  );
}

/**
 * Apply one update on a transaction the caller owns. A task runtime must use this inside its own
 * `commit`: returning the receipt from that callback would be read as the task's next state.
 * The caller commits; this function does not.
 */
export async function applyWorkingUpdateInTx(
  tx: Tx,
  request: WorkingUpdateRequest,
  args: { expectedRevision: number; evidence: EntryId[]; changes: WorkingChangeDraft[] } = validatedUpdate(request),
): Promise<WorkingReceipt> {
  const { conversationId } = request;
  // A replay returns the stored result without re-checking the revision or touching the state. The
    // draft cannot leave the commit — it is revoked once the commit settles — so the receipt is copied.
    const slot = await tx.doc(WorkingReceiptDoc, conversationId, request.operationId, UNSET_RECEIPT);
    if ((slot as WorkingReceipt).at !== UNSET_RECEIPT.at) {
      return detach(assertSchema<WorkingReceipt>(WorkingReceiptSchema, slot, "corrupt-state"));
    }

    const current = assertSchema<WorkingState>(WorkingStateSchema, await tx.doc(WorkingDoc, conversationId), "corrupt-state");
    // The draft is the value written below, so the previous revision is read before that write.
    const previousRevision = current.revision;
    if (current.revision !== args.expectedRevision) {
      throw new MemoryError("revision-conflict", `Working state is at revision ${current.revision}`, {
        detail: { expectedRevision: args.expectedRevision, revision: current.revision },
      });
    }
    const profileRefs = args.changes.flatMap((change) => change.op === "profile.put" ? change.item.evidence : []);
    if (profileRefs.length > 0) {
      if (request.resolveProfileEvidence === undefined) {
        throw new MemoryError("missing-evidence", "Profile evidence was not resolved");
      }
      await request.resolveProfileEvidence(profileRefs);
    }
    const referenced = new Set<EntryId>([
      ...args.evidence,
      ...args.changes.flatMap((change) => change.op === "task.set"
        ? change.task.progress.flatMap((item) => item.evidence)
        : change.op === "preference.put" ? [change.preference.source] : []),
    ]);
    const resolved = await resolveEvidence(tx, conversationId, referenced);
    const next = project(current, args.changes, args.evidence.map((id) => resolved.get(id)!), resolved, request.now);
    const changed = canonicalJson(next) !== canonicalJson(current);

    let completedEntryId: EntryId | null = null;
    if (current.task.status === "active" && next.task.status === "none") {
      completedEntryId = (await tx.appendEntry(WorkingCompletedEntry, conversationId, {
        data: completionOf(current.task, request.operationId, next.revision, request.now),
      })).id;
    }
    if (changed) Object.assign(await tx.doc(WorkingDoc, conversationId), next);
    const anchor = await tx.appendEntry(WorkingAnchorEntry, conversationId, {
      data: {
        version: MEMORY_SCHEMA_VERSION,
        operationId: request.operationId,
        revision: next.revision,
        changed,
        completedEntryId,
      },
    });
    const receipt: WorkingReceipt = {
      version: MEMORY_SCHEMA_VERSION,
      operationId: request.operationId,
      conversationId,
      expectedRevision: args.expectedRevision,
      previousRevision,
      revision: next.revision,
      changed,
      changes: args.changes.map((change) => detach(change)),
      anchorEntryId: anchor.id,
      completedEntryId,
      at: request.now,
    };
  Object.assign(slot, receipt);
  return receipt;
}

function completionOf(task: ActiveTask, operationId: string, revision: number, now: number): WorkingCompleted {
  return {
    version: MEMORY_SCHEMA_VERSION,
    operationId,
    revision,
    goal: task.goal,
    scope: task.scope,
    sources: task.sources.map((source) => ({ ...source })),
    at: now,
  };
}

/** Every referenced entry must be committed in this conversation; a stale or foreign id is rejected. */
async function resolveEvidence(
  tx: Tx,
  conversationId: ConversationId,
  ids: ReadonlySet<EntryId>,
): Promise<ReadonlyMap<EntryId, SourceRef>> {
  const resolved = new Map<EntryId, SourceRef>();
  for (const entryId of ids) {
    const entry = await tx.entry(entryId);
    if (entry === undefined || entry.conversationId !== conversationId) {
      throw new MemoryError("missing-evidence", "Evidence entry is not committed in this conversation", {
        detail: { conversationId, entryId },
      });
    }
    resolved.set(entryId, { conversationId, entryId });
  }
  return resolved;
}

/**
 * Apply the changes in order to a detached copy. The revision increments once for the whole update,
 * not per change; the caller compares the result with the current state to detect a no-op.
 */
function project(
  current: WorkingState,
  changes: readonly WorkingChangeDraft[],
  evidence: readonly SourceRef[],
  resolved: ReadonlyMap<EntryId, SourceRef>,
  now: number,
): WorkingState {
  let task: WorkingState["task"] = detach(current.task);
  const preferences = detach(current.preferences);
  const profile = detach(current.profile);
  for (const change of changes) {
    switch (change.op) {
      case "task.set": {
        if (evidence.length === 0) {
          throw new MemoryError("missing-evidence", "A task change needs at least one committed source");
        }
        task = {
          status: "active",
          goal: change.task.goal,
          scope: change.task.scope,
          constraints: [...change.task.constraints],
          progress: change.task.progress.map((item) => ({
            ...item,
            evidence: item.evidence.map((id) => resolved.get(id)!),
          })),
          blockers: [...change.task.blockers],
          nextStep: change.task.nextStep,
          notes: change.task.notes,
          sources: mergeSources(evidence),
        };
        break;
      }
      case "task.clear":
        task = { status: "none" };
        break;
      case "preference.put": {
        if (change.preference.expiresAt !== null && change.preference.expiresAt <= now) {
          throw new MemoryError("invalid-input", "A preference cannot be stored already expired", {
            detail: { id: change.preference.id, expiresAt: change.preference.expiresAt },
          });
        }
        const preference = { ...change.preference, source: resolved.get(change.preference.source)! };
        const index = preferences.findIndex((item) => item.id === preference.id);
        if (index === -1) {
          if (preferences.length >= MEMORY_LIMITS.preferences) {
            throw new MemoryError("invalid-input", "Preference limit reached; remove one first", {
              detail: { limit: MEMORY_LIMITS.preferences, id: preference.id },
            });
          }
          preferences.push(preference);
        } else {
          preferences[index] = preference;
        }
        break;
      }
      case "preference.remove": {
        const index = preferences.findIndex((item) => item.id === change.id);
        if (index === -1) {
          throw new MemoryError("invalid-input", "No preference has that id", { detail: { id: change.id } });
        }
        preferences.splice(index, 1);
        break;
      }
      case "profile.put": {
        // Shape and calendar day, the same bar a preference's source has to clear before it is stored.
        // The daily file itself is not opened: a missing segment is not `missing-evidence` here.
        for (const ref of change.item.evidence) dailyFileName(ref.date, ref.page);
        const index = profile.findIndex((item) => item.id === change.item.id);
        const existing = index === -1 ? undefined : profile[index];
        if (existing !== undefined && sameProfileContent(existing, change.item)) break;
        const item: ProfileItem = {
          id: change.item.id,
          text: change.item.text,
          category: change.item.category,
          evidence: change.item.evidence.map((ref) => ({ date: ref.date, id: ref.id, page: ref.page })),
          updatedAt: now,
        };
        if (index === -1) {
          if (profile.length >= MEMORY_LIMITS.profile) {
            throw new MemoryError("invalid-input", "Profile limit reached; remove one first", {
              detail: { limit: MEMORY_LIMITS.profile, id: item.id },
            });
          }
          profile.push(item);
        } else {
          profile[index] = item;
        }
        break;
      }
      case "profile.remove": {
        const index = profile.findIndex((item) => item.id === change.id);
        if (index === -1) {
          throw new MemoryError("invalid-input", "No profile item has that id", { detail: { id: change.id } });
        }
        profile.splice(index, 1);
        break;
      }
    }
  }
  const unchanged = canonicalJson(task) === canonicalJson(current.task)
    && canonicalJson(preferences) === canonicalJson(current.preferences)
    && canonicalJson(profile) === canonicalJson(current.profile);
  if (unchanged) return current;
  return { version: MEMORY_SCHEMA_VERSION, revision: current.revision + 1, task, preferences, profile, updatedAt: now };
}

/** Business fields only. A repeated put of the same fact keeps the stored `updatedAt` and revision. */
function sameProfileContent(stored: ProfileItem, draft: ProfileItemDraft): boolean {
  return stored.id === draft.id
    && stored.text === draft.text
    && stored.category === draft.category
    && canonicalJson(stored.evidence) === canonicalJson(draft.evidence);
}

/**
 * A detached JSON copy. A transaction draft is a tracked proxy rather than a plain object, so it cannot
 * be structured-cloned; JSON is exact for these values, which hold no `undefined`.
 */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Keep the newest evidence, dropping duplicates, so a repeated update cannot grow the state. */
function mergeSources(added: readonly SourceRef[]): SourceRef[] {
  const merged: SourceRef[] = [];
  for (const ref of added) {
    if (!merged.some((item) => item.conversationId === ref.conversationId && item.entryId === ref.entryId)) {
      merged.push({ ...ref });
    }
  }
  return merged.slice(-MEMORY_LIMITS.sources);
}

/** The active task, `undefined` when none; callers outside this module do not branch on `status`. */
export function activeTask(state: WorkingState): ActiveTask | undefined {
  return state.task.status === "active" ? state.task : undefined;
}
