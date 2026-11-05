import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import {
  assertSchema,
  baselineOf,
  ContextPlanSchema,
  MEMORY_BUDGET_DEFAULTS,
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
  REVISION_BLOCK_CLOSE,
  REVISION_BLOCK_OPEN,
  renderBaseline,
  type ContextPlan,
  type CycleBoundary,
  type CycleSnapshot,
  type MemoryBudget,
  type Preference,
  type SnapshotFacts,
  type SourceRange,
  type WorkingBaseline,
  type WorkingState,
} from "../src/memory/contracts.js";
import {
  blockUsage,
  boundaryWrite,
  buildSnapshot,
  digestOf,
  initialBoundary,
  isStale,
  measureRequest,
  planRequest,
  reuseWrite,
  revisionWrite,
  renderSnapshot,
  sameFacts,
  snapshotFromHead,
  snapshotOfProjection,
  snapshotTextFor,
  validateWorking,
  type PlanInput,
} from "../src/memory/context.js";

// MEM-03 exercises the pure Context Module only: values in, values out. No Harness, no database, no
// fixture, no model. The one file read below checks that the module itself has no runtime I/O.

const conversationId = 1 as ConversationId;
const id = (value: number) => value as EntryId;

const FACTS: SnapshotFacts = { instructionsDigest: "a1b2c3", memoryDigest: "d4e5f6" };

function state(overrides: Partial<WorkingState> = {}): WorkingState {
  return {
    version: MEMORY_SCHEMA_VERSION,
    revision: 1,
    task: { status: "none" },
    preferences: [],
    profile: [],
    updatedAt: 0,
    ...overrides,
  };
}

function preference(name: string, text: string): Preference {
  return { id: name, text, scope: "global", source: { conversationId, entryId: id(3) }, expiresAt: null };
}

type SnapshotParts = {
  cycleId?: string;
  narrative?: string;
  baseline?: WorkingState;
  boundary?: CycleBoundary;
  sources?: SourceRange | null;
  facts?: SnapshotFacts;
};

function snapshot(parts: SnapshotParts = {}): CycleSnapshot {
  return buildSnapshot({
    cycleId: "cycle-1",
    narrative: "The user is preparing a release.",
    baseline: state({
      revision: 3,
      preferences: [preference("tone", "Keep replies terse"), preference("lang", "Answer in Chinese")],
    }),
    boundary: initialBoundary(id(5)),
    sources: { conversationId, after: null, through: id(9) },
    facts: FACTS,
    ...parts,
  });
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    budget: MEMORY_BUDGET_DEFAULTS,
    instructionsText: "SYSTEM RULES: be concise.",
    // An established cycle is the common case; the no-cycle branch is passed explicitly.
    snapshot: snapshot(),
    working: state(),
    workingInContext: true,
    inputTokens: 1_000,
    contextWindow: 200_000,
    reserveTokens: 16_000,
    userTurns: 0,
    compactableTokens: 10_000,
    facts: FACTS,
    ...overrides,
  };
}

/** Every plan in this file is validated against the frozen schema: it is the contract's only source. */
function plan(overrides: Partial<PlanInput> = {}): ContextPlan {
  return assertSchema<ContextPlan>(ContextPlanSchema, planRequest(planInput(overrides)), "invalid-input");
}

function errorCode(value: ContextPlan): string {
  assert.equal(value.action.kind, "error");
  return value.action.kind === "error" ? value.action.error.code : "";
}

/** The one projection a plan carries. */
function projection(value: ContextPlan) {
  assert.equal(value.action.kind, "project");
  const drafts = value.action.kind === "project" ? value.action.drafts : [];
  assert.equal(drafts.length, 1);
  const [draft] = drafts;
  assert.ok(draft !== undefined);
  return draft;
}

/** The text the model will read for a draft: its model messages, concatenated. */
function modelText(draft: { readonly model: readonly Message[] }): string {
  return draft.model
    .map((message) => (typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")))
    .join("\n");
}

test("03-A: the same input renders the same bytes and plans the same action", () => {
  const first = plan({ snapshot: snapshot(), working: state({ revision: 4 }), workingInContext: false });
  const second = plan({ snapshot: snapshot(), working: state({ revision: 4 }), workingInContext: false });
  assert.equal(JSON.stringify(first), JSON.stringify(second), "plans are byte-identical");
  assert.equal(first.action.kind, "project");

  // Rendering is deterministic and independent of key insertion order: the snapshot is canonicalized.
  const sample = snapshot();
  const rendered = renderSnapshot(sample);
  assert.equal(renderSnapshot(sample), rendered);
  const reordered = {
    facts: sample.facts,
    sources: sample.sources,
    boundary: sample.boundary,
    baseline: sample.baseline,
    cycleId: sample.cycleId,
    narrative: sample.narrative,
    version: sample.version,
  } as CycleSnapshot;
  assert.equal(renderSnapshot(reordered), rendered, "key insertion order does not change the bytes");
  assert.deepEqual(snapshotFromHead(rendered), sample, "the published bytes decode back to the snapshot");

  // The write is deterministic too, model messages included.
  const write = boundaryWrite(state({ revision: 2 }), FACTS, "cycle-1");
  const again = boundaryWrite(state({ revision: 2 }), FACTS, "cycle-1");
  assert.equal(JSON.stringify(write.draft), JSON.stringify(again.draft));
  assert.deepEqual(snapshotOfProjection(write.draft.data), write.snapshot, "the entry carries the snapshot it renders");

  // B must be model-visible: the first request carries it, so the write cannot be display-only. The shape
  // is the native summary's — one user message wrapping the summary — so the model reads B as it reads a
  // compacted B, and the adapter's entry kind stays distinguishable for the application.
  assert.equal(write.draft.model.length, 1);
  assert.equal(write.draft.model[0]?.role, "user");
  const written = modelText(write.draft);
  assert.ok(written.includes(renderSnapshot(write.snapshot)), "the model reads the rendered snapshot");
  assert.ok(written.includes("<summary>") && written.includes("</summary>"), "wrapped in the native summary envelope");
  assert.equal(write.draft.kind, "personal.cycle", "the entry kind stays the application's");
  assert.equal(write.snapshot.boundary.kind, "initial");
  assert.equal(write.snapshot.sources, null, "a first projection replaces no range");

  // The write time is not part of B: a state that only moved `updatedAt` renders and digests the same.
  const later = state({ revision: 3, updatedAt: 1_700_000_000_000 });
  const earlier = state({ revision: 3, updatedAt: 0 });
  assert.equal(digestOf(baselineOf(later), FACTS), digestOf(baselineOf(earlier), FACTS));
  assert.equal(
    renderSnapshot(snapshot({ baseline: later })),
    renderSnapshot(snapshot({ baseline: earlier })),
    "a per-write timestamp never reaches the rendered snapshot",
  );
});

test("03-A: a repeated build reuses the committed projection instead of adding a second one", () => {
  const working = state({ revision: 2 });
  const first = revisionWrite(working, FACTS).draft;
  const again = revisionWrite(working, FACTS).draft;
  assert.equal(first.data.digest, again.data.digest, "the same state under the same facts is the same material");

  // A write already committed under the same digest is kept exactly as written.
  const committed = { ...first, committedAt: 10 };
  assert.equal(reuseWrite(committed, again), committed);
  // A changed state is new material, not a silent rewrite of the old entry.
  const changed = revisionWrite(state({ revision: 3 }), FACTS).draft;
  assert.equal(reuseWrite(committed, changed), changed);
  assert.notEqual(changed.data.digest, first.data.digest);
  // Different facts under the same state are different material too: the prefix moved.
  assert.notEqual(revisionWrite(working, { ...FACTS, memoryDigest: "999999" }).draft.data.digest, first.data.digest);

  // Planning never emits the same projection twice: once C carries the revision, nothing follows.
  const projected = projection(plan({ snapshot: snapshot(), working, workingInContext: false }));
  assert.equal((projected.data as { baseline: WorkingBaseline }).baseline.revision, 2);
  assert.equal(plan({ snapshot: snapshot(), working, workingInContext: true }).action.kind, "none");
});

test("03-B: a revision is model-visible in C without re-rendering B; the new B waits for the next cycle", () => {
  const committed = snapshot();
  const before = renderSnapshot(committed);
  const working = state({ revision: 4, preferences: [preference("tone", "Keep replies terse")] });

  const projected = plan({ snapshot: committed, working, workingInContext: false });
  assert.equal(projected.action.kind, "project");
  const draft = projection(projected);
  const data = draft.data as { kind: string; baseline: WorkingBaseline; version: number };
  assert.equal(data.kind, "revision");
  assert.equal(data.baseline.revision, 4);
  assert.equal(data.version, MEMORY_SCHEMA_VERSION);

  // The revision reaches the model: the entry carries a user message with the exact state, so a model
  // that never calls `working_read` still sees the current values.
  assert.equal(draft.model.length, 1, "a revision write publishes one model message");
  const text = modelText(draft);
  assert.ok(text.includes(REVISION_BLOCK_OPEN) && text.includes(REVISION_BLOCK_CLOSE), "the revision is delimited");
  assert.ok(text.includes(renderBaseline(baselineOf(working))), "the model reads the exact baseline, not a paraphrase");
  assert.ok(!text.includes('"lang"'), "the revoked preference is not restated");
  assert.ok(!JSON.stringify(draft).includes(committed.narrative), "the write does not carry a re-rendered B");
  assert.equal(renderSnapshot(committed), before, "B is untouched while the cycle is running");
  assert.equal(snapshotOfProjection(draft.data), undefined, "a revision is not a snapshot");

  // Only a new cycle produces a new B, built from the state at that cut.
  const next = snapshot({
    cycleId: "cycle-2",
    narrative: "The release is cut.",
    baseline: working,
    boundary: { kind: "compaction", firstKept: id(20), anchor: id(18) },
    sources: { conversationId, after: id(9), through: id(20) },
  });
  assert.notEqual(renderSnapshot(next), before);
  assert.equal(snapshotTextFor(next, "cycle-1"), renderSnapshot(next), "a different cycle is new text for C");
  assert.equal(snapshotTextFor(next, "cycle-2"), undefined, "the active cycle is never projected twice");
  assert.equal(snapshotTextFor(committed, "cycle-1"), undefined);
});

test("03-C: an old snapshot, a newer revision and a revoked preference do not restore the old value", () => {
  const committed = snapshot();
  const renderedOld = renderSnapshot(committed);
  assert.ok(renderedOld.includes('"lang"'), "the sample snapshot still carries the preference being revoked");

  // The revision that removes `lang` is the current state; B's baseline is not.
  const current = state({ revision: 4, preferences: [preference("tone", "Keep replies terse")] });
  assert.ok(isStale(committed, current));

  const draft = projection(plan({ snapshot: committed, working: current, workingInContext: false }));
  const baseline = (draft.data as { baseline: WorkingBaseline }).baseline;
  assert.deepEqual(baseline.preferences.map((item) => item.id), ["tone"], "the revision carries the current set only");
  const text = modelText(draft);
  assert.ok(text.includes('"tone"') && !text.includes('"lang"'), "the model reads the current set, not the old one");

  // The old value is not re-asserted: B stays as it was, and only a new cycle re-renders from the state
  // at the cut, which no longer contains the revoked preference.
  assert.equal(renderSnapshot(committed), renderedOld);
  const next = snapshot({
    cycleId: "cycle-2",
    narrative: "The release is cut.",
    baseline: current,
    boundary: { kind: "compaction", firstKept: id(20), anchor: id(18) },
    sources: { conversationId, after: id(9), through: id(20) },
  });
  const renderedNew = renderSnapshot(next);
  assert.ok(!renderedNew.includes('"lang"'), "the new cycle does not carry the revoked preference");
  assert.ok(!isStale(next, current));

  // Once C holds the revision, the plan stops projecting: the stale baseline is not replayed per turn.
  assert.equal(plan({ snapshot: committed, working: current, workingInContext: true }).action.kind, "none");
});

test("03-D: a blank prompt, corrupt state and an unfittable budget are explicit errors", () => {
  assert.equal(errorCode(plan({ instructionsText: "" })), "invalid-input");
  assert.equal(errorCode(plan({ instructionsText: "  \n\t " })), "invalid-input");
  assert.equal(
    errorCode(plan({ instructionsText: "x".repeat(MEMORY_LIMITS.instructions + 1) })),
    "budget-exceeded",
    "an oversized block A is refused, not truncated",
  );

  // A required state that does not match its schema is an error, never a value rendered anyway.
  assert.equal(errorCode(plan({ working: { ...state(), revision: 0 } })), "corrupt-state");
  assert.equal(errorCode(plan({ working: {} as WorkingState })), "corrupt-state");
  assert.equal(
    errorCode(plan({ snapshot: { version: MEMORY_SCHEMA_VERSION, cycleId: "broken" } as unknown as CycleSnapshot })),
    "corrupt-state",
  );
  assert.throws(() => validateWorking({ revision: -1 }), /does not match its schema/);

  // Over the blocking limit with nothing safe to summarize: the request cannot be made to fit.
  const blocking = 200_000 - 16_000;
  const overflow = plan({ inputTokens: blocking + 1, compactableTokens: 0 });
  assert.equal(errorCode(overflow), "budget-exceeded");
  assert.equal(overflow.budget.blockingLimit, blocking);
  // The same size is compactable when there is content to summarize.
  assert.deepEqual(plan({ inputTokens: blocking + 1, compactableTokens: 4_000 }).action, {
    kind: "compact",
    reason: "budget",
  });
  // Exactly at the limit still fits.
  assert.equal(plan({ inputTokens: blocking, compactableTokens: 0 }).action.kind, "none");

  // B itself is bounded by its rendered text: an oversized one is refused, never truncated. Narrative
  // and baseline share the bound, so a full narrative plus a full preference list exceeds it.
  const oversized = snapshot({
    narrative: "n".repeat(MEMORY_LIMITS.narrative),
    baseline: state({
      revision: 3,
      preferences: Array.from({ length: MEMORY_LIMITS.preferences }, (_, index) =>
        preference(`p${index}`, "x".repeat(MEMORY_LIMITS.text)),
      ),
    }),
  });
  assert.ok(renderSnapshot(snapshot()).length <= MEMORY_LIMITS.snapshotText);
  assert.throws(() => renderSnapshot(oversized), /rendered text bound/);
  // A valid B that cannot be rendered is a data condition, not an exception: the planner returns a plan.
  // Rendering itself keeps throwing for direct callers.
  assert.equal(errorCode(plan({ snapshot: oversized })), "budget-exceeded");
  assert.equal(errorCode(plan({ snapshot: oversized, inputTokens: 500, working: state() })), "budget-exceeded");
});

test("03-D: every block and cached token counts toward the budget, and each block has its own share", () => {
  const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 0 };
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const assistant = (cacheRead: number): Message => ({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { ...usage, cacheRead, cost },
    stopReason: "stop",
    timestamp: 2,
  });
  const user: Message = { role: "user", content: "hi", timestamp: 1 };
  const messages: Message[] = [user, assistant(300)];

  const withCache = measureRequest(messages);
  assert.equal(withCache, 460, "input, output, cache read and cache write are all counted");
  assert.equal(measureRequest([user, assistant(0)]), 160, "the cached prefix is not free context");
  assert.equal(withCache - measureRequest([user, assistant(0)]), 300);

  // Trailing turns after the measured response are added, so the newest input is not invisible.
  assert.ok(measureRequest([...messages, { role: "user", content: "next", timestamp: 3 }]) > withCache);

  // The measured size drives the plan: with cached tokens included, this request no longer fits.
  const contextWindow = 480;
  const reserveTokens = 40;
  const overflow = plan({ inputTokens: withCache, contextWindow, reserveTokens, compactableTokens: 0 });
  assert.equal(errorCode(overflow), "budget-exceeded");
  assert.equal(overflow.budget.blockingLimit, contextWindow - reserveTokens);
  assert.equal(overflow.budget.backgroundLimit, 0, "the background threshold is derived from the same window");
  // Ignoring the cached 300 would have made this look like it fits.
  assert.ok(withCache - 300 <= overflow.budget.blockingLimit);

  // Per-block shares are checked, not only the total. A budget that the total fits but block A does not
  // is still refused — the failure names the block, not just "over budget".
  const tight: MemoryBudget = { ...MEMORY_BUDGET_DEFAULTS, instructionsTokens: 512, snapshotTokens: 6_144 };
  const usageOfTight = blockUsage({ budget: tight, instructionsText: "SYSTEM RULES: be concise.", snapshot: snapshot() });
  assert.deepEqual(usageOfTight.map((entry) => entry.block), ["instructions", "snapshot"]);
  assert.ok(usageOfTight.every((entry) => entry.withinLimit), "the default input fits both shares");
  const refused = plan({ budget: { ...tight, instructionsTokens: 256 }, instructionsText: "x".repeat(1_000) });
  assert.equal(errorCode(refused), "budget-exceeded");
  assert.equal(refused.action.kind === "error" ? (refused.action.error.detail as { block?: string }).block : "", "instructions");
  // The snapshot share is enforced the same way, from the rendered bytes rather than the raw fields.
  // Size the sample into the narrow window between the share (in characters) and the hard text bound, so
  // the share — not the hard limit — is what refuses it.
  const shareLimit = MEMORY_BUDGET_DEFAULTS.snapshotTokens;
  const textBound = MEMORY_LIMITS.snapshotText;
  const targetChars = Math.min(textBound - 100, Math.ceil(shareLimit * 3.5) + 200);
  const bigPreferences = Array.from({ length: MEMORY_LIMITS.preferences }, (_, index) =>
    preference(`p${index}`, "x".repeat(MEMORY_LIMITS.text)),
  );
  const base = snapshot({ narrative: "", baseline: state({ revision: 3, preferences: bigPreferences }) });
  const filler = targetChars - renderSnapshot(base).length;
  assert.ok(filler > 0 && filler <= MEMORY_LIMITS.narrative, `the sample needs ${filler} narrative characters`);
  const wide = snapshot({ narrative: "n".repeat(filler), baseline: state({ revision: 3, preferences: bigPreferences }) });
  const wideLength = renderSnapshot(wide).length;
  assert.ok(wideLength > shareLimit * 3.5, "the sample is over the snapshot share");
  assert.ok(wideLength <= textBound, "and still inside the hard text bound");
  assert.equal(blockUsage({ budget: MEMORY_BUDGET_DEFAULTS, instructionsText: "rules", snapshot: wide })[1]?.withinLimit, false);
  assert.equal(errorCode(plan({ snapshot: wide })), "budget-exceeded");
  // Raising the share lets the same snapshot through, so the share really is the deciding factor.
  const roomy: MemoryBudget = { ...MEMORY_BUDGET_DEFAULTS, snapshotTokens: Math.ceil(wideLength / 3.5) + 1 };
  assert.equal(plan({ snapshot: wide, budget: roomy }).action.kind, "none");
});

test("03-D: the write about to be generated is measured against the share, not only the committed B", () => {
  // A legal but tight share. The committed B fits it; the writes this plan would produce do not.
  const tight: MemoryBudget = { ...MEMORY_BUDGET_DEFAULTS, snapshotTokens: 256 };
  const current = state({
    revision: 4,
    preferences: Array.from({ length: 6 }, (_, index) => preference(`p${index}`, "Keep replies terse and show the command first")),
  });
  const boundaryTokens = estimateContextTokens(boundaryWrite(current, FACTS, null).draft.model).tokens;
  const revisionTokens = estimateContextTokens(revisionWrite(current, FACTS).draft.model).tokens;
  assert.ok(blockUsage({ budget: tight, instructionsText: "SYSTEM RULES: be concise.", snapshot: snapshot() }).every((entry) => entry.withinLimit));
  assert.ok(boundaryTokens > tight.snapshotTokens, `the first B is ${boundaryTokens} tokens`);
  assert.ok(revisionTokens > tight.snapshotTokens, `the revision is ${revisionTokens} tokens`);

  // The first B is refused: checking only the (absent) input B would have accepted a write far larger
  // than the block it occupies.
  const first = plan({ budget: tight, snapshot: undefined, working: current });
  assert.equal(errorCode(first), "budget-exceeded");
  assert.deepEqual(first.action.kind === "error" ? first.action.error.detail : undefined, {
    block: "snapshot",
    kind: "boundary",
    tokens: boundaryTokens,
    limit: tight.snapshotTokens,
  });

  // The revision write is measured the same way, envelope text included.
  const revision = plan({ budget: tight, working: current, workingInContext: false });
  assert.equal(errorCode(revision), "budget-exceeded");
  assert.deepEqual(revision.action.kind === "error" ? revision.action.error.detail : undefined, {
    block: "snapshot",
    kind: "revision",
    tokens: revisionTokens,
    limit: tight.snapshotTokens,
  });
  // The share is what refuses them: the same plans project under the default budget, and a state small
  // enough to fit the tight share projects under it too. The guard bounds size, it does not forbid writes.
  assert.equal(plan({ snapshot: undefined, working: current }).action.kind, "project");
  assert.equal(plan({ working: current, workingInContext: false }).action.kind, "project");
  const small = state({ revision: 4, preferences: [preference("tone", "Keep replies terse")] });
  assert.ok(estimateContextTokens(boundaryWrite(small, FACTS, null).draft.model).tokens <= tight.snapshotTokens);
  assert.equal(plan({ budget: tight, snapshot: undefined, working: small }).action.kind, "project");
  assert.equal(plan({ budget: tight, working: small, workingInContext: false }).action.kind, "project");
});

test("03-D: a changed block A or memory version ends the cycle instead of rewriting the prefix", () => {
  const committed = snapshot();
  const changedFacts: SnapshotFacts = { ...FACTS, memoryDigest: "changed" };
  assert.equal(sameFacts(committed.facts, FACTS), true);
  assert.equal(sameFacts(committed.facts, changedFacts), false);

  // The same working revision, the same size: only the facts moved.
  const planAfter = plan({ snapshot: committed, working: state({ revision: 3 }), facts: changedFacts });
  assert.deepEqual(planAfter.action, { kind: "compact", reason: "facts" });
  // Nothing to re-summarize: the change cannot be adopted, so it is an explicit failure.
  assert.equal(errorCode(plan({ snapshot: committed, working: state({ revision: 3 }), facts: changedFacts, compactableTokens: 0 })), "budget-exceeded");
  // Unchanged facts still take the ordinary path.
  assert.equal(plan({ snapshot: committed, working: state({ revision: 3 }) }).action.kind, "none");
});

test("03-E: the module has no Harness, file or model dependency", async () => {
  const source = await readFile(new URL("../src/memory/context.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort();
  // Deliberately exact: a new runtime dependency in the pure module is a contract change.
  assert.deepEqual(specifiers, [
    "./contracts.js",
    "@earendil-works/chord",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/utils/estimate",
    "@earendil-works/pi-durable",
    "node:crypto",
  ]);

  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The SDK type imports are type-only: nothing from the agent runtime is loaded at run time.
  assert.match(code, /import type \{[^}]*\} from "@earendil-works\/pi-durable";/);
  assert.match(code, /import type \{ JsonValue \} from "@earendil-works\/chord";/);
  assert.doesNotMatch(code, /node:fs|node:child_process|node:sqlite|Harness|openNodeSqliteStorage|createModels/);

  // Pure in the small: a synchronous value in, a value out, with nothing cached between calls.
  const input = planInput({ snapshot: snapshot(), working: state({ revision: 2 }), workingInContext: false });
  assert.equal(planRequest(input) instanceof Promise, false);
  const once = planRequest(input);
  const twice = planRequest(input);
  assert.notEqual(once, twice, "each call builds its own value");
  assert.deepEqual(once, twice);
  assert.deepEqual(input, planInput({ snapshot: snapshot(), working: state({ revision: 2 }), workingInContext: false }));
});

test("03-F: rounds alone never force compaction, and measurement leaves the transcript intact", () => {
  const overRounds = MEMORY_BUDGET_DEFAULTS.evaluateAfterUserTurns + 5;
  // A short exchange has nothing worth summarizing: asking again every turn would churn B for no gain.
  for (const turns of [overRounds, overRounds + 1, overRounds + 2]) {
    assert.equal(plan({ userTurns: turns, compactableTokens: 0 }).action.kind, "none");
  }
  assert.deepEqual(plan({ userTurns: overRounds, compactableTokens: 4_000 }).action, { kind: "compact", reason: "rounds" });
  // The threshold itself is the boundary: one turn fewer is not a trigger.
  assert.equal(plan({ userTurns: MEMORY_BUDGET_DEFAULTS.evaluateAfterUserTurns - 1, compactableTokens: 4_000 }).action.kind, "none");

  // Measuring never rewrites the transcript, so a tool call stays attached to its result.
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const call = (note: string): Message => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "working_read", arguments: { note } }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { ...zero, cost },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const user: Message = { role: "user", content: "read the state", timestamp: 1 };
  const result: Message = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "working_read",
    content: [{ type: "text", text: "{}" }],
    isError: false,
    timestamp: 3,
  };
  const transcript: Message[] = [user, call("small"), result];
  const before = structuredClone(transcript);
  const measured = measureRequest(transcript);
  assert.deepEqual(transcript, before, "measurement is read-only");
  assert.ok(measureRequest([user, call("x".repeat(350)), result]) > measured, "tool arguments are counted");
});
