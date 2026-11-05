// Context Module (MEM-03): decide what a request needs, and render block B deterministically.
//
// Interface
//   planRequest(input)             -> `ContextPlan`
//   boundaryWrite(...)             -> the write that establishes B, with the messages the model reads
//   revisionWrite(...)             -> the write that puts a newer state into C
//   reuseWrite(committed, next)    -> the write to commit: the original when nothing changed
//   buildSnapshot(facts)           -> `CycleSnapshot` from already-read values
//   renderSnapshot(snapshot)       -> the exact bytes block B publishes
//   snapshotFromHead(body)         -> decode a published summary, `undefined` for a native one
//   measureRequest(messages)       -> request size, cached tokens included
//   blockUsage(input)              -> each block against its own share of the budget
//   validateWorking(value)         -> a stored state, or an explicit `corrupt-state`
//
// Inputs are fixed values the caller already read: the budget, the rendered block A, the committed
// snapshot (or none), the current working state, the request's measured size, and the user turns since
// the cycle began. This module performs no I/O, starts no Harness, opens no file, and calls no model.
// It returns material; the Durable Adapter performs the side effects.
//
// Data conditions come back as `action.kind === "error"` with a serialized `MemoryError`, so a caller
// records one decision instead of catching. Rendering helpers still throw for direct callers; the
// planner converts what it catches, so `planRequest` itself never throws on a data condition.
//
// The rule the module serves: B changes only when a cycle changes. Within a cycle the plan emits C
// material and never re-renders B; a new B is produced by compaction, from the state at the cut.
//
// Both writes carry model messages, because the point of a projection is that the model reads the
// state: the boundary write as B, the revision write as a bounded update in C. Neither is a display
// record — a `model: []` entry would leave the state invisible to the model.

import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { EntryId } from "@earendil-works/pi-durable";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Message } from "@earendil-works/pi-ai";
import {
  assertSchema,
  baselineOf,
  canonicalJson,
  CYCLE_BLOCK_CLOSE,
  CYCLE_BLOCK_OPEN,
  CYCLE_SNAPSHOT_KIND,
  CycleSnapshotSchema,
  decodeCycleSnapshot,
  encodeCycleSnapshot,
  MEMORY_LIMITS,
  migrateStoredSnapshot,
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  REVISION_BLOCK_CLOSE,
  REVISION_BLOCK_OPEN,
  renderBaseline,
  WorkingStateSchema,
  type ContextPlan,
  type CycleBoundary,
  type CycleSnapshot,
  type MemoryBudget,
  type SnapshotFacts,
  type SourceRange,
  type WorkingBaseline,
  type WorkingState,
} from "./contracts.js";

/** What the caller read before planning. Every field is a value, never a reader or a client. */
export type PlanInput = {
  readonly budget: MemoryBudget;
  /** The rendered block A: instructions plus tool declarations. Blank is an error, not an empty prompt. */
  readonly instructionsText: string;
  /** The committed snapshot B, or `undefined` before the first cycle projection. */
  readonly snapshot: CycleSnapshot | undefined;
  /** Current working state, already read; the planner never reads a document. */
  readonly working: WorkingState;
  /** Whether the active context already carries the current working revision. */
  readonly workingInContext: boolean;
  /** Request size as `measureRequest` reports it; cached tokens are part of the input. */
  readonly inputTokens: number;
  /** The model's context window, so the hard limit is derived rather than configured twice. */
  readonly contextWindow: number;
  /** Room kept free for the answer. */
  readonly reserveTokens: number;
  /** Independent user turns since the cycle began; tool calls and retries do not count. */
  readonly userTurns: number;
  /** Whether the active range still holds enough content to be worth summarizing. */
  readonly compactableTokens: number;
  /** Digests of the inputs B was built from, so a changed input invalidates the prefix deliberately. */
  readonly facts: SnapshotFacts;
};

/**
 * Decide what this request needs. Pure: the same input returns the same plan, byte for byte.
 *
 * Precedence is deliberate. A missing or unusable block A is a hard error — the request must not run
 * with a blank prompt. Budget pressure is next, because it decides whether the request fits at all.
 * Only then does the plan consider what belongs in C.
 */
export function planRequest(input: PlanInput): ContextPlan {
  const budget = limits(input);
  const fail = (error: MemoryError): ContextPlan => ({
    version: MEMORY_SCHEMA_VERSION,
    action: { kind: "error", error: error.toJSON() },
    budget,
  });

  if (input.instructionsText.trim().length === 0) {
    return fail(new MemoryError("invalid-input", "Block A is empty; refusing to run without a system prompt"));
  }
  if (input.instructionsText.length > MEMORY_LIMITS.instructions) {
    return fail(new MemoryError("budget-exceeded", "Block A exceeds its text bound", {
      detail: { limit: MEMORY_LIMITS.instructions, length: input.instructionsText.length },
    }));
  }
  // A required state that does not match its schema is an error, never a value to render anyway.
  let working: WorkingState;
  try {
    working = validateWorking(input.working);
    if (input.snapshot !== undefined) assertSchema<CycleSnapshot>(CycleSnapshotSchema, input.snapshot, "corrupt-state");
  } catch (error) {
    return fail(error instanceof MemoryError ? error : new MemoryError("corrupt-state", "Required state is unreadable"));
  }

  // Measuring and building both render, and a valid-but-unrenderable value is a data condition like any
  // other. Rendering keeps throwing for direct callers; the planner converts, so every outcome here is
  // a plan and never an exception.
  try {
    return decide(input, working, budget, fail);
  } catch (error) {
    return fail(error instanceof MemoryError ? error : new MemoryError("corrupt-state", "Required state cannot be measured"));
  }
}

/** The planning proper, once the inputs are known to be shaped correctly. */
function decide(
  input: PlanInput,
  working: WorkingState,
  budget: ContextPlan["budget"],
  fail: (error: MemoryError) => ContextPlan,
): ContextPlan {
  // Each block's own share is checked here, not only the total: a block over its cap is refused even
  // when the request as a whole would still fit.
  const over = blockUsage(input).find((usage) => !usage.withinLimit);
  if (over !== undefined) {
    return fail(new MemoryError("budget-exceeded", `Block ${over.block} exceeds its token share`, {
      detail: { block: over.block, tokens: over.tokens, limit: over.limit },
    }));
  }

  if (input.inputTokens > budget.blockingLimit) {
    // Nothing left to summarize means the request cannot be made to fit; failing is the honest answer.
    if (input.compactableTokens <= 0) {
      return fail(new MemoryError("budget-exceeded", "Input exceeds the blocking limit and nothing can be compacted safely", {
        detail: {
          inputTokens: input.inputTokens,
          blockingLimit: budget.blockingLimit,
          compactableTokens: input.compactableTokens,
        },
      }));
    }
    return { version: MEMORY_SCHEMA_VERSION, action: { kind: "compact", reason: "budget" }, budget };
  }

  const snapshot = input.snapshot;
  if (snapshot === undefined) {
    // No cycle yet: establishing B is the next decision, and it is taken once, not per request.
    return project(() => boundaryWrite(working, input.facts, null).draft, input, budget, fail);
  }

  // The input B was built from changed. Re-rendering mid-cycle would rewrite the prefix for a fact the
  // model has not been told, so the cycle ends instead: the new B is published by the next compaction,
  // which is where a changed instruction or memory version is allowed to take effect.
  if (!sameFacts(snapshot.facts, input.facts)) {
    if (input.compactableTokens <= 0) {
      return fail(new MemoryError("budget-exceeded", "Block A or the memory version changed and nothing can be re-summarized", {
        detail: { built: snapshot.facts, current: input.facts, compactableTokens: input.compactableTokens },
      }));
    }
    return { version: MEMORY_SCHEMA_VERSION, action: { kind: "compact", reason: "facts" }, budget };
  }

  // B is present and current. Within the cycle only C may change, and only when C lacks this revision.
  if (!input.workingInContext && working.revision !== snapshot.baseline.revision) {
    return project(() => revisionWrite(working, input.facts).draft, input, budget, fail);
  }
  // Rounds alone never demand compaction. A short exchange has nothing worth summarizing, and asking
  // again every turn would churn B for no gain.
  if (input.userTurns >= input.budget.evaluateAfterUserTurns && input.compactableTokens > 0) {
    return { version: MEMORY_SCHEMA_VERSION, action: { kind: "compact", reason: "rounds" }, budget };
  }
  return { version: MEMORY_SCHEMA_VERSION, action: { kind: "none" }, budget };
}

/** A write this module produces, before it is checked against the share it will occupy. */
type Projection = {
  readonly kind: string;
  readonly data: JsonValue & { readonly kind: string; readonly digest: string };
  readonly model: Message[];
};

/**
 * Accept a write only if the content it adds fits the share it occupies. Checking the input B alone is
 * not enough: the write is new content, and a projection larger than the block it belongs to would
 * spend the budget on the very thing the budget bounds.
 *
 * The measurement is the write's model-visible messages, so fixed envelope text counts too. Both kinds
 * draw on the snapshot share — a revision is the same state B carries, delivered later.
 */
function project(
  build: () => Projection,
  input: PlanInput,
  budget: ContextPlan["budget"],
  fail: (error: MemoryError) => ContextPlan,
): ContextPlan {
  const draft = build();
  const tokens = estimateContextTokens(draft.model).tokens;
  if (tokens > input.budget.snapshotTokens) {
    return fail(new MemoryError("budget-exceeded", "The projection exceeds the snapshot token share", {
      detail: { block: "snapshot", kind: draft.data.kind, tokens, limit: input.budget.snapshotTokens },
    }));
  }
  return { version: MEMORY_SCHEMA_VERSION, action: { kind: "project", drafts: [draft] }, budget };
}

/**
 * The write that establishes B. This is the only projection with a full snapshot body, and it is
 * published with `root.submit({type: "write", entry})` at an idle boundary (12.4 step 1).
 *
 * The single model message is the native summary shape — the wrapped summary text the base appends for
 * `pi.compaction` — so the model reads a projected B exactly as it reads a compacted one, and the
 * adapter's own entry kind stays distinguishable for the application. `boundary.anchor` is `null` (the
 * first cycle is projected before the anchor it would name) and `sources` is `null` (no range is being
 * replaced).
 */
export function boundaryWrite(state: WorkingState, facts: SnapshotFacts, cycleId: string | null) {
  const baseline = baselineOf(state);
  const snapshot = buildSnapshot({
    cycleId: cycleId ?? `initial:${digestOf(baseline, facts)}`,
    narrative: INITIAL_NARRATIVE,
    baseline: state,
    boundary: initialBoundary(null),
    sources: null,
    facts,
  });
  const draft = {
    kind: CYCLE_SNAPSHOT_KIND,
    data: {
      version: MEMORY_SCHEMA_VERSION,
      kind: "boundary" as const,
      snapshot,
      baseline,
      facts,
      digest: digestOf(baseline, facts),
    },
    model: [summaryMessage(renderSnapshot(snapshot))],
  };
  return { snapshot, draft };
}

/**
 * The write that puts a newer working state into C mid-cycle. It is bounded by the snapshot share of the
 * budget, because that is the room B's own state gets, and it carries the exact baseline — not a
 * narrative — so the model reads the current values rather than a paraphrase of them.
 */
export function revisionWrite(state: WorkingState, facts: SnapshotFacts) {
  const baseline = baselineOf(state);
  const text = `${REVISION_BLOCK_OPEN}\n${renderBaseline(baseline)}\n${REVISION_BLOCK_CLOSE}`;
  const draft = {
    kind: "personal.context.projection",
    data: {
      version: MEMORY_SCHEMA_VERSION,
      kind: "revision" as const,
      baseline,
      facts,
      digest: digestOf(baseline, facts),
    },
    model: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }] as Message[],
  };
  return { text, draft };
}

/**
 * The write to commit. A write already committed under the same digest is reused as it was written:
 * recomputing it could publish different bytes for the same fact, and the input it belonged to may not
 * have been submitted yet.
 */
export function reuseWrite<Draft extends { readonly data: { readonly digest?: unknown } }>(
  committed: Draft | undefined,
  next: Draft,
): Draft {
  return committed !== undefined && committed.data.digest === next.data.digest ? committed : next;
}

/** Stable identity of a projection: the same state under the same facts is the same material. */
export function digestOf(baseline: WorkingBaseline, facts: SnapshotFacts): string {
  return createHash("sha256").update(canonicalJson({ baseline, facts })).digest("hex").slice(0, 16);
}

/** True when two fact sets describe the same inputs; a changed digest is a different prefix. */
export function sameFacts(left: SnapshotFacts, right: SnapshotFacts): boolean {
  return left.instructionsDigest === right.instructionsDigest && left.memoryDigest === right.memoryDigest;
}

/**
 * Request size as the SDK measures it: the usage of the newest applicable assistant response — input,
 * output, cache reads and cache writes — plus estimates of everything after it. Cached tokens occupy
 * the context window, so they belong in the budget.
 */
export function measureRequest(messages: readonly Message[]): number {
  return estimateContextTokens(messages).tokens;
}

/**
 * One block's size against its own share of the budget. Each share is an explicit cap rather than a
 * slice of the total, so a block cannot grow by borrowing room another block needs. Block A is measured
 * as given — its tools are part of it, since they are declared in the same system message.
 */
export type BlockUsage = {
  readonly block: "instructions" | "snapshot";
  readonly tokens: number;
  readonly limit: number;
  readonly withinLimit: boolean;
};

/** Measure the blocks the caller holds against their own caps; the total is `measureRequest`'s job. */
export function blockUsage(input: {
  readonly budget: MemoryBudget;
  readonly instructionsText: string;
  readonly snapshot: CycleSnapshot | undefined;
}): BlockUsage[] {
  const instructions = estimateTextTokens(input.instructionsText);
  const snapshot = input.snapshot === undefined ? 0 : estimateTextTokens(renderSnapshot(input.snapshot));
  return [
    {
      block: "instructions",
      tokens: instructions,
      limit: input.budget.instructionsTokens,
      withinLimit: instructions <= input.budget.instructionsTokens,
    },
    {
      block: "snapshot",
      tokens: snapshot,
      limit: input.budget.snapshotTokens,
      withinLimit: snapshot <= input.budget.snapshotTokens,
    },
  ];
}

function limits(input: PlanInput): ContextPlan["budget"] {
  return {
    inputTokens: input.inputTokens,
    // The SDK's own thresholds, derived once here rather than configured a second time.
    blockingLimit: Math.max(1, input.contextWindow - input.reserveTokens),
    backgroundLimit: Math.max(0, input.contextWindow - input.reserveTokens - input.budget.backgroundTargetTokens),
  };
}

/**
 * Build a snapshot from values the caller already read. The baseline must be the state at the
 * boundary, not the newest state: a summary carrying a later revision would reassert facts the
 * retained entries are about to contradict.
 */
export function buildSnapshot(facts: {
  readonly cycleId: string;
  readonly narrative: string;
  readonly baseline: WorkingState;
  readonly boundary: CycleBoundary;
  readonly sources: SourceRange | null;
  readonly facts: SnapshotFacts;
}): CycleSnapshot {
  const snapshot: CycleSnapshot = {
    version: MEMORY_SCHEMA_VERSION,
    cycleId: facts.cycleId,
    narrative: facts.narrative,
    baseline: baselineOf(facts.baseline),
    boundary: facts.boundary,
    sources: facts.sources,
    facts: facts.facts,
  };
  // One validation covers the whole value, facts and boundary included.
  return assertSchema<CycleSnapshot>(CycleSnapshotSchema, snapshot, "invalid-input");
}

/**
 * Render B: the narrative, then the exact state at the boundary, including the profile section.
 * Deterministic — no clock, no per-write timestamp (state or profile item), no iteration over
 * unordered maps — so the same snapshot always renders to the same bytes and a cached prefix stays
 * valid. The rendered text is still refused when it exceeds `snapshotTokens` or `snapshotText`.
 *
 * The bound is on the rendered text, not on each field: narrative and baseline share it, and an
 * oversized B is refused rather than truncated — a shortened baseline would assert a wrong state.
 */
export function renderSnapshot(snapshot: CycleSnapshot): string {
  const text = encodeCycleSnapshot(assertSchema<CycleSnapshot>(CycleSnapshotSchema, snapshot, "corrupt-state"));
  if (text.length > MEMORY_LIMITS.snapshotText) {
    throw new MemoryError("budget-exceeded", "Snapshot exceeds its rendered text bound", {
      detail: { limit: MEMORY_LIMITS.snapshotText, length: text.length },
    });
  }
  return text;
}

/**
 * The text to add for a snapshot the active context does not carry. `undefined` when it is already the
 * active cycle, so the caller cannot project the same B twice.
 */
export function snapshotTextFor(snapshot: CycleSnapshot, activeCycleId: string | undefined): string | undefined {
  return activeCycleId === snapshot.cycleId ? undefined : renderSnapshot(snapshot);
}

/**
 * The narrative of a first projection. There is no earlier cycle to summarize, so the narrative says
 * only what is true: the session starts here, and the state below is the whole of it. A model-written
 * summary would claim continuity that does not exist yet.
 */
const INITIAL_NARRATIVE = "This is the start of the session. No earlier turns have been summarized; the state below is the current working state.";

/**
 * The native summary shape: one user message carrying the wrapped summary text. A `pi.compaction`
 * entry's `model` is exactly this, so a projection published in the same shape is read the same way.
 */
function summaryMessage(body: string): Message {
  return { role: "user", content: [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${body}\n</summary>` }], timestamp: 0 };
}

/**
 * The snapshot a committed projection carries, if any. A projection without a snapshot body (a
 * within-cycle revision) yields `undefined`, so a caller never mistakes one for B.
 */
export function snapshotOfProjection(data: unknown): CycleSnapshot | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const candidate = (data as { snapshot?: unknown }).snapshot;
  if (candidate === undefined) return undefined;
  return assertSchema<CycleSnapshot>(CycleSnapshotSchema, migrateStoredSnapshot(candidate), "corrupt-state");
}

/** Decode a published compaction body. `undefined` is a native or pre-upgrade summary, not an error. */
export function snapshotFromHead(body: string): CycleSnapshot | undefined {
  return decodeCycleSnapshot(body);
}

/** True when the snapshot's baseline is older than the live state it would otherwise restate. */
export function isStale(snapshot: CycleSnapshot, working: WorkingState): boolean {
  return working.revision !== snapshot.baseline.revision;
}

/** Validate a state read elsewhere; the planner takes validated values, so this is its only reader. */
export function validateWorking(value: unknown): WorkingState {
  return assertSchema<WorkingState>(WorkingStateSchema, value, "corrupt-state");
}

/** The boundary an initial projection records: the anchor it was read at, or none when there is none. */
export function initialBoundary(anchor: EntryId | null): CycleBoundary {
  return { kind: "initial", anchor };
}
