import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  MEMORY_BUDGET_DEFAULTS,
  MemoryError,
  type MemoryBudget,
} from "../src/memory/contracts.js";
import {
  comparePrefix,
  compactionThresholds,
  confirmCompactionCycle,
  createCompactionExtension,
  createHarnessConfirmDeps,
  deriveCompactionKey,
  evaluateCompaction,
  nativeCompactionPolicy,
  publishedSnapshot,
  readCompactionSummary,
  readCompactionTurnCount,
  recordCompletedUserRequest,
  requestPrefixFingerprint,
  summaryBodyOfEntry,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USAGE_KEY,
  type CompactionObservation,
} from "../src/memory/compaction.js";
import { applyWorkingUpdate, readWorking } from "../src/memory/working.js";
import { workingExtension } from "../src/memory/working-tools.js";

const context = BACKGROUND_CONTEXT;
const agent = { model: { provider: "faux", modelId: "faux-1" }, instructions: "SYSTEM RULES: be concise." };
const SUMMARY_MODEL = { provider: "summary", modelId: "summary-1" };

// Context windows are small so threshold compaction is reachable with short fixtures (as in
// test/memory-contract.test.ts). The summary model is a separate faux provider, so adapter calls
// never consume the main agent's scripted replies.
const COMPACTION = { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 0 };
const BACKGROUND_COMPACTION = { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 200 };

type Registry = ReturnType<typeof createRegistry>;

type Fixture = {
  readonly directory: string;
  readonly database: string;
  readonly faux: FauxProviderHandle;
  readonly summaryFaux: FauxProviderHandle;
  readonly registry: Registry;
  readonly observations: CompactionObservation[];
  readonly summaryRequests: string[];
  readonly compactionSettings: typeof COMPACTION;
  harness: Harness;
  root: Conversation;
};

async function openFixture(name: string, options: {
  readonly compaction?: typeof COMPACTION;
  readonly withAdapter?: boolean;
  readonly withWorkingTools?: boolean;
  readonly budget?: MemoryBudget;
  readonly maxAttempts?: number;
  readonly contextWindow?: number;
} = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const database = join(directory, "agent.sqlite");
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: options.contextWindow ?? 1200, maxTokens: 512 }],
  });
  const summaryFaux = fauxProvider({ provider: "summary", models: [{ id: "summary-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  models.setProvider(summaryFaux.provider);
  const registry = createRegistry();
  if (options.withWorkingTools !== false) registry.install(workingExtension);
  const observations: CompactionObservation[] = [];
  const summaryRequests: string[] = [];
  summaryFaux.setResponses(Array.from({ length: 32 }, () => (transcript: { messages: readonly Message[] }) => {
    summaryRequests.push(JSON.stringify(transcript.messages));
    return fauxAssistantMessage("The work continues: the release task is tracked, decisions and constraints are preserved.");
  }));
  let harness: Harness | undefined;
  const fixture: Fixture = {
    directory,
    database,
    faux,
    summaryFaux,
    registry,
    observations,
    summaryRequests,
    compactionSettings: options.compaction ?? COMPACTION,
    // Assigned below, before any hook can run.
    harness: undefined as never,
    root: undefined as never,
  };
  if (options.withAdapter !== false) {
    registry.install(createCompactionExtension({
      commit: { commit: (change, ctx) => harness!.commit(change, ctx) },
      model: SUMMARY_MODEL,
      budget: options.budget,
      maxAttempts: options.maxAttempts,
      onResult: (observation) => observations.push(observation),
    }));
  }
  harness = await Harness.open(await openNodeSqliteStorage(database), {
    models,
    registry,
    settings: { compaction: options.compaction ?? COMPACTION },
  }, context);
  const root = await harness.root(context, { agent });
  harness.resume();
  fixture.harness = harness;
  fixture.root = root;
  return fixture;
}

/** Install the adapter after the harness exists (06-E's upgrade path: native first, adapter later). */
function installAdapter(fixture: Fixture): void {
  fixture.registry.install(createCompactionExtension({
    commit: fixture.harness,
    model: SUMMARY_MODEL,
    onResult: (observation) => fixture.observations.push(observation),
  }));
}

/** Reopen the same database, as a restart does; everything must be re-readable from storage. */
async function reopen(fixture: Fixture): Promise<void> {
  await fixture.harness.close(context);
  const models = createModels();
  models.setProvider(fixture.faux.provider);
  models.setProvider(fixture.summaryFaux.provider);
  const registry = createRegistry();
  registry.install(workingExtension);
  registry.install(createCompactionExtension({
    commit: { commit: (change, ctx) => fixture.harness.commit(change, ctx) },
    model: SUMMARY_MODEL,
    onResult: (observation) => fixture.observations.push(observation),
  }));
  fixture.harness = await Harness.open(await openNodeSqliteStorage(fixture.database), {
    models,
    registry,
    // The same settings as before the restart: a reopen that silently reverted to the default
    // policy (keepRecent 20000) would make every later compaction a no-op.
    settings: { compaction: fixture.compactionSettings },
  }, context);
  fixture.root = await fixture.harness.root(context, { agent });
  fixture.harness.resume();
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.harness.close(context).catch(() => {});
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

/** Poll a durable condition without guessing a fixed sleep. */
async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a durable condition");
    await delay(25);
  }
}

function gatedTool(gate: Promise<void>) {
  return defineTool({
    name: "probe_gate",
    description: "Wait for the test to release the run.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => {
      await gate;
      return { output: [{ type: "text", text: "released" }] };
    },
  });
}

/** Full transcripts of the main agent's requests, in order, as the provider adapter receives them. */
type TranscriptRecord = { readonly messages: readonly Message[] };

function recorder(records: TranscriptRecord[], reply: string): (transcript: { messages: readonly Message[] }) => ReturnType<typeof fauxAssistantMessage> {
  return (transcript) => {
    records.push({ messages: [...transcript.messages] });
    return fauxAssistantMessage(reply);
  };
}

function sectionText(messages: readonly Message[], key: string): string | undefined {
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    const value = message.sections[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function toolNamesOf(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));
}

/** A committed user entry: the evidence a working update cites. */
async function userEntry(fixture: Fixture, text: string): Promise<EntryId> {
  return fixture.harness.commit(
    async (tx) => (await tx.appendEntry(fixture.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
    })).id,
    context,
  );
}

function taskDraft(goal: string, extra: { constraints?: string[]; progress?: { id: string; text: string; status: "done" | "in-progress" | "blocked"; evidence: EntryId[] }[] } = {}) {
  return {
    status: "active" as const,
    goal,
    scope: null,
    constraints: extra.constraints ?? [],
    progress: extra.progress ?? [],
    blockers: [],
    nextStep: null,
    notes: null,
  };
}

function updateWorking(fixture: Fixture, fields: {
  operationId: string;
  expectedRevision: number;
  evidence: EntryId[];
  changes: Parameters<typeof applyWorkingUpdate>[1]["changes"];
}) {
  return applyWorkingUpdate(fixture.harness, {
    conversationId: fixture.root.id,
    operationId: fields.operationId,
    expectedRevision: fields.expectedRevision,
    evidence: fields.evidence,
    changes: fields.changes,
    now: Date.now(),
  }, context);
}

function compactionTasks(fixture: Fixture) {
  return fixture.harness.commit(
    async (tx) => (await tx.scanTasks({ conversationId: fixture.root.id, kind: "pi.compaction" }, 40)).items,
    context,
  );
}

function summarySubmission(fixture: Fixture, taskId: number) {
  return fixture.harness.commit(
    async (tx) => tx.submissionByRequest(fixture.root.id, `compaction:${taskId}`),
    context,
  );
}

async function usageOf(fixture: Fixture) {
  return (await fixture.harness.snapshot(UsageDoc, fixture.root.id, context))!.models;
}

async function submitDone(fixture: Fixture, content: string, requestId: string): Promise<void> {
  const submission = await fixture.root.submit({ type: "input", content, requestId }, context);
  assert.equal((await submission.wait(context)).status, "done", `request ${requestId} must complete`);
}

// 06-A: after a compaction, A / new B / retained C are all rebuilt from durable records — the
// published head decodes to the snapshot built at the boundary, the post-compaction request
// carries instructions and tool declarations, and the replaced raw entries are NOT deleted.
test("06-A: A/B/C rebuild from durable records after compaction; raw entries survive", { timeout: 90_000 }, async () => {
  const records: TranscriptRecord[] = [];
  const fixture = await openFixture("memory-06a-");
  try {
    fixture.faux.setResponses(Array.from({ length: 8 }, () => recorder(records, "answer ".repeat(60))));
    await submitDone(fixture, "q1 ".repeat(120), "1");
    const evidence = (await fixture.root.entries({ order: "ascending" }, 50, undefined, context)).items
      .find((entry) => entry.kind === "pi.user")!;
    const receipt = await updateWorking(fixture, {
      operationId: "tool:a1",
      expectedRevision: 1,
      evidence: [evidence.id],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
    });
    assert.equal(receipt.revision, 2);
    await submitDone(fixture, "q2 ".repeat(120), "2");
    // The first compaction's cut predates the working update (its anchor sits in the retained
    // range), so its B carries the initial revision — the boundary rule, not the newest state.
    const firstHead = (await fixture.root.context(context)).head;
    assert.equal(firstHead?.kind, "pi.compaction", "the second turn already compacted");
    const firstSnapshot = publishedSnapshot(firstHead!);
    assert.ok(firstSnapshot !== undefined);
    assert.equal(firstSnapshot.baseline.revision, 1, "the first B predates the update: initial boundary state");
    await submitDone(fixture, "q3 ".repeat(120), "3");
    await until(async () => {
      const head = (await fixture.root.context(context)).head;
      return head !== undefined && head.id !== firstHead!.id && head.kind === "pi.compaction";
    });

    const view = await fixture.root.context(context);
    const head = view.head!;
    assert.equal(head.kind, "pi.compaction");
    // B: the head's model text decodes to the application snapshot built at the boundary.
    const snapshot = publishedSnapshot(head);
    assert.ok(snapshot !== undefined, "the published head carries an application snapshot");
    assert.equal(snapshot.baseline.revision, 2, "B carries the boundary working revision");
    assert.equal(snapshot.boundary.kind, "compaction");
    assert.equal(snapshot.boundary.kind === "compaction" ? snapshot.boundary.firstKept : undefined, head.head);
    assert.equal(snapshot.boundary.kind === "compaction" ? snapshot.boundary.anchor : undefined, receipt.anchorEntryId);
    assert.equal(snapshot.sources?.conversationId, fixture.root.id);
    assert.equal(snapshot.sources?.after, firstSnapshot.sources!.through, "the second cycle chains after the first one's range");
    assert.ok(JSON.stringify(view.messages).includes(snapshot.narrative), "the active context starts from the new B");
    // C: everything the view keeps starts at firstKept.
    assert.ok(view.entries.slice(1).every((entry) => entry.id >= head.head!), "retained C starts at firstKept");
    // The replaced raw entries are still in the durable history: compaction deletes nothing.
    const all = (await fixture.root.entries({ order: "ascending" }, 500, undefined, context)).items;
    assert.ok(all.length > view.entries.length, "history holds more than the active view");
    assert.ok(all.some((entry) => entry.id === evidence.id), "the replaced user entry is still stored");
    assert.ok(all.some((entry) => entry.id === receipt.anchorEntryId), "the replaced anchor is still stored");

    // A: a request recorded after the compaction carries the instructions section and tools.
    const postCompaction = records.at(-1)!;
    assert.match(sectionText(postCompaction.messages, "instructions") ?? "", /SYSTEM RULES: be concise\./);
    assert.ok(toolNamesOf(postCompaction.messages).includes("working_update"), "tool declarations survive compaction");
    assert.ok(JSON.stringify(postCompaction.messages).includes("<cycle-snapshot>"), "the post-compaction request carries B");

    // Usage: the hook's own call is accounted under the application key, and only there.
    const usage = await usageOf(fixture);
    assert.ok((usage[SUMMARY_USAGE_KEY]?.totalTokens ?? 0) > 0, "summary usage is recorded under app/summary");
    assert.equal(usage["summary/summary-1"], undefined, "the hook call produced no native usage record");

    // The blocking path confirms the switch by entryId === head (§14.5): use the task whose
    // outcome produced the CURRENT head (the second compaction's), not just any settled one.
    const tasks = await compactionTasks(fixture);
    const settledTasks = await Promise.all(tasks.map(async (task) => fixture.harness.getTask(task.id, context)));
    const blocking = settledTasks.find(
      (task) => task?.state.outcome?.status === "completed"
        && (task.state.outcome as { result?: { entryId?: EntryId } }).result?.entryId === head.id,
    );
    assert.ok(blocking !== undefined, "a blocking compaction produced the current head");
    const settledTask = await fixture.harness.getTask(blocking.id, context);
    assert.equal(settledTask?.state.outcome?.status, "completed");
    const confirmed = await confirmCompactionCycle(
      createHarnessConfirmDeps(fixture.harness), fixture.root.id, blocking.id as TaskId, context,
    );
    assert.equal(confirmed.status, "switched");
    assert.equal(confirmed.status === "switched" ? confirmed.entryId : undefined, head.id);
    assert.equal(confirmed.status === "switched" ? confirmed.snapshot?.baseline.revision : undefined, 2);
    assert.deepEqual(
      confirmed.status === "switched" ? confirmed.archiveRange : undefined,
      { conversationId: fixture.root.id, after: firstSnapshot.sources!.through, through: snapshot.sources!.through },
    );
    // The saved result was persisted before publication, under its stable key.
    const observed = fixture.observations.filter((item) => item.outcome === "succeeded").at(-1);
    assert.ok(observed !== undefined, "the hook reported a success");
    const saved = await readCompactionSummary(fixture.harness, fixture.root.id, observed.key, context);
    assert.equal(saved?.status, "succeeded");
    assert.equal(saved?.rendered, summaryBodyOfEntry(head));
  } finally {
    await dispose(fixture);
  }
});

// 06-B: the baseline is the state at the cut, not the newest state. Layout (entry order):
// turn 1, update X (rev 2, anchor in what the first compaction retains), turn 2 (compaction 1
// publishes an initial-state B), update Y (rev 3, anchor after turn 2), turn 3 (compaction 2
// replaces a range holding X's anchor but retains Y's). The new B must carry revision 2 with
// X's anchor, Y stays in C as the current state, and the head marker's own id — larger than
// every retained entry, Y's anchor included — must not pull the boundary read forward.
test("06-B: B takes the boundary revision; the retained C keeps the later revision", { timeout: 90_000 }, async () => {
  const records: TranscriptRecord[] = [];
  const fixture = await openFixture("memory-06b-");
  try {
    fixture.faux.setResponses(Array.from({ length: 6 }, () => recorder(records, "answer ".repeat(60))));
    const seed = await userEntry(fixture, "Track the release task.");
    await submitDone(fixture, "q1 ".repeat(120), "1");
    const atBoundary = await updateWorking(fixture, {
      operationId: "tool:b1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
    });
    assert.equal(atBoundary.revision, 2);
    await submitDone(fixture, "q2 ".repeat(120), "2");
    const firstHead = (await fixture.root.context(context)).head;
    assert.equal(firstHead?.kind, "pi.compaction", "the second turn compacted once");
    assert.equal(publishedSnapshot(firstHead!)?.baseline.revision, 1, "the first cut predates update X");
    // Update Y lands in what the next compaction retains: it belongs to C, not to the next B.
    const afterCut = await updateWorking(fixture, {
      operationId: "tool:b2",
      expectedRevision: 2,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints: ["added after the cut"] }) }],
    });
    assert.equal(afterCut.revision, 3);
    await submitDone(fixture, "q3 ".repeat(120), "3");
    await until(async () => {
      const head = (await fixture.root.context(context)).head;
      return head !== undefined && head.id !== firstHead!.id && head.kind === "pi.compaction";
    });

    const view = await fixture.root.context(context);
    const head = view.head!;
    const snapshot = publishedSnapshot(head);
    assert.ok(snapshot !== undefined);
    assert.equal(snapshot.baseline.revision, 2, `B must carry the boundary revision 2, not the later 3 (firstKept=${head.head}, anchorX=${atBoundary.anchorEntryId}, anchorY=${afterCut.anchorEntryId})`);
    assert.equal(snapshot.boundary.kind === "compaction" ? snapshot.boundary.anchor : undefined, atBoundary.anchorEntryId);
    // The later update is retained in C and is still the current state.
    assert.ok(view.entries.some((entry) => entry.id === afterCut.anchorEntryId), "the post-cut anchor is retained in C");
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).revision, 3);
    // The head marker's id is later than the retained entries; the boundary read ignored that.
    assert.ok(head.id > head.head!, "the marker sits after the retained range");
    assert.ok(head.id > afterCut.anchorEntryId, "the marker id is even later than the post-cut anchor");
  } finally {
    await dispose(fixture);
  }
});

// 06-C: ONE long user request compacts at least twice, and the model calls after each cut keep
// reading the correct working state — no next user input, no model-initiated re-read. The tool
// below both returns a large result (driving the next blocking compaction) and checkpoints the
// working state through the same commit protocol as `working_update`, so each replaced range
// after the first holds a fresh anchor for the next boundary.
test("06-C: two compactions inside one long request keep the working state continuous", { timeout: 120_000 }, async () => {
  const records: TranscriptRecord[] = [];
  const fixture = await openFixture("memory-06c-");
  let expectedRevision = 2;
  let evidenceId: EntryId | undefined;
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    evidenceId = seed;
    const initial = await updateWorking(fixture, {
      operationId: "tool:c0",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
    });
    assert.equal(initial.revision, 2);

    const checkpoint = defineTool({
      name: "big_checkpoint",
      description: "Checkpoint the working state and return a large result.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "safe",
      execute: async (_args, api) => {
        const step = expectedRevision - 1;
        const receipt = await applyWorkingUpdate(api as never, {
          conversationId: api.conversationId,
          operationId: `tool:${api.taskId}`,
          expectedRevision,
          evidence: [evidenceId!],
          changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints: [`checkpoint ${step}`] }) }],
          now: Date.now(),
        }, context);
        expectedRevision = receipt.revision;
        return { output: [{ type: "text", text: "big ".repeat(700) }] };
      },
    });
    fixture.registry.install(defineExtension({ name: "checkpoint-tool", tools: [checkpoint] }));

    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("big_checkpoint", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("big_checkpoint", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("big_checkpoint", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("big_checkpoint", {}), { stopReason: "toolUse" }),
      recorder(records, "final ".repeat(40)),
      recorder(records, "final ".repeat(40)),
    ]);
    // The whole scenario is this single request: every compaction happens inside its run.
    await submitDone(fixture, "Run the long task.", "long-1");

    const succeeded = fixture.observations.filter((item) => item.outcome === "succeeded" || item.outcome === "reused");
    assert.ok(succeeded.length >= 2, `expected at least two published compactions in one request, got ${succeeded.length} successes and ${fixture.observations.filter((i) => i.outcome === "declined").length} declines`);
    const tasks = await compactionTasks(fixture);
    assert.ok(tasks.filter((task) => task.state.status === "terminal").length >= 2, "at least two compaction tasks settled");

    const view = await fixture.root.context(context);
    assert.equal(view.head?.kind, "pi.compaction");
    const snapshot = publishedSnapshot(view.head!);
    assert.ok(snapshot !== undefined);
    assert.ok(
      snapshot.baseline.revision >= 3,
      `the last B is built from an in-request checkpoint (revision >= 3), not the pre-request revision 2; got ${snapshot.baseline.revision}`,
    );
    // A model call after a compaction inside the same run carried B — no user input intervened.
    assert.ok(
      records.some((record) => JSON.stringify(record.messages).includes("<cycle-snapshot>")),
      "a post-compaction model call inside the run carried the new B",
    );
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).revision, expectedRevision);
  } finally {
    await dispose(fixture);
  }
});

// 06-D: a background compaction switches the cycle only when its submission lands `done` with
// the head in place; a failed summary declines without publishing; a restart re-scan confirms
// the same switch from the submission and the head alone (§12.3, §14.5).
test("06-D: background publication, failure accounting and restart re-scan", { timeout: 120_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  // No working tools in this fixture: their schemas inflate every request's measured usage
  // (the faux usage counts the full request), which would cross the BLOCKING threshold at the
  // gated run's preparation instead of the background one. The working state is still written
  // through the module directly, so the boundary anchor exists exactly as with the tools.
  const fixture = await openFixture("memory-06d-", { compaction: BACKGROUND_COMPACTION, withWorkingTools: false });
  try {
    // Install the gated tool alongside the adapter (the fixture's registry stays live).
    fixture.registry.install(defineExtension({ name: "gate-tool", tools: [gatedTool(gate.promise)] }));
    const seed = await userEntry(fixture, "Track the release task.");
    await updateWorking(fixture, {
      operationId: "tool:d0",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
    });
    fixture.faux.setResponses([fauxAssistantMessage("seed ".repeat(180))]);
    await submitDone(fixture, "q1 ".repeat(150), "1");

    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("after gate"),
    ]);
    const run = await fixture.root.submit({ type: "input", content: "q2 ".repeat(150), requestId: "2" }, context);
    await until(async () => (await compactionTasks(fixture)).some((task) => task.state.status === "terminal"), 15_000);
    const [task] = await compactionTasks(fixture);
    assert.ok(task !== undefined);
    const deps = () => createHarnessConfirmDeps(fixture.harness);
    // Enqueued is not published: the task settled, the write still waits for a boundary.
    const queued = await summarySubmission(fixture, task.id);
    assert.equal(queued?.status, "queued", "the background summary is enqueued while the run is busy");
    const early = await confirmCompactionCycle(deps(), fixture.root.id, task.id as TaskId, context);
    assert.equal(early.status, "pending", "a queued submission must not confirm a switch");

    gate.resolve();
    assert.equal((await run.wait(context)).status, "done");
    await until(async () => (await summarySubmission(fixture, task.id))?.status === "done");
    const switched = await confirmCompactionCycle(deps(), fixture.root.id, task.id as TaskId, context);
    assert.equal(switched.status, "switched");
    const headAfterPublish = (await fixture.root.context(context)).head!;
    assert.equal(switched.status === "switched" ? switched.entryId : undefined, headAfterPublish.id);
    assert.equal(switched.status === "switched" ? switched.snapshot?.baseline.revision : undefined, 2);

    // Restart: the same confirmation is rebuilt from the submission and the head alone.
    await reopen(fixture);
    const rescanned = await confirmCompactionCycle(deps(), fixture.root.id, task.id as TaskId, context);
    assert.equal(rescanned.status, "switched", "after reopen, submission done + head still confirm the switch");
    assert.equal(rescanned.status === "switched" ? rescanned.entryId : undefined, headAfterPublish.id);

    // Failure: the summary model errors on every attempt. The hook declines, publishes nothing,
    // keeps the old B/C, and still accounts the failed attempts and persists the failure fact.
    const usageBefore = (await usageOf(fixture))[SUMMARY_USAGE_KEY]?.totalTokens ?? 0;
    fixture.summaryFaux.setResponses(Array.from({ length: 6 }, () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" })));
    fixture.faux.setResponses([fauxAssistantMessage("more ".repeat(300)), fauxAssistantMessage("more ".repeat(300))]);
    await submitDone(fixture, "q3 ".repeat(200), "3");
    const headBeforeFailure = (await fixture.root.context(context)).head;
    // A fresh anchor for the manual compaction's range: the phase-1 anchor was already replaced,
    // and a range with state but no anchor declines `not-covered` before any model call (the
    // boundary rule) — which is a different failure than the one under test here.
    await updateWorking(fixture, {
      operationId: "tool:d1",
      expectedRevision: 2,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints: ["still shipping"] }) }],
    });
    await submitDone(fixture, "q4 ".repeat(200), "4");
    const failing = await fixture.root.compact(undefined, context);
    await until(async () => (await fixture.harness.getTask(failing, context))?.state.status === "terminal", 15_000);
    const failedConfirm = await confirmCompactionCycle(deps(), fixture.root.id, failing as TaskId, context);
    assert.equal(failedConfirm.status, "not-published", "a failed summary never switches the cycle");
    assert.equal((await fixture.root.context(context)).head?.id, headBeforeFailure?.id, "the old B/C are untouched");
    const declined = fixture.observations.filter((item) => item.outcome === "declined").at(-1);
    assert.ok(declined !== undefined, "the failure was observed");
    assert.equal(declined.errorCode, "model-failure");
    assert.equal(declined.attempts, 2, "both attempts ran before declining");
    const failureRecord = await readCompactionSummary(fixture.harness, fixture.root.id, declined.key, context);
    assert.equal(failureRecord?.status, "failed");
    assert.equal(failureRecord?.attempts, 2);
    assert.equal(failureRecord?.errorCode, "model-failure");
    const usageAfter = (await usageOf(fixture))[SUMMARY_USAGE_KEY]?.totalTokens ?? 0;
    assert.ok(usageAfter > usageBefore, "failed attempts are accounted under app/summary too");
  } finally {
    gate.resolve();
    await dispose(fixture);
  }
});

// 06-D (stale): a summary write overtaken by a reset settles unanswered/stale and confirms as
// not-published; the cycle stays with the reset (§12.3).
test("06-D: a reset-overtaken summary confirms not-published", { timeout: 90_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const fixture = await openFixture("memory-06d-stale-");
  try {
    fixture.registry.install(defineExtension({ name: "gate-tool", tools: [gatedTool(gate.promise)] }));
    fixture.faux.setResponses([fauxAssistantMessage("a ".repeat(300))]);
    await submitDone(fixture, "q1 ".repeat(120), "1");
    fixture.faux.appendResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("after tool"),
    ]);
    const busy = await fixture.root.submit({ type: "input", content: "q2 ".repeat(120), requestId: "2" }, context);
    await until(async () => (await fixture.harness.inspect(context)).tasks.some((task) => task.record.kind === "pi.tool" && task.state.kind === "running"));
    await fixture.root.reset(undefined, context);
    const manual = await fixture.root.compact(undefined, context);
    await until(async () => (await fixture.harness.getTask(manual, context))?.state.status === "terminal", 15_000);
    gate.resolve();
    assert.equal((await busy.wait(context)).status, "unanswered", "the reset withdraws the queued input");
    const submission = await summarySubmission(fixture, manual);
    assert.equal(submission?.status, "unanswered");
    assert.equal((submission as { reason?: string } | undefined)?.reason, "stale");
    const confirmation = await confirmCompactionCycle(
      createHarnessConfirmDeps(fixture.harness), fixture.root.id, manual as TaskId, context,
    );
    assert.equal(confirmation.status, "not-published");
    assert.match(confirmation.status === "not-published" ? confirmation.reason : "", /unanswered/);
    assert.equal((await fixture.root.context(context)).head?.kind, "pi.reset", "the stale summary did not switch the cycle");
  } finally {
    gate.resolve();
    await dispose(fixture);
  }
});

// 06-E: an incomplete narrative never publishes — a `length` stop, an over-budget narrative and
// a tool-call response all decline with the failure persisted, and the old context survives.
test("06-E: length, oversize and tool-call summaries are not published as B", { timeout: 120_000 }, async () => {
  const fixture = await openFixture("memory-06e-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    await updateWorking(fixture, {
      operationId: "tool:e0",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
    });
    fixture.faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("turn ".repeat(150))));

    // (1) stopReason "length": the narrative is truncated by definition, so it is incomplete.
    fixture.summaryFaux.setResponses([fauxAssistantMessage("partial ".repeat(100), { stopReason: "length" })]);
    await submitDone(fixture, "q1 ".repeat(150), "1");
    await submitDone(fixture, "q2 ".repeat(150), "2");
    assert.equal((await fixture.root.context(context)).head, undefined, "a length-truncated summary publishes no B");
    let declined = fixture.observations.filter((item) => item.outcome === "declined").at(-1);
    assert.ok(declined !== undefined && declined.errorCode === "model-failure" && declined.attempts === 1);
    let record = await readCompactionSummary(fixture.harness, fixture.root.id, declined.key, context);
    assert.equal(record?.status, "failed");
    assert.match(record?.errorMessage ?? "", /incomplete/);

    // (2) A narrative over the narrative token budget (3072 tokens at 3.5 chars/token) declines.
    fixture.summaryFaux.setResponses([fauxAssistantMessage("n".repeat(11_500))]);
    const manual1 = await fixture.root.compact(undefined, context);
    await until(async () => (await fixture.harness.getTask(manual1, context))?.state.status === "terminal", 15_000);
    assert.equal((await fixture.root.context(context)).head, undefined, "an over-budget narrative publishes no B");
    declined = fixture.observations.filter((item) => item.outcome === "declined").at(-1);
    assert.ok(declined !== undefined && declined.attempts === 1);
    record = await readCompactionSummary(fixture.harness, fixture.root.id, declined.key, context);
    assert.equal(record?.status, "failed");

    // (3) A summary that tries to call a tool is not a narrative.
    fixture.summaryFaux.setResponses([fauxAssistantMessage(fauxToolCall("working_read", {}), { stopReason: "toolUse" })]);
    const manual2 = await fixture.root.compact(undefined, context);
    await until(async () => (await fixture.harness.getTask(manual2, context))?.state.status === "terminal", 15_000);
    assert.equal((await fixture.root.context(context)).head, undefined, "a tool-calling summary publishes no B");
    // The working state itself was never touched by any of the declines.
    assert.equal((await readWorking(fixture.harness, fixture.root.id, context)).revision, 2);
  } finally {
    await dispose(fixture);
  }
});

// 06-E: exact state over its rendered bound declines — the baseline is never truncated or
// paraphrased into the narrative to make B fit.
test("06-E: oversize exact state declines instead of being summarized away", { timeout: 120_000 }, async () => {
  const fixture = await openFixture("memory-06e-state-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    const constraints = Array.from({ length: 16 }, (_, index) => `constraint ${index} ${"c".repeat(360)}`);
    const progress = Array.from({ length: 24 }, (_, index) => ({
      id: `step-${index}`,
      text: `step ${index} ${"p".repeat(360)}`,
      status: "in-progress" as const,
      evidence: [seed],
    }));
    await updateWorking(fixture, {
      operationId: "tool:e1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints, progress }) }],
    });
    await updateWorking(fixture, {
      operationId: "tool:e2",
      expectedRevision: 2,
      evidence: [seed],
      changes: Array.from({ length: 32 }, (_, index) => ({
        op: "preference.put" as const,
        preference: { id: `pref-${index}`, text: `preference ${index} ${"v".repeat(330)}`, scope: "global", source: seed, expiresAt: null },
      })),
    });
    fixture.faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("turn ".repeat(150))));
    await submitDone(fixture, "q1 ".repeat(150), "1");
    await submitDone(fixture, "q2 ".repeat(150), "2");
    await submitDone(fixture, "q3 ".repeat(150), "3");

    const view = await fixture.root.context(context);
    assert.notEqual(view.head?.kind, "pi.compaction", "no B is published when the exact state cannot be rendered");
    const declined = fixture.observations.filter((item) => item.outcome === "declined").at(-1);
    assert.ok(declined !== undefined, "the oversize decline was observed");
    assert.equal(declined.errorCode, "budget-exceeded");
    const record = await readCompactionSummary(fixture.harness, fixture.root.id, declined.key, context);
    assert.equal(record?.status, "failed");
    assert.equal(record?.errorCode, "budget-exceeded");
    // Nothing was silently dropped to make it fit: the stored state is byte-identical in shape.
    const state = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(state.preferences.length, 32);
    assert.equal(state.task.status === "active" ? state.task.constraints.length : 0, 16);
    // And the (successful) summary attempt was still accounted.
    assert.ok(((await usageOf(fixture))[SUMMARY_USAGE_KEY]?.totalTokens ?? 0) > 0);
  } finally {
    await dispose(fixture);
  }
});

// 06-E: a native (pre-adapter) summary is read through the compatibility path — no application
// snapshot, the whole body is narrative — and a later adapter compaction folds that narrative in
// instead of failing on the missing block.
test("06-E: a native summary is narrative-only for the adapter and folds into the next B", { timeout: 120_000 }, async () => {
  const fixture = await openFixture("memory-06e-native-", { withAdapter: false });
  try {
    // No adapter installed: the native summarizer runs on the agent model itself. Its request is
    // the one whose system messages carry no sections (as in test/memory-contract.test.ts).
    fixture.faux.setResponses(Array.from({ length: 10 }, () => (transcript: { messages: readonly Message[] }) => {
      const summarizer = transcript.messages.some(
        (message) => message.role === "system" && message.sections === undefined,
      );
      return summarizer
        ? fauxAssistantMessage("NATIVE NARRATIVE: the team decided to ship on Friday.")
        : fauxAssistantMessage("turn ".repeat(150));
    }));
    await submitDone(fixture, "q1 ".repeat(150), "1");
    await submitDone(fixture, "q2 ".repeat(150), "2");
    await submitDone(fixture, "q3 ".repeat(150), "3");
    await until(async () => (await fixture.root.context(context)).head?.kind === "pi.compaction");
    const nativeHead = (await fixture.root.context(context)).head!;
    assert.equal(publishedSnapshot(nativeHead), undefined, "a native summary carries no application snapshot");
    assert.match(summaryBodyOfEntry(nativeHead) ?? "", /NATIVE NARRATIVE: the team decided to ship on Friday\./);

    // Upgrade: install the adapter and compact again. The old head is narrative-only input now.
    // Capture the FIRST adapter snapshot: a later compaction would chain after it, which is a
    // different (also correct) statement than the one under test here.
    installAdapter(fixture);
    fixture.faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("turn ".repeat(150))));
    let snapshot: ReturnType<typeof publishedSnapshot>;
    await submitDone(fixture, "q4 ".repeat(150), "4");
    snapshot = publishedSnapshot((await fixture.root.context(context)).head!);
    if (snapshot === undefined) {
      await submitDone(fixture, "q5 ".repeat(150), "5");
      await until(async () => publishedSnapshot((await fixture.root.context(context)).head!) !== undefined);
      snapshot = publishedSnapshot((await fixture.root.context(context)).head!);
    }
    assert.ok(snapshot !== undefined, "the adapter published its own B over the native one");
    assert.equal(snapshot.sources?.after, null, "a native predecessor has no source range to chain from");
    assert.ok(
      fixture.summaryRequests.some((request) => request.includes("NATIVE NARRATIVE")),
      "the native narrative was folded into the adapter's summary source",
    );
  } finally {
    await dispose(fixture);
  }
});

// 06-F: completed user requests are counted once per requestId. Generation retries and tool
// calls do not call this API at all; a recovered request replays the SAME requestId, which the
// receipt makes a no-op — that is the whole retry-safety argument, exercised here directly.
test("06-F: twenty short requests evaluate at the twentieth; replays never recount", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-06f-");
  try {
    for (let index = 1; index <= 20; index += 1) {
      const result = await recordCompletedUserRequest(fixture.harness, fixture.root.id, `req-${index}`, context);
      assert.equal(result.completedUserTurns, index);
      assert.equal(result.shouldEvaluate, index === 20, `only the 20th request evaluates (got #${index})`);
    }
    // Replays of already-counted requests (recovery, redelivery) return the count unchanged.
    for (const replay of ["req-20", "req-7", "req-20"]) {
      const result = await recordCompletedUserRequest(fixture.harness, fixture.root.id, replay, context);
      assert.equal(result.completedUserTurns, 20, `replaying ${replay} must not recount`);
    }
    assert.equal(await readCompactionTurnCount(fixture.harness, fixture.root.id, context), 20);
    const twentyFirst = await recordCompletedUserRequest(fixture.harness, fixture.root.id, "req-21", context);
    assert.equal(twentyFirst.completedUserTurns, 21);
    assert.equal(twentyFirst.shouldEvaluate, false);
  } finally {
    await dispose(fixture);
  }
});

// 06-F: token pressure decides before rounds, and rounds alone never force a compaction.
test("06-F: evaluateCompaction is token-first and rounds only evaluate", () => {
  const budget: MemoryBudget = MEMORY_BUDGET_DEFAULTS;
  const window = 200_000;
  const reserve = 16_000;
  const { blocking, background } = compactionThresholds(window, reserve, budget);
  assert.equal(blocking, 184_000);
  assert.equal(background, 184_000 - 48 * 1024);
  const base = { contextWindow: window, reserveTokens: reserve, budget, completedUserTurns: 0, compactableTokens: 0 };
  // One large tool turn triggers on tokens alone — no waiting for the round count.
  assert.deepEqual(evaluateCompaction({ ...base, inputTokens: blocking }), { kind: "token", level: "blocking" });
  assert.deepEqual(evaluateCompaction({ ...base, inputTokens: background }), { kind: "token", level: "background" });
  assert.deepEqual(evaluateCompaction({ ...base, inputTokens: background - 1 }), { kind: "none" });
  // Twenty short requests: rounds evaluate, but with nothing compactable nothing is forced.
  assert.deepEqual(evaluateCompaction({ ...base, inputTokens: 500, completedUserTurns: 20 }), { kind: "none" });
  assert.deepEqual(
    evaluateCompaction({ ...base, inputTokens: 500, completedUserTurns: 20, compactableTokens: 4_000 }),
    { kind: "rounds" },
  );
  assert.deepEqual(
    evaluateCompaction({ ...base, inputTokens: 500, completedUserTurns: 19, compactableTokens: 4_000 }),
    { kind: "none" },
  );
});

// 06-F: the native policy is derived from the one budget, and impossible windows are refused.
test("06-F: nativeCompactionPolicy derives settings and validates the window", () => {
  assert.deepEqual(nativeCompactionPolicy(MEMORY_BUDGET_DEFAULTS, 16_000, 200_000), {
    enabled: true,
    reserveTokens: 16_000,
    keepRecentTokens: 16 * 1024,
    backgroundTokens: 48 * 1024,
  });
  // Without a window there is nothing to validate against; with one, the relations are checked.
  assert.deepEqual(nativeCompactionPolicy(MEMORY_BUDGET_DEFAULTS, 400), {
    enabled: true, reserveTokens: 400, keepRecentTokens: 16 * 1024, backgroundTokens: 48 * 1024,
  });
  assert.throws(
    () => nativeCompactionPolicy(MEMORY_BUDGET_DEFAULTS, 4_000, 10_000),
    (error: unknown) => error instanceof MemoryError && error.code === "budget-exceeded",
    "a 48Ki background target cannot fit a 6Ki blocking threshold",
  );
  assert.throws(
    () => nativeCompactionPolicy(MEMORY_BUDGET_DEFAULTS, 0),
    (error: unknown) => error instanceof MemoryError && error.code === "invalid-input",
  );
});

// 06-G: fingerprints are per-block and stable; loading a new tool schema is a prefix change in
// the `tools` block specifically.
test("06-G: prefix fingerprints isolate instructions, snapshot and tools", () => {
  const base = requestPrefixFingerprint({ instructionsText: "RULES", snapshotText: "B1", toolNames: ["read", "write"] });
  const same = requestPrefixFingerprint({ instructionsText: "RULES", snapshotText: "B1", toolNames: ["read", "write"] });
  assert.equal(base.digest, same.digest, "identical blocks fingerprint identically");
  assert.deepEqual(comparePrefix(base, same), { prefixChanged: false, changedBlocks: [] });

  const moreTools = requestPrefixFingerprint({ instructionsText: "RULES", snapshotText: "B1", toolNames: ["read", "write", "search"] });
  assert.deepEqual(comparePrefix(base, moreTools), { prefixChanged: true, changedBlocks: ["tools"] });
  const newSnapshot = requestPrefixFingerprint({ instructionsText: "RULES", snapshotText: "B2", toolNames: ["read", "write"] });
  assert.deepEqual(comparePrefix(base, newSnapshot), { prefixChanged: true, changedBlocks: ["snapshot"] });
  const newRules = requestPrefixFingerprint({ instructionsText: "RULES v2", snapshotText: "B1", toolNames: ["read", "write"] });
  assert.deepEqual(comparePrefix(base, newRules), { prefixChanged: true, changedBlocks: ["instructions"] });
});

// 06-G: within one cycle, adapted requests keep A and the tool declarations byte-stable while C
// only appends — the second request's messages extend the first one's as a prefix. (Logical
// block equality is asserted here; a provider cache HIT is a separate, unverified claim.)
test("06-G: adapted requests keep a stable prefix and append-only C within a cycle", { timeout: 60_000 }, async () => {
  const records: TranscriptRecord[] = [];
  const fixture = await openFixture("memory-06g-", {
    compaction: nativeCompactionPolicy(MEMORY_BUDGET_DEFAULTS, 16_000, 200_000),
    contextWindow: 200_000,
  });
  try {
    fixture.faux.setResponses([
      recorder(records, "first answer"),
      recorder(records, "second answer"),
    ]);
    await submitDone(fixture, "hello", "g1");
    await submitDone(fixture, "follow up", "g2");
    assert.equal(records.length, 2);
    const [first, second] = records as [TranscriptRecord, TranscriptRecord];
    const fingerprintOf = (record: TranscriptRecord) => requestPrefixFingerprint({
      instructionsText: sectionText(record.messages, "instructions") ?? "",
      snapshotText: "",
      toolNames: toolNamesOf(record.messages),
    });
    const firstPrint = fingerprintOf(first);
    const secondPrint = fingerprintOf(second);
    assert.match(sectionText(first.messages, "instructions") ?? "", /SYSTEM RULES/);
    assert.deepEqual(comparePrefix(firstPrint, secondPrint), { prefixChanged: false, changedBlocks: [] });
    // C only appends: the second request's conversation messages start with the first request's.
    const conversationOf = (record: TranscriptRecord) => record.messages.filter((message) => message.role !== "system");
    const firstConversation = conversationOf(first);
    const secondConversation = conversationOf(second);
    assert.ok(secondConversation.length > firstConversation.length, "the second request has more of C");
    assert.equal(
      JSON.stringify(secondConversation.slice(0, firstConversation.length)),
      JSON.stringify(firstConversation),
      "the earlier C is a byte-identical prefix of the later request",
    );
  } finally {
    await dispose(fixture);
  }
});

// The key derivation is part of the recovery contract: identical inputs reuse, a chained cycle
// does not. (Unit-level guard for the reuse rule exercised end-to-end in 06-A/06-D.)
test("06-D: deriveCompactionKey is stable per range and changes when the cycle chains", () => {
  const base = {
    conversationId: 1 as ConversationId,
    firstKept: 10 as EntryId,
    through: 9 as EntryId,
    anchor: 5 as EntryId,
    previousCycleId: null,
    previousThrough: null,
    facts: { instructionsDigest: null, memoryDigest: null },
    model: SUMMARY_MODEL,
    budget: MEMORY_BUDGET_DEFAULTS,
  };
  assert.equal(deriveCompactionKey(base), deriveCompactionKey(base));
  assert.notEqual(
    deriveCompactionKey(base),
    deriveCompactionKey({ ...base, previousCycleId: "cycle:1", previousThrough: 9 as EntryId }),
    "a compaction chaining after a published cycle must not reuse its snapshot",
  );
  assert.notEqual(deriveCompactionKey(base), deriveCompactionKey({ ...base, anchor: 6 as EntryId }));
});

// F-2 regression guard (found by the MEM-08 live run): a real summary model completed a
// month-and-day deadline with an invented year. The summary prompt must order date fidelity.
test("06-H: the summary prompt forbids inventing or completing dates", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /never invent or complete a missing year, month, or day/);
});
