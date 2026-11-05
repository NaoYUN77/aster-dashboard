import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineDoc,
  Harness,
  ToolResultEntry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  assertSchema,
  baselineOf,
  CYCLE_BLOCK_CLOSE,
  CYCLE_BLOCK_OPEN,
  decodeCycleSnapshot,
  initialWorkingState,
  MEMORY_BUDGET_DEFAULTS,
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
  UNKNOWN_DATE,
  MemoryError,
  migrateWorkingDocument,
  ProfileItemDraftSchema,
  WORKING_DOC_KIND,
  WORKING_DOC_VERSION,
  WorkingStateSchema,
  WorkingUpdateArgsSchema,
  type CycleBoundary,
  type MemoryBudget,
  type MemorySegment,
  type SnapshotFacts,
  type WorkingState,
} from "../src/memory/contracts.js";
import {
  blockUsage,
  buildSnapshot,
  initialBoundary,
  planRequest,
  renderSnapshot,
  revisionWrite,
  snapshotOfProjection,
  type PlanInput,
} from "../src/memory/context.js";
import { openDaily, publishSegments } from "../src/memory/daily.js";
import { extractProfileDrafts, profilePutChanges, requireCurrentProfileEvidence } from "../src/memory/profile.js";
import { applyWorkingUpdate, readWorking, readWorkingAt } from "../src/memory/working.js";
import { createWorkingExtension } from "../src/memory/working-tools.js";

const context = BACKGROUND_CONTEXT;
const conversationId = 1 as ConversationId;
const entryId = (value: number) => value as EntryId;
const FACTS: SnapshotFacts = { instructionsDigest: "a1b2c3", memoryDigest: "d4e5f6" };

const isMemoryError = (code: string) => (error: unknown) => error instanceof MemoryError && error.code === code;

function state(overrides: Partial<WorkingState> = {}): WorkingState {
  return { ...initialWorkingState(), ...overrides };
}

function profileItem(id: string, text = `fact ${id}`) {
  return {
    id,
    text,
    category: "user-requirement",
    evidence: [{ date: "2026-10-25", id: `seg-${id}`, page: 1 }],
    updatedAt: 10,
  };
}

function segment(overrides: Partial<MemorySegment> & Pick<MemorySegment, "id" | "kind" | "text">): MemorySegment {
  return {
    version: MEMORY_SCHEMA_VERSION,
    date: "2026-10-25",
    timezone: "UTC",
    page: 1,
    status: "confirmed",
    sources: { conversationId, after: null, through: entryId(1) },
    supersedes: [],
    supersededBy: null,
    ...overrides,
  };
}

test("profile schema bounds items and rejects a model-supplied write time", () => {
  const item = profileItem("lang", "Answers in Chinese");
  assertSchema(WorkingStateSchema, state({ profile: [item] }), "invalid-input");
  assert.throws(
    () => assertSchema(ProfileItemDraftSchema, { ...item, updatedAt: 10 }, "invalid-input"),
    isMemoryError("invalid-input"),
  );
  assert.throws(
    () => assertSchema(WorkingUpdateArgsSchema, {
      expectedRevision: 1,
      evidence: [],
      changes: [{ op: "profile.put", item: { ...item, evidence: [], updatedAt: undefined } }],
    }, "invalid-input"),
    isMemoryError("invalid-input"),
  );
  assert.throws(
    () => assertSchema(ProfileItemDraftSchema, { ...item, evidence: [], updatedAt: undefined }, "invalid-input"),
    isMemoryError("invalid-input"),
    "a profile item needs at least one daily-log segment",
  );
  assert.throws(
    () => assertSchema(ProfileItemDraftSchema, {
      ...item,
      category: "x".repeat(MEMORY_LIMITS.category + 1),
      updatedAt: undefined,
    }, "invalid-input"),
    isMemoryError("invalid-input"),
  );
  assert.throws(
    () => assertSchema(WorkingStateSchema, state({
      profile: Array.from({ length: MEMORY_LIMITS.profile + 1 }, (_, index) => profileItem(`p${index}`)),
    }), "invalid-input"),
    isMemoryError("invalid-input"),
  );
});

test("version 1 working documents gain an empty profile; a current document missing it does not", () => {
  assert.equal(WORKING_DOC_VERSION, 2);
  const stored = {
    version: MEMORY_SCHEMA_VERSION,
    revision: 4,
    task: { status: "none" as const },
    preferences: [{
      id: "tone",
      text: "Be concise",
      scope: "global",
      source: { conversationId: 1, entryId: 2 },
      expiresAt: null,
    }],
    updatedAt: 10,
  };
  const migrated = migrateWorkingDocument(stored, 1);
  assert.deepEqual(migrated.profile, []);
  assert.equal(migrated.revision, 4);
  assert.equal(migrated.updatedAt, 10);
  assert.equal(migrated.preferences[0]?.id, "tone");
  assert.equal(migrated.version, MEMORY_SCHEMA_VERSION, "the shared schema version stays 1");

  const already = { ...stored, profile: [profileItem("lang")] };
  assert.equal(migrateWorkingDocument(already, 1).profile[0]?.id, "lang");
  assert.throws(() => migrateWorkingDocument(stored, WORKING_DOC_VERSION), isMemoryError("corrupt-state"));
  assert.throws(() => migrateWorkingDocument({ ...stored, extra: true }, 1), isMemoryError("corrupt-state"));
  assert.throws(() => migrateWorkingDocument(stored, 3), isMemoryError("unsupported-version"));
});

test("a pre-profile cycle snapshot decodes with an empty profile", () => {
  const old = {
    version: MEMORY_SCHEMA_VERSION,
    cycleId: "cycle-old",
    baseline: {
      version: MEMORY_SCHEMA_VERSION,
      revision: 2,
      task: { status: "none" },
      preferences: [],
    },
    boundary: { kind: "initial", anchor: null },
    sources: null,
    facts: { instructionsDigest: null, memoryDigest: null },
  };
  const body = `Earlier narrative.\n\n${CYCLE_BLOCK_OPEN}\n${JSON.stringify(old)}\n${CYCLE_BLOCK_CLOSE}`;
  const decoded = decodeCycleSnapshot(body);
  assert.equal(decoded?.baseline.revision, 2);
  assert.deepEqual(decoded?.baseline.profile, []);
  assert.equal(decoded?.narrative, "Earlier narrative.");

  const projected = snapshotOfProjection({ snapshot: { ...old, narrative: "Earlier narrative." } });
  assert.deepEqual(projected?.baseline.profile, []);
  assert.throws(
    () => decodeCycleSnapshot(`${CYCLE_BLOCK_OPEN}\n{"version":99}\n${CYCLE_BLOCK_CLOSE}`),
    isMemoryError("unsupported-version"),
  );
});

test("extractProfileDrafts keeps current user requirements that already fit an item", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/memory/profile.ts", import.meta.url)), "utf8");
  assert.equal(/completeSimple|Harness|defineTask/.test(source), false, "extraction does not call a model or start a loop");

  const fitting = "x".repeat(MEMORY_LIMITS.text);
  const drafts = extractProfileDrafts([
    segment({ id: "keep", kind: "user-requirement", text: "Answers in Chinese" }),
    segment({ id: "other", kind: "decision", text: "Ship on Friday" }),
    segment({ id: "old", kind: "user-requirement", text: "Use English", supersededBy: "keep" }),
    segment({ id: "long", kind: "user-requirement", text: "y".repeat(MEMORY_LIMITS.text + 1) }),
    segment({ id: "keep", kind: "user-requirement", text: "duplicate" }),
    segment({ id: "edge", kind: "user-requirement", text: fitting }),
  ]);
  assert.deepEqual(drafts.map((draft) => draft.id), ["keep", "edge"]);
  assert.equal(drafts[0]?.category, "user-requirement");
  assert.deepEqual(drafts[0]?.evidence, [{ date: "2026-10-25", id: "keep", page: 1 }]);
  assert.equal(drafts[1]?.text, fitting);
  assert.deepEqual(profilePutChanges(drafts).map((change) => change.op), ["profile.put", "profile.put"]);
});

test("the cycle snapshot renders the profile and still obeys snapshotTokens", () => {
  const item = profileItem("lang", "Answers in Chinese");
  item.updatedAt = 1_700_000_000_000;
  const working = state({ revision: 2, profile: [item] });
  const boundary: CycleBoundary = initialBoundary(entryId(5));
  const snapshot = buildSnapshot({
    cycleId: "cycle-1",
    narrative: "The user is preparing a release.",
    baseline: working,
    boundary,
    sources: { conversationId, after: null, through: entryId(9) },
    facts: FACTS,
  });
  const rendered = renderSnapshot(snapshot);
  assert.match(rendered, /Answers in Chinese/);
  assert.match(rendered, /seg-lang/);
  assert.equal(rendered.includes("updatedAt"), false);
  assert.equal(rendered.includes("1700000000000"), false);
  assert.deepEqual(baselineOf(working).profile[0], {
    id: "lang",
    text: "Answers in Chinese",
    category: "user-requirement",
    evidence: [{ date: "2026-10-25", id: "seg-lang", page: 1 }],
  });

  const later = state({ revision: 2, profile: [{ ...item, updatedAt: 1_800_000_000_000 }] });
  assert.equal(
    renderSnapshot(buildSnapshot({
      cycleId: "cycle-1",
      narrative: "The user is preparing a release.",
      baseline: later,
      boundary,
      sources: { conversationId, after: null, through: entryId(9) },
      facts: FACTS,
    })),
    rendered,
    "a profile write time does not change the snapshot bytes",
  );

  const revision = revisionWrite(working, FACTS);
  assert.match(revision.text, /Answers in Chinese/);
  assert.equal(revision.text.includes("updatedAt"), false);

  const tight: MemoryBudget = { ...MEMORY_BUDGET_DEFAULTS, snapshotTokens: 256 };
  const fat = state({
    revision: 3,
    profile: Array.from({ length: 8 }, (_, index) => profileItem(`p${index}`, "x".repeat(MEMORY_LIMITS.text))),
  });
  const wide = buildSnapshot({
    cycleId: "cycle-wide",
    narrative: "n",
    baseline: fat,
    boundary,
    sources: null,
    facts: FACTS,
  });
  const usage = blockUsage({ budget: tight, instructionsText: "rules", snapshot: wide });
  assert.equal(usage.find((entry) => entry.block === "snapshot")?.withinLimit, false);
  const input: PlanInput = {
    budget: tight,
    instructionsText: "SYSTEM RULES: be concise.",
    snapshot: wide,
    working: fat,
    workingInContext: true,
    inputTokens: 1_000,
    contextWindow: 200_000,
    reserveTokens: 16_000,
    userTurns: 0,
    compactableTokens: 0,
    facts: FACTS,
  };
  const plan = planRequest(input);
  assert.equal(plan.action.kind, "error");
  assert.equal(plan.action.kind === "error" ? plan.action.error.code : "", "budget-exceeded");
  assert.equal(
    plan.action.kind === "error" ? (plan.action.error.detail as { block?: string }).block : "",
    "snapshot",
  );
});

type Fixture = {
  readonly directory: string;
  readonly faux: FauxProviderHandle;
  harness: Harness;
  root: Conversation;
};

async function openFixture(name: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const store = openDaily(directory);
  registry.install(createWorkingExtension({
    resolveProfileEvidence: (refs) => requireCurrentProfileEvidence(store, refs),
  }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  harness.resume();
  return { directory, faux, harness, root };
}

async function reopen(fixture: Fixture): Promise<void> {
  await fixture.harness.close(context);
  const models = createModels();
  models.setProvider(fixture.faux.provider);
  const registry = createRegistry();
  const store = openDaily(fixture.directory);
  registry.install(createWorkingExtension({
    resolveProfileEvidence: (refs) => requireCurrentProfileEvidence(store, refs),
  }));
  fixture.harness = await Harness.open(
    await openNodeSqliteStorage(join(fixture.directory, "agent.sqlite")),
    { models, registry },
    context,
  );
  fixture.root = await fixture.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  fixture.harness.resume();
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.harness.close(context).catch(() => {});
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

const LegacyWorkingDoc = defineDoc({
  kind: WORKING_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({
    version: MEMORY_SCHEMA_VERSION,
    revision: 3,
    task: { status: "none" as const },
    preferences: [],
    updatedAt: 42,
  }),
});

function taskDraft(goal: string) {
  return {
    status: "active" as const,
    goal,
    scope: null,
    constraints: [],
    progress: [],
    blockers: [],
    nextStep: null,
    notes: null,
  };
}

test("a stored version 1 working document loads, and profile ops follow preference rules", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-profile-ops-");
  try {
    const seeded = await fixture.harness.commit(async (tx) => {
      await tx.doc(LegacyWorkingDoc, fixture.root.id);
      return (await tx.appendEntry(fixture.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "Answer in Chinese." }], timestamp: 1 }],
      })).id;
    }, context);
    await reopen(fixture);

    const loaded = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(loaded.revision, 3);
    assert.equal(loaded.updatedAt, 42);
    assert.deepEqual(loaded.profile, []);
    const atSeed = await readWorkingAt(fixture.harness, fixture.root.id, seeded, context);
    assert.deepEqual(atSeed.profile, []);
    assert.equal(atSeed.revision, 3);

    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-unresolved",
      expectedRevision: 3,
      evidence: [],
      changes: [{
        op: "profile.put",
        item: {
          id: "lang",
          text: "Answers in Chinese",
          category: "user-requirement",
          evidence: [{ date: "2026-10-25", id: "seg-lang", page: 1 }],
        },
      }],
      now: 50,
    }, context), isMemoryError("missing-evidence"));
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).revision, 3);

    const item = {
      id: "lang",
      text: "Answers in Chinese",
      category: "user-requirement",
      evidence: [{ date: "2026-10-25", id: "seg-lang", page: 1 }],
    };
    const put = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-1",
      expectedRevision: 3,
      evidence: [],
      changes: [{ op: "profile.put", item }],
      resolveProfileEvidence: async () => {},
      now: 100,
    }, context);
    assert.equal(put.changed, true);
    assert.equal(put.revision, 4);
    const stored = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(stored.profile[0]?.updatedAt, 100);
    assert.deepEqual(stored.profile[0]?.evidence, item.evidence);

    const replay = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-1",
      expectedRevision: 3,
      evidence: [],
      changes: [{ op: "profile.put", item: { ...item, text: "Answers in English" } }],
      resolveProfileEvidence: async () => {},
      now: 999,
    }, context);
    assert.deepEqual(replay, put, "the same operation id does not apply a second time");

    const again = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-2",
      expectedRevision: 4,
      evidence: [],
      changes: [{ op: "profile.put", item }],
      resolveProfileEvidence: async () => {},
      now: 200,
    }, context);
    assert.equal(again.changed, false);
    assert.equal(again.revision, 4);
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).profile[0]?.updatedAt, 100);

    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-stale",
      expectedRevision: 2,
      evidence: [],
      changes: [{ op: "profile.put", item }],
      resolveProfileEvidence: async () => {},
      now: 300,
    }, context), isMemoryError("revision-conflict"));

    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-date",
      expectedRevision: 4,
      evidence: [],
      changes: [{ op: "profile.put", item: { ...item, id: "bad-date", evidence: [{ date: "2026-02-31", id: "seg-x", page: 1 }] } }],
      resolveProfileEvidence: async () => {},
      now: 300,
    }, context), isMemoryError("invalid-input"));

    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-missing",
      expectedRevision: 4,
      evidence: [],
      changes: [{ op: "profile.remove", id: "missing" }],
      resolveProfileEvidence: async () => {},
      now: 300,
    }, context), isMemoryError("invalid-input"));
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).revision, 4);

    const replaced = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-3",
      expectedRevision: 4,
      evidence: [],
      changes: [{ op: "profile.put", item: { ...item, text: "Answers in Chinese, briefly" } }],
      resolveProfileEvidence: async () => {},
      now: 400,
    }, context);
    assert.equal(replaced.revision, 5);
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).profile[0]?.updatedAt, 400);

    const task = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-task",
      expectedRevision: 5,
      evidence: [seeded],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      resolveProfileEvidence: async () => {},
      now: 500,
    }, context);
    const cleared = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-clear",
      expectedRevision: task.revision,
      evidence: [],
      changes: [{ op: "task.clear" }],
      resolveProfileEvidence: async () => {},
      now: 600,
    }, context);
    const afterClear = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(afterClear.task.status, "none");
    assert.equal(afterClear.profile[0]?.id, "lang", "clearing the task does not clear the profile");
    assert.equal(cleared.changed, true);

    const removed = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-remove",
      expectedRevision: afterClear.revision,
      evidence: [],
      changes: [{ op: "profile.remove", id: "lang" }],
      resolveProfileEvidence: async () => {},
      now: 700,
    }, context);
    assert.deepEqual((await readWorking(fixture.harness, fixture.root.id, context)).profile, []);

    const filled = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-fill",
      expectedRevision: removed.revision,
      evidence: [],
      changes: Array.from({ length: MEMORY_LIMITS.profile }, (_, index) => ({
        op: "profile.put" as const,
        item: {
          id: `p${index + 1}`,
          text: `fact ${index + 1}`,
          category: "user-requirement",
          evidence: [{ date: "2026-10-25", id: `seg-${index + 1}`, page: 1 }],
        },
      })),
      resolveProfileEvidence: async () => {},
      now: 800,
    }, context);
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).profile.length, MEMORY_LIMITS.profile);
    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:profile-over",
      expectedRevision: filled.revision,
      evidence: [],
      changes: [{
        op: "profile.put",
        item: {
          id: "overflow",
          text: "one more",
          category: "user-requirement",
          evidence: [{ date: UNKNOWN_DATE, id: "seg-over", page: 2 }],
        },
      }],
      resolveProfileEvidence: async () => {},
      now: 900,
    }, context), isMemoryError("invalid-input"));
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).profile.length, MEMORY_LIMITS.profile);

    await reopen(fixture);
    const restored = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(restored.profile.length, MEMORY_LIMITS.profile);
    assert.equal(restored.profile[0]?.id, "p1");
  } finally {
    await dispose(fixture);
  }
});

function textOf(message: { readonly content: readonly { readonly type: string }[] }): string {
  return message.content.flatMap((part) => (part.type === "text" ? [(part as unknown as { text: string }).text] : [])).join("\n");
}

test("profile.put rejects evidence that is missing, on the wrong page, or no longer current", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-profile-evidence-");
  try {
    const store = openDaily(fixture.directory);
    const kept = segment({ id: "kept", kind: "user-requirement", text: "Answers in Chinese", date: "2026-10-25" });
    const replaced = segment({ id: "old", kind: "user-requirement", text: "Use English", date: "2026-10-24" });
    await publishSegments(store, [kept, replaced]);
    await publishSegments(store, [segment({
      id: "new",
      kind: "user-requirement",
      text: "Answers in Chinese",
      date: "2026-10-26",
      supersedes: ["old"],
    })]);
    const cite = (id: string, date: string, page = 1) => ({
      id,
      text: "Answers in Chinese",
      category: "user-requirement",
      evidence: [{ date, id, page }],
    });
    const resolveProfileEvidence = (refs: Parameters<typeof requireCurrentProfileEvidence>[1]) =>
      requireCurrentProfileEvidence(store, refs);
    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:missing",
      expectedRevision: 1,
      evidence: [],
      changes: [{ op: "profile.put", item: cite("absent", "2026-10-25") }],
      resolveProfileEvidence,
      now: 1,
    }, context), isMemoryError("missing-evidence"));
    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:page",
      expectedRevision: 1,
      evidence: [],
      changes: [{ op: "profile.put", item: cite("kept", "2026-10-25", 2) }],
      resolveProfileEvidence,
      now: 2,
    }, context), isMemoryError("missing-evidence"));
    await assert.rejects(applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:stale-segment",
      expectedRevision: 1,
      evidence: [],
      changes: [{ op: "profile.put", item: cite("old", "2026-10-24") }],
      resolveProfileEvidence,
      now: 3,
    }, context), isMemoryError("missing-evidence"));
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).revision, 1);
    const accepted = await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId: "tool:current",
      expectedRevision: 1,
      evidence: [],
      changes: [{ op: "profile.put", item: cite("kept", "2026-10-25") }],
      resolveProfileEvidence,
      now: 4,
    }, context);
    assert.equal(accepted.revision, 2);
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).profile[0]?.id, "kept");
  } finally {
    await dispose(fixture);
  }
});

test("working_read and working_update show and accept the profile", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-profile-tool-");
  try {
    await publishSegments(openDaily(fixture.directory), [
      segment({ id: "seg-lang", kind: "user-requirement", text: "Answers in Chinese", date: "2026-10-25" }),
    ]);
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 1,
        evidence: [],
        changes: [{
          op: "profile.put",
          item: {
            id: "lang",
            text: "Answers in Chinese",
            category: "user-requirement",
            evidence: [{ date: "2026-10-25", id: "seg-lang", page: 1 }],
          },
        }],
      }, { id: "put-profile" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("working_read", {}, { id: "read-profile" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 2,
        evidence: [],
        changes: [{
          op: "profile.put",
          item: {
            id: "missing",
            text: "Not in the log",
            category: "user-requirement",
            evidence: [{ date: "2026-10-25", id: "seg-missing", page: 1 }],
          },
        }],
      }, { id: "put-missing" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Noted."),
    ]);
    assert.equal((await (await fixture.root.submit({
      type: "input",
      content: "Remember that I want answers in Chinese.",
      requestId: "profile-tool",
    }, context)).wait(context)).status, "done");

    const results = (await fixture.root.entries({ order: "ascending" }, 50, undefined, context)).items
      .filter((entry: EntryRecord) => ToolResultEntry.is(entry))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult");
    const byId = new Map(results.map((message) => [message.toolCallId, message]));
    const put = byId.get("put-profile");
    const read = byId.get("read-profile");
    assert.ok(put);
    assert.ok(read);
    assert.equal(put.isError, false);
    assert.match(textOf(put), /profile: lang: Answers in Chinese \(user-requirement; 2026-10-25\/seg-lang p1\)/);
    assert.match(textOf(read), /profile: lang: Answers in Chinese \(user-requirement; 2026-10-25\/seg-lang p1\)/);
    const missing = byId.get("put-missing");
    assert.ok(missing);
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /missing-evidence/);
    const stored = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(stored.revision, 2);
    assert.equal(stored.profile.length, 1);
    assert.equal(stored.profile[0]?.text, "Answers in Chinese");
  } finally {
    await dispose(fixture);
  }
});
