// MEM-01 frozen contracts for application-owned memory data (schema version 1).
//
// This module is the single source of types and runtime validation for the data this project
// owns. SDK-owned values (Message, EntryRecord, EntryId, ConversationId, TaskId, UsageDoc) are
// referenced, never redefined. Each module's boundary is fixed here:
//
//   Working      read at a boundary (`workingAtBoundary`), apply `WorkingUpdate` with
//                `expectedRevision`; returns a `WorkingReceipt` and appends a `WorkingAnchor` entry
//                in the same commit. The state holds the active task, preferences, and the
//                observation-period user profile. Errors: invalid-input, revision-conflict,
//                missing-evidence, not-covered, corrupt-state. Side effects: one document write,
//                one entry append, one receipt document per operation id.
//   Context      pure: given a `CycleSnapshot` and budget it produces a `ContextPlan`; it performs
//                no I/O, no model call, and no ordering of its own. Errors are reported in the plan
//                (`action.kind === "error"`), never thrown for data conditions.
//   Daily Memory publish `MemorySegment`s to `dailyFileName()`; the file layout is fixed below.
//   Archive      owns `ArchiveBatch`: a `SourceRange` of raw entries, a bounded segment list, and
//                the rule that the cursor advances only after every segment of the batch is
//                confirmed. Errors: invalid-input, io-failure, model-failure, cancelled.
//   Adapter      maps these contracts onto Documents, Entries and Tasks; it owns the SDK
//                ordering rules verified by `test/memory-contract.test.ts`.
//
// Range semantics are fixed everywhere: a `SourceRange` covers entries `(after, through]` — an
// exclusive lower bound and an inclusive upper bound over EntryId. `after: null` starts at the
// beginning of the conversation's visible history. Empty when `after === through`.

import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineEntry,
  type ConversationId,
  type EntryId,
  type JsonObject,
  type Session,
} from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** Bump with a `migrate` in the owning definition; every stored value carries its version. */
export const MEMORY_SCHEMA_VERSION = 1;
/**
 * Structural version of `personal.working` only. Version 1 has no `profile` field;
 * `migrateWorkingDocument` adds an empty list. The JSON `version` field stays
 * `MEMORY_SCHEMA_VERSION`, because that literal is shared with snapshots, segments, and receipts.
 */
export const WORKING_DOC_VERSION = 2;
export const WORKING_DOC_KIND = "personal.working";
export const WORKING_ANCHOR_KIND = "personal.working.anchor";
export const WORKING_COMPLETED_KIND = "personal.working.completed";
export const WORKING_RECEIPT_KIND = "personal.working.receipt";
export const CYCLE_SNAPSHOT_KIND = "personal.cycle";
export const CYCLE_BLOCK_OPEN = "<cycle-snapshot>";
export const CYCLE_BLOCK_CLOSE = "</cycle-snapshot>";
/** A revision the active context lacks; carried in C so the model reads the current state. */
export const REVISION_BLOCK_OPEN = "<working-revision>";
export const REVISION_BLOCK_CLOSE = "</working-revision>";
export const DAILY_DIRECTORY = "memory/daily";
export const DAILY_MAX_PAGES = 9;
export const UNKNOWN_DATE = "unknown";

const DailyDateSchema = Type.String({ pattern: `^(\\d{4}-\\d{2}-\\d{2}|${UNKNOWN_DATE})$` });

/** Bounds on every stored value; oversized input is rejected, never truncated silently. */
export const MEMORY_LIMITS = {
  identifier: 64,
  goal: 500,
  text: 400,
  note: 2_000,
  summary: 12_000,
  constraints: 16,
  progress: 24,
  preferences: 32,
  /** Profile items on the working state. Same cap as preferences. */
  profile: 32,
  /** Category label on a profile item. Same character cap as an identifier. */
  category: 64,
  sources: 16,
  changes: 32,
  segments: 200,
  narrative: 12_000,
  instructions: 32_000,
  snapshotText: 24_000,
} as const;

const Version = Type.Literal(MEMORY_SCHEMA_VERSION);
const Identifier = Type.String({ pattern: "^[A-Za-z0-9._:#-]{1,64}$" });
const Timestamp = Type.Integer({ minimum: 0 });
const EntryIdSchema = Type.Unsafe<EntryId>(Type.Integer({ minimum: 1 }));
const ConversationIdSchema = Type.Unsafe<ConversationId>(Type.Integer({ minimum: 1 }));
const JsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());
const MessageSchema = Type.Unsafe<Message>(Type.Unknown());
const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });

/** Where one fact came from: a committed entry of a conversation. */
export const SourceRefSchema = Type.Object(
  { conversationId: ConversationIdSchema, entryId: EntryIdSchema },
  { additionalProperties: false },
);
export type SourceRef = Static<typeof SourceRefSchema>;

/** Entries `(after, through]`; `after: null` means from the beginning of the visible history. */
export const SourceRangeSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    after: Type.Union([EntryIdSchema, Type.Null()]),
    through: EntryIdSchema,
  },
  { additionalProperties: false },
);
export type SourceRange = Static<typeof SourceRangeSchema>;

export function isEmptyRange(range: SourceRange): boolean {
  return range.after !== null && range.after >= range.through;
}

export function rangeCovers(range: SourceRange, entryId: EntryId): boolean {
  return (range.after === null || entryId > range.after) && entryId <= range.through;
}

const ProgressItemSchema = Type.Object(
  {
    id: Identifier,
    text: Text(MEMORY_LIMITS.text),
    status: Type.Union([Type.Literal("done"), Type.Literal("in-progress"), Type.Literal("blocked")]),
    evidence: Type.Array(SourceRefSchema, { maxItems: MEMORY_LIMITS.sources }),
  },
  { additionalProperties: false },
);

/** Model-visible progress item: evidence is an entry id; the host supplies the conversation. */
const ProgressItemDraftSchema = Type.Object(
  {
    id: Identifier,
    text: Text(MEMORY_LIMITS.text),
    status: Type.Union([Type.Literal("done"), Type.Literal("in-progress"), Type.Literal("blocked")]),
    evidence: Type.Array(EntryIdSchema, { maxItems: MEMORY_LIMITS.sources }),
  },
  { additionalProperties: false },
);

const ActiveTaskSchema = Type.Object(
  {
    status: Type.Literal("active"),
    goal: Text(MEMORY_LIMITS.goal),
    scope: Type.Union([Text(MEMORY_LIMITS.goal), Type.Null()]),
    constraints: Type.Array(Text(MEMORY_LIMITS.text), { maxItems: MEMORY_LIMITS.constraints }),
    progress: Type.Array(ProgressItemSchema, { maxItems: MEMORY_LIMITS.progress }),
    blockers: Type.Array(Text(MEMORY_LIMITS.text), { maxItems: MEMORY_LIMITS.constraints }),
    nextStep: Type.Union([Text(MEMORY_LIMITS.text), Type.Null()]),
    notes: Type.Union([Text(MEMORY_LIMITS.note), Type.Null()]),
    sources: Type.Array(SourceRefSchema, { maxItems: MEMORY_LIMITS.sources }),
  },
  { additionalProperties: false },
);
export type ActiveTask = Static<typeof ActiveTaskSchema>;

/** The stored task minus `sources`: the host fills them from the update's own evidence. */
const ActiveTaskDraftSchema = Type.Object(
  {
    status: Type.Literal("active"),
    goal: Text(MEMORY_LIMITS.goal),
    scope: Type.Union([Text(MEMORY_LIMITS.goal), Type.Null()]),
    constraints: Type.Array(Text(MEMORY_LIMITS.text), { maxItems: MEMORY_LIMITS.constraints }),
    progress: Type.Array(ProgressItemDraftSchema, { maxItems: MEMORY_LIMITS.progress }),
    blockers: Type.Array(Text(MEMORY_LIMITS.text), { maxItems: MEMORY_LIMITS.constraints }),
    nextStep: Type.Union([Text(MEMORY_LIMITS.text), Type.Null()]),
    notes: Type.Union([Text(MEMORY_LIMITS.note), Type.Null()]),
  },
  { additionalProperties: false },
);

/** A preference needs a user source, a scope, and an optional expiry; task completion never clears it. */
export const PreferenceSchema = Type.Object(
  {
    id: Identifier,
    text: Text(MEMORY_LIMITS.text),
    scope: Text(MEMORY_LIMITS.text),
    source: SourceRefSchema,
    expiresAt: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Preference = Static<typeof PreferenceSchema>;

/** Model-visible preference: the source is an entry id, resolved to a `SourceRef` by the host. */
const PreferenceDraftSchema = Type.Object(
  {
    id: Identifier,
    text: Text(MEMORY_LIMITS.text),
    scope: Text(MEMORY_LIMITS.text),
    source: EntryIdSchema,
    expiresAt: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * One daily-log segment. Same fields as Daily Memory's `SegmentRef`, with `page` required so a
 * missing page is not filled in. `date` is the event date, not the day the profile was written.
 */
export const DailySegmentRefSchema = Type.Object(
  {
    date: DailyDateSchema,
    id: Identifier,
    page: Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES }),
  },
  { additionalProperties: false },
);
export type DailySegmentRef = Static<typeof DailySegmentRefSchema>;

const profileFields = {
  id: Identifier,
  text: Text(MEMORY_LIMITS.text),
  category: Text(MEMORY_LIMITS.category),
  evidence: Type.Array(DailySegmentRefSchema, { minItems: 1, maxItems: MEMORY_LIMITS.sources }),
};

/** Model-visible profile item. The host sets `updatedAt`; the model cannot. */
export const ProfileItemDraftSchema = Type.Object(profileFields, { additionalProperties: false });
export type ProfileItemDraft = Static<typeof ProfileItemDraftSchema>;

/** A stored profile fact. `updatedAt` is the host clock and must not enter a rendered snapshot. */
export const ProfileItemSchema = Type.Object(
  { ...profileFields, updatedAt: Timestamp },
  { additionalProperties: false },
);
export type ProfileItem = Static<typeof ProfileItemSchema>;

/** The profile fact as a snapshot renders it: the same item without its write time. */
const ProfileBaselineItemSchema = ProfileItemDraftSchema;

/**
 * Current business state. Every field is required and absence is `null` or an empty array, so a
 * stored value never contains `undefined`. `revision` starts at 1 and increments only on a business
 * change; `updatedAt` is wall-clock milliseconds and must never enter a rendered snapshot. Each
 * profile item has its own `updatedAt`, and that clock is stripped the same way.
 */
export const WorkingStateSchema = Type.Object(
  {
    version: Version,
    revision: Type.Integer({ minimum: 1 }),
    task: Type.Union([Type.Object({ status: Type.Literal("none") }, { additionalProperties: false }), ActiveTaskSchema]),
    preferences: Type.Array(PreferenceSchema, { maxItems: MEMORY_LIMITS.preferences }),
    profile: Type.Array(ProfileItemSchema, { maxItems: MEMORY_LIMITS.profile }),
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type WorkingState = Static<typeof WorkingStateSchema>;

/**
 * A boundary projection of `WorkingState`: everything a snapshot renders, without `updatedAt`.
 * The write time belongs to the state's own history, not to the cycle snapshot — the boundary anchor
 * already pins when the value was true, and a rendered snapshot must not carry a per-write timestamp.
 */
export const WorkingBaselineSchema = Type.Object(
  {
    version: Version,
    revision: Type.Integer({ minimum: 1 }),
    task: WorkingStateSchema.properties.task,
    preferences: WorkingStateSchema.properties.preferences,
    profile: Type.Array(ProfileBaselineItemSchema, { maxItems: MEMORY_LIMITS.profile }),
  },
  { additionalProperties: false },
);
export type WorkingBaseline = Static<typeof WorkingBaselineSchema>;

export function baselineOf(state: WorkingState): WorkingBaseline {
  return {
    version: state.version,
    revision: state.revision,
    task: state.task,
    preferences: state.preferences,
    profile: state.profile.map((item) => ({
      id: item.id,
      text: item.text,
      category: item.category,
      evidence: item.evidence.map((ref) => ({ date: ref.date, id: ref.id, page: ref.page })),
    })),
  };
}

/**
 * Render a baseline as the model reads it. This is the text a within-cycle revision carries into C, and
 * the same text a snapshot's baseline renders to, so a revision never restates a fact in another shape.
 * Deterministic: no clock, no state or profile-item `updatedAt`, keys in a fixed order.
 */
export function renderBaseline(baseline: WorkingBaseline): string {
  return canonicalJson(baseline);
}

export function initialWorkingState(): WorkingState {
  return {
    version: MEMORY_SCHEMA_VERSION,
    revision: 1,
    task: { status: "none" },
    preferences: [],
    profile: [],
    updatedAt: 0,
  };
}

/**
 * Model-visible arguments of `working_update`. Conversation identity and the operation id are not
 * parameters: the host supplies them. Entry ids in `evidence`, `progress[].evidence`, and
 * `preference.source` are resolved to `SourceRef`s inside the calling conversation, so a model
 * cannot point a fact at another conversation's history.
 */
export const WorkingUpdateArgsSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    /** Entries that evidence this update. A `task.set` requires at least one; the host checks it. */
    evidence: Type.Array(EntryIdSchema, { maxItems: MEMORY_LIMITS.sources }),
    changes: Type.Array(
      Type.Union([
        Type.Object({ op: Type.Literal("task.set"), task: ActiveTaskDraftSchema }, { additionalProperties: false }),
        Type.Object({ op: Type.Literal("task.clear") }, { additionalProperties: false }),
        Type.Object({ op: Type.Literal("preference.put"), preference: PreferenceDraftSchema }, { additionalProperties: false }),
        Type.Object({ op: Type.Literal("preference.remove"), id: Identifier }, { additionalProperties: false }),
        Type.Object({ op: Type.Literal("profile.put"), item: ProfileItemDraftSchema }, { additionalProperties: false }),
        Type.Object({ op: Type.Literal("profile.remove"), id: Identifier }, { additionalProperties: false }),
      ]),
      { minItems: 1, maxItems: MEMORY_LIMITS.changes },
    ),
  },
  { additionalProperties: false },
);
export type WorkingUpdateArgs = Static<typeof WorkingUpdateArgsSchema>;

/** A model-visible change, before the host resolves entry ids to conversation-scoped sources. */
export type WorkingChangeDraft = WorkingUpdateArgs["changes"][number];

/**
 * One host-issued update: the model's arguments plus the host's identity. `operationId` is minted by
 * the host per native tool call and kept stable across retries; it is the idempotency key.
 */
export const WorkingUpdateSchema = Type.Object(
  {
    operationId: Identifier,
    conversationId: ConversationIdSchema,
    expectedRevision: Type.Integer({ minimum: 1 }),
    evidence: WorkingUpdateArgsSchema.properties.evidence,
    changes: WorkingUpdateArgsSchema.properties.changes,
  },
  { additionalProperties: false },
);
export type WorkingUpdate = Static<typeof WorkingUpdateSchema>;
export type WorkingChange = WorkingUpdate["changes"][number];

/**
 * Result of one accepted update. `changed: false` means the state had no business change: the
 * revision is unchanged and `changes` is empty. A replay of the same `operationId` returns the
 * stored receipt instead of applying the update again. `completed` records the task this update
 * finished, so a retried archive can find the completion without re-reading the live state.
 */
export const WorkingReceiptSchema = Type.Object(
  {
    version: Version,
    operationId: Identifier,
    conversationId: ConversationIdSchema,
    expectedRevision: Type.Integer({ minimum: 1 }),
    previousRevision: Type.Integer({ minimum: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    changed: Type.Boolean(),
    changes: Type.Array(JsonValueSchema, { maxItems: MEMORY_LIMITS.changes }),
    anchorEntryId: EntryIdSchema,
    completedEntryId: Type.Union([EntryIdSchema, Type.Null()]),
    at: Timestamp,
  },
  { additionalProperties: false },
);
export type WorkingReceipt = Static<typeof WorkingReceiptSchema>;

/**
 * Application entry appended in the same commit as the document write. It anchors the rewindable
 * state, so `snapshotAsOf` at this entry yields exactly the revision the receipt reports.
 */
export const WorkingAnchorSchema = Type.Object(
  {
    version: Version,
    operationId: Identifier,
    revision: Type.Integer({ minimum: 1 }),
    changed: Type.Boolean(),
    /** The completion entry this update wrote, when it cleared a task. */
    completedEntryId: Type.Union([EntryIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkingAnchor = Static<typeof WorkingAnchorSchema>;

/**
 * A finished task, written in the same commit that clears the active task. It keeps the completion
 * fact durable and addressable after the live state is gone, so an archive run can retry from it.
 */
export const WorkingCompletedSchema = Type.Object(
  {
    version: Version,
    operationId: Identifier,
    revision: Type.Integer({ minimum: 1 }),
    goal: Text(MEMORY_LIMITS.goal),
    scope: Type.Union([Text(MEMORY_LIMITS.goal), Type.Null()]),
    sources: Type.Array(SourceRefSchema, { maxItems: MEMORY_LIMITS.sources }),
    at: Timestamp,
  },
  { additionalProperties: false },
);
export type WorkingCompleted = Static<typeof WorkingCompletedSchema>;

/**
 * Typed application entry written in the same commit as the document. It carries no `model`
 * messages, so it never enters a request; it exists to address the rewindable state by entry.
 */
export const WorkingAnchorEntry = defineEntry<WorkingAnchor>(WORKING_ANCHOR_KIND);

/** Typed completion entry: one per finished task, addressed by its entry id. */
export const WorkingCompletedEntry = defineEntry<WorkingCompleted>(WORKING_COMPLETED_KIND);

/**
 * Load a `personal.working` value written before the profile field existed. Version 1 omits
 * `profile`; the current document version must already match `WorkingStateSchema`. A missing field
 * on the current version is corrupt, not an empty profile.
 */
export function migrateWorkingDocument(value: JsonObject, fromVersion: number): WorkingState {
  if (fromVersion === WORKING_DOC_VERSION) {
    return assertSchema<WorkingState>(WorkingStateSchema, value, "corrupt-state");
  }
  if (fromVersion !== 1) {
    throw new MemoryError("unsupported-version", `Working document version ${fromVersion} is not supported`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryError("corrupt-state", "Working document is not an object");
  }
  if ("profile" in value) return assertSchema<WorkingState>(WorkingStateSchema, value, "corrupt-state");
  return assertSchema<WorkingState>(WorkingStateSchema, { ...value, profile: [] }, "corrupt-state");
}

/** Rewindable current state. `fork: "asOf"` copies the value at the fork entry. */
export const WorkingDoc = defineDoc({
  kind: WORKING_DOC_KIND,
  version: WORKING_DOC_VERSION,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: initialWorkingState,
  migrate: migrateWorkingDocument,
});

/** Operation receipts keyed by `operationId`. A fork starts empty: operations belong to their conversation. */
export const WorkingReceiptDoc = defineDocFamily({
  kind: WORKING_RECEIPT_KIND,
  version: MEMORY_SCHEMA_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed: WorkingReceipt): WorkingReceipt => seed,
});

const CycleBoundarySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("initial"),
      /**
       * The working anchor the baseline was read at, or `null` when the projection starts the
       * conversation and no anchor exists yet. Never a placeholder entry id.
       */
      anchor: Type.Union([EntryIdSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("compaction"),
      /** First entry the summary keeps verbatim; the boundary state must predate it. */
      firstKept: EntryIdSchema,
      anchor: EntryIdSchema,
    },
    { additionalProperties: false },
  ),
]);
export type CycleBoundary = Static<typeof CycleBoundarySchema>;

/** Versions of the inputs a snapshot was built from; a change invalidates the prefix, not the data. */
const SnapshotFactsSchema = Type.Object(
  {
    instructionsDigest: Type.Union([Identifier, Type.Null()]),
    memoryDigest: Type.Union([Identifier, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SnapshotFacts = Static<typeof SnapshotFactsSchema>;

/**
 * Structured half of a cycle snapshot; encoded into the compaction body. `sources` is `null` only for
 * an initial projection that predates every entry, where there is no range to cover yet.
 */
const cycleFields = {
  version: Version,
  cycleId: Identifier,
  baseline: WorkingBaselineSchema,
  boundary: CycleBoundarySchema,
  sources: Type.Union([SourceRangeSchema, Type.Null()]),
  facts: SnapshotFactsSchema,
};
const CycleSnapshotBodySchema = Type.Object(cycleFields, { additionalProperties: false });
export type CycleSnapshotBody = Static<typeof CycleSnapshotBodySchema>;

/**
 * Block B. `narrative` is the only model-written part; the baseline is rendered deterministically
 * from the boundary revision. `boundary.anchor` must be an entry before `firstKept` — never
 * `firstKept - 1` and never the newest working revision.
 */
export const CycleSnapshotSchema = Type.Object(
  { ...cycleFields, narrative: Type.String({ maxLength: MEMORY_LIMITS.narrative }) },
  { additionalProperties: false },
);
export type CycleSnapshot = Static<typeof CycleSnapshotSchema>;

/**
 * Encode a snapshot as compaction body text: narrative first, then a canonical JSON block. The
 * narrative is not repeated inside the block, so the model reads it once.
 */
export function encodeCycleSnapshot(snapshot: CycleSnapshot): string {
  const { narrative, ...body } = snapshot;
  return `${narrative}\n\n${CYCLE_BLOCK_OPEN}\n${canonicalJson(body)}\n${CYCLE_BLOCK_CLOSE}`;
}

/**
 * Decode a compaction body. `undefined` means the body carries no application snapshot — a native
 * or pre-upgrade summary — and callers must fall back to narrative-only handling. A block with an
 * unsupported version or invalid content is an explicit error, never a silent fallback.
 */
export function decodeCycleSnapshot(body: string): CycleSnapshot | undefined {
  const open = body.lastIndexOf(CYCLE_BLOCK_OPEN);
  if (open === -1) return undefined;
  const close = body.indexOf(CYCLE_BLOCK_CLOSE, open);
  if (close === -1) throw new MemoryError("corrupt-state", "Cycle snapshot block is not closed");
  const raw = body.slice(open + CYCLE_BLOCK_OPEN.length, close).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MemoryError("corrupt-state", "Cycle snapshot block is not JSON", { cause });
  }
  const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version !== "number") throw new MemoryError("corrupt-state", "Cycle snapshot block has no version");
  if (version !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryError("unsupported-version", `Cycle snapshot version ${version} is not supported`);
  }
  const body_ = assertSchema<CycleSnapshotBody>(CycleSnapshotBodySchema, migrateStoredSnapshot(parsed), "corrupt-state");
  return { ...body_, narrative: body.slice(0, open).trim() };
}

/**
 * A cycle snapshot written before the profile field existed has schema version 1 and no
 * `baseline.profile`. That absence is the pre-profile shape, so decoding adds an empty list.
 * The snapshot version is not bumped: `MEMORY_SCHEMA_VERSION` is shared with segments and receipts.
 * A baseline that names `profile` and then fails the schema is corrupt and is not rewritten here.
 */
export function migrateStoredSnapshot(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const snapshot = value as { baseline?: unknown };
  const baseline = snapshot.baseline;
  if (typeof baseline !== "object" || baseline === null || Array.isArray(baseline)) return value;
  if ("profile" in baseline) return value;
  return { ...snapshot, baseline: { ...baseline, profile: [] } };
}

/**
 * Sort object keys so equal snapshots encode to equal bytes. `undefined` cannot appear in a stored
 * value; it is an error here rather than a silent omission.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const fields = keys.map((key) => {
    const field = (value as { [key: string]: JsonValue })[key];
    if (field === undefined) throw new MemoryError("invalid-input", `Canonical JSON cannot encode undefined at ${key}`);
    return `${JSON.stringify(key)}:${canonicalJson(field)}`;
  });
  return `{${fields.join(",")}}`;
}

/** One durable fact of a day. `date` is the event date in `timezone`, never the publish date. */
export const MemorySegmentSchema = Type.Object(
  {
    version: Version,
    id: Identifier,
    date: DailyDateSchema,
    timezone: Type.String({ minLength: 1, maxLength: 64 }),
    page: Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES }),
    kind: Type.Union([
      Type.Literal("goal"),
      Type.Literal("decision"),
      Type.Literal("result"),
      Type.Literal("problem"),
      Type.Literal("user-requirement"),
      Type.Literal("open-item"),
    ]),
    status: Type.Union([
      Type.Literal("observed"),
      Type.Literal("inferred"),
      Type.Literal("confirmed"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
    text: Text(MEMORY_LIMITS.note),
    sources: SourceRangeSchema,
    supersedes: Type.Array(Identifier, { maxItems: MEMORY_LIMITS.sources }),
    supersededBy: Type.Union([Identifier, Type.Null()]),
  },
  { additionalProperties: false },
);
export type MemorySegment = Static<typeof MemorySegmentSchema>;

/**
 * One archive run over `(after, through]`. `id` is the host-issued idempotency key; segment ids are
 * `<id>#<index>` and stay stable across retries, so a published segment is never generated twice.
 */
export const ArchiveBatchSchema = Type.Object(
  {
    version: Version,
    id: Identifier,
    conversationId: ConversationIdSchema,
    sources: SourceRangeSchema,
    formatVersion: Version,
    timezone: Type.String({ minLength: 1, maxLength: 64 }),
    createdAt: Timestamp,
    segments: Type.Array(
      Type.Object(
        {
          id: Identifier,
          date: DailyDateSchema,
          page: Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES }),
        },
        { additionalProperties: false },
      ),
      { maxItems: MEMORY_LIMITS.segments },
    ),
  },
  { additionalProperties: false },
);
export type ArchiveBatch = Static<typeof ArchiveBatchSchema>;

/** A bounded pending entry: `model: []` is display-only and never enters a model request. */
const ProjectionDraftSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    data: JsonValueSchema,
    model: Type.Array(MessageSchema, { maxItems: 16 }),
  },
  { additionalProperties: false },
);

export const MEMORY_ERROR_CODES = [
  "invalid-input",
  "revision-conflict",
  "missing-evidence",
  "not-covered",
  "budget-exceeded",
  "corrupt-state",
  "unsupported-version",
  "stale",
  "cancelled",
  "io-failure",
  "model-failure",
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

/** Typed as the code union: `Type.Union` over a mapped array would infer `never`. */
export const MemoryErrorCodeSchema = Type.Unsafe<MemoryErrorCode>(Type.String({ enum: [...MEMORY_ERROR_CODES] }));

export const MemoryErrorSchema = Type.Object(
  {
    code: MemoryErrorCodeSchema,
    /** Operator-facing and safe to log: identifiers and categories only, never memory text. */
    message: Type.String({ maxLength: 500 }),
    detail: JsonValueSchema,
  },
  { additionalProperties: false },
);

/**
 * Business error to application error mapping. `appCode` is what a request surfaces; none of these
 * means the durable Session is broken, so none is reported as `AGENT_SESSION_FAILED`. Storage
 * failures reach the application through the SDK's own Session failure path instead.
 */
export const MEMORY_ERROR_MAPPING: Record<MemoryErrorCode, { appCode: string; retryable: boolean }> = {
  "invalid-input": { appCode: "MEMORY_INVALID_INPUT", retryable: false },
  "revision-conflict": { appCode: "MEMORY_REVISION_CONFLICT", retryable: false },
  "missing-evidence": { appCode: "MEMORY_MISSING_EVIDENCE", retryable: false },
  "not-covered": { appCode: "MEMORY_NOT_COVERED", retryable: false },
  "budget-exceeded": { appCode: "MEMORY_BUDGET_EXCEEDED", retryable: false },
  "corrupt-state": { appCode: "MEMORY_CORRUPT_STATE", retryable: false },
  "unsupported-version": { appCode: "MEMORY_UNSUPPORTED_VERSION", retryable: false },
  stale: { appCode: "MEMORY_STALE", retryable: false },
  cancelled: { appCode: "MEMORY_CANCELLED", retryable: true },
  "io-failure": { appCode: "MEMORY_IO_FAILURE", retryable: true },
  "model-failure": { appCode: "MEMORY_MODEL_FAILURE", retryable: true },
};

export class MemoryError extends Error {
  override name = "MemoryError";
  readonly code: MemoryErrorCode;
  readonly detail: JsonValue;
  constructor(code: MemoryErrorCode, message: string, options: { detail?: JsonValue; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.detail = options.detail ?? null;
  }
  get appCode(): string {
    return MEMORY_ERROR_MAPPING[this.code].appCode;
  }
  /** The serializable form a plan carries; the message is operator-facing and holds no memory text. */
  toJSON(): Static<typeof MemoryErrorSchema> {
    return { code: this.code, message: this.message.slice(0, 500), detail: this.detail };
  }
}

/** Validate one stored or external value against its schema; failures are `code`, never a default. */
export function assertSchema<T>(schema: TSchema, value: unknown, code: MemoryErrorCode): T {
  if (!Value.Check(schema, value)) throw new MemoryError(code, "Stored memory value does not match its schema");
  return value as T;
}

/** Budgets live in one place and reach modules through configuration, never as copied constants. */
export const MemoryBudgetSchema = Type.Object(
  {
    backgroundTargetTokens: Type.Integer({ minimum: 1_024 }),
    recentVerbatimTokens: Type.Integer({ minimum: 512 }),
    snapshotTokens: Type.Integer({ minimum: 256 }),
    narrativeTokens: Type.Integer({ minimum: 128 }),
    instructionsTokens: Type.Integer({ minimum: 256 }),
    searchResultTokens: Type.Integer({ minimum: 128 }),
    requestSearchTokens: Type.Integer({ minimum: 128 }),
    evaluateAfterUserTurns: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type MemoryBudget = Static<typeof MemoryBudgetSchema>;

/** Initial experimental values (Ki = 1024), measured rather than hard limits. */
export const MEMORY_BUDGET_DEFAULTS: MemoryBudget = {
  backgroundTargetTokens: 48 * 1024,
  recentVerbatimTokens: 16 * 1024,
  snapshotTokens: 6 * 1024,
  narrativeTokens: 3 * 1024,
  instructionsTokens: 8 * 1024,
  searchResultTokens: 4 * 1024,
  requestSearchTokens: 8 * 1024,
  evaluateAfterUserTurns: 20,
};

/** What a plan decided and the budget it was decided against. */
export const ContextPlanSchema = Type.Object(
  {
    version: Version,
    action: Type.Union([
      Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal("project"), drafts: Type.Array(ProjectionDraftSchema, { minItems: 1, maxItems: 4 }) },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("compact"),
          /** `facts` is a changed block A or memory version: the cycle must end to adopt it. */
          reason: Type.Union([Type.Literal("budget"), Type.Literal("rounds"), Type.Literal("facts")]),
        },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal("error"), error: MemoryErrorSchema }, { additionalProperties: false }),
    ]),
    budget: Type.Object(
      {
        inputTokens: Type.Integer({ minimum: 0 }),
        blockingLimit: Type.Integer({ minimum: 1 }),
        backgroundLimit: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ContextPlan = Static<typeof ContextPlanSchema>;

/**
 * Date file for one event date. Page 1 is `YYYY-MM-DD.md`; continuation pages are
 * `YYYY-MM-DD-2.md` … up to `DAILY_MAX_PAGES`. Unknown event times go to `unknown.md` and keep
 * `date: "unknown"`, so the publish time is never presented as the event time.
 */
export function dailyFileName(date: string, page = 1): string {
  if (!Number.isInteger(page) || page < 1 || page > DAILY_MAX_PAGES) {
    throw new MemoryError("invalid-input", `Page must be 1..${DAILY_MAX_PAGES}`);
  }
  if (date !== UNKNOWN_DATE && !isCalendarDate(date)) {
    throw new MemoryError("invalid-input", "Date must be a real YYYY-MM-DD date or unknown");
  }
  return page === 1 ? `${date}.md` : `${date}-${page}.md`;
}

function isCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Event date in the configured zone; `undefined` timestamp is explicitly unknown. */
export function eventDate(timestamp: number | undefined, timeZone: string): string {
  if (timestamp === undefined) return UNKNOWN_DATE;
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch (cause) {
      throw new MemoryError("invalid-input", `Unknown time zone: ${timeZone}`, { cause });
    }
    formatters.set(timeZone, formatter);
  }
  return formatter.format(timestamp);
}

/**
 * Read the state at an application anchor. A fork that does not cover the anchor, or a boundary
 * before the first write, is rejected as `not-covered` — never answered with a default or with the
 * newest state.
 */
export async function workingAtBoundary(
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
