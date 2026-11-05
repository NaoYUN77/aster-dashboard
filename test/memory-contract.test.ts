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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  assertSchema,
  baselineOf,
  CYCLE_BLOCK_CLOSE,
  CYCLE_BLOCK_OPEN,
  CycleSnapshotSchema,
  dailyFileName,
  decodeCycleSnapshot,
  encodeCycleSnapshot,
  eventDate,
  initialWorkingState,
  isEmptyRange,
  MEMORY_ERROR_CODES,
  MEMORY_ERROR_MAPPING,
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  rangeCovers,
  UNKNOWN_DATE,
  WorkingAnchorSchema,
  WorkingDoc,
  WorkingReceiptDoc,
  WorkingReceiptSchema,
  WorkingStateSchema,
  WorkingUpdateArgsSchema,
  workingAtBoundary,
  type CycleSnapshot,
  type WorkingReceipt,
  type WorkingState,
} from "../src/memory/contracts.js";

const context = BACKGROUND_CONTEXT;
const agent = { model: { provider: "faux", modelId: "faux-1" }, instructions: "SYSTEM RULES: be concise." };

// Context windows are small so threshold compaction is reachable with short fixtures.
const COMPACTION = { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 0 };
const BACKGROUND_COMPACTION = { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 200 };

type Fixture = {
  readonly directory: string;
  readonly faux: FauxProviderHandle;
  readonly harness: Harness;
  readonly root: Conversation;
};

async function openFixture(name: string, options: {
  readonly compaction?: typeof COMPACTION;
  readonly extensions?: (registry: ReturnType<typeof createRegistry>) => void;
} = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 1200, maxTokens: 512 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  options.extensions?.(registry);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
    models,
    registry,
    settings: { compaction: options.compaction ?? COMPACTION },
  }, context);
  const root = await harness.root(context, { agent });
  harness.resume();
  return { directory, faux, harness, root };
}

async function dispose(fixture: Fixture, close = true): Promise<void> {
  if (close) await fixture.harness.close(context).catch(() => {});
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

/** Poll a durable condition without guessing a fixed sleep. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
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

/** The system messages of one request, as the provider adapter receives them. */
type RequestRecord = { readonly index: number; readonly system: readonly Message[]; readonly tools: readonly string[]; readonly summarizer: boolean };

function recordRequests(records: RequestRecord[]): (transcript: { messages: readonly Message[] }) => ReturnType<typeof fauxAssistantMessage> {
  return (transcript) => {
    const system = transcript.messages.filter((message): message is Extract<Message, { role: "system" }> => message.role === "system");
    const tools = system.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
    // The summarizer's own request carries a plain instruction string and no prompt sections.
    const summarizer = system.length > 0 && system.every((message) => message.sections === undefined);
    records.push({ index: records.length, system, tools, summarizer });
    return fauxAssistantMessage(`answer ${records.length} `.repeat(60));
  };
}

function sectionText(system: readonly Message[], key: string): string | undefined {
  for (const message of system) {
    if (message.role !== "system" || message.sections === undefined) continue;
    const value = message.sections[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

async function addWorkingRevision(fixture: Fixture, revision: number): Promise<EntryRecord> {
  return fixture.harness.commit(async (tx) => {
    (await tx.doc(WorkingDoc, fixture.root.id)).revision = revision;
    return tx.appendEntry(fixture.root.id, {
      kind: "personal.working.anchor",
      data: { version: MEMORY_SCHEMA_VERSION, operationId: `op-${revision}`, revision, changed: true, completedEntryId: null },
    });
  }, context);
}

function compactionTasks(fixture: Fixture) {
  return fixture.harness.commit(
    async (tx) => (await tx.scanTasks({ conversationId: fixture.root.id, kind: "pi.compaction" }, 20)).items,
    context,
  );
}

function summarySubmission(fixture: Fixture, taskId: number) {
  return fixture.harness.commit(
    async (tx) => tx.submissionByRequest(fixture.root.id, `compaction:${taskId}`),
    context,
  );
}

// 01-A: every main-agent request carries a valid system prompt — first request, tool follow-up, and
// after a compaction has replaced the active context with a new head marker.
test("01-A: first, tool-follow-up and post-compaction requests carry the system prompt", { timeout: 60_000 }, async () => {
  const records: RequestRecord[] = [];
  const gate = Promise.withResolvers<void>();
  const fixture = await openFixture("memory-01a-", {
    extensions: (registry) => registry.install(defineExtension({ name: "probe", tools: [gatedTool(gate.promise)] })),
  });
  try {
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      recordRequests(records),
      recordRequests(records),
      recordRequests(records),
      recordRequests(records),
    ]);
    const first = await fixture.root.submit({ type: "input", content: "first ".repeat(120), requestId: "1" }, context);
    await until(async () => (await fixture.harness.inspect(context)).tasks.some((task) => task.record.kind === "pi.tool" && task.state.kind === "running"));
    gate.resolve();
    assert.equal((await first.wait(context)).status, "done");

    for (const index of [2, 3]) {
      const turn = await fixture.root.submit({ type: "input", content: `turn${index} `.repeat(120), requestId: String(index) }, context);
      assert.equal((await turn.wait(context)).status, "done");
    }
    const view = await fixture.root.context(context);
    assert.equal(view.head?.kind, "pi.compaction", "the long run must have compacted, so a later request follows a head marker");
    const main = records.filter((record) => !record.summarizer);
    assert.ok(main.length >= 3, "the first request, the tool follow-up and the post-compaction request were all recorded");
    assert.ok(records.some((record) => record.summarizer), "the summarizer uses its own dedicated system prompt");
    for (const record of main) {
      const instructions = sectionText(record.system, "instructions");
      assert.match(instructions ?? "", /SYSTEM RULES: be concise\./, `request ${record.index} has no rendered instructions`);
      assert.ok(record.tools.includes("probe_gate"), `request ${record.index} lost its tool declarations`);
    }
    // The post-compaction request is the one whose active range starts at the new marker.
    const after = await fixture.root.context(context);
    const marker = after.head!;
    assert.ok(marker.id > marker.head!, "the summary entry itself sits after the retained range");
    // A generation-owned (blocking) compaction appends directly and reports its entry id, not a submission.
    const [blocking] = await compactionTasks(fixture);
    assert.ok(blocking !== undefined);
    const outcome = (await fixture.harness.getTask(blocking.id, context))?.state;
    assert.equal(outcome?.status, "terminal");
    assert.deepEqual((outcome as { outcome?: unknown }).outcome, { status: "completed", result: { entryId: marker.id } });
  } finally {
    await dispose(fixture);
  }
});

// 01-B: the working state and its anchor entry commit together; `snapshotAsOf` returns the revision
// at that boundary even after later updates, including when the head marker's ID is later than the
// retained entries. A fork that does not cover the anchor is rejected, not answered with a default.
test("01-B: working state is anchored per commit and readable at the cut boundary", { timeout: 60_000 }, async () => {
  const cuts: number[] = [];
  const fixture = await openFixture("memory-01b-", {
    extensions: (registry) => registry.install(defineExtension({
      name: "probe",
      hooks: [hook(CompactionTask, {
        beforeCompact: async (compaction) => {
          cuts.push(compaction.firstKept);
          return { summary: `narrative at ${compaction.firstKept}` };
        },
      })],
    })),
  });
  try {
    fixture.faux.setResponses([fauxAssistantMessage("one ".repeat(150)), fauxAssistantMessage("two ".repeat(150)), fauxAssistantMessage("three ".repeat(150))]);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "q1 ".repeat(120), requestId: "1" }, context)).wait(context)).status, "done");
    const anchor1 = await addWorkingRevision(fixture, 1);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "q2 ".repeat(120), requestId: "2" }, context)).wait(context)).status, "done");
    assert.equal((await (await fixture.root.submit({ type: "input", content: "q3 ".repeat(120), requestId: "3" }, context)).wait(context)).status, "done");
    await until(async () => (await fixture.root.context(context)).head?.kind === "pi.compaction");

    const view = await fixture.root.context(context);
    const marker = view.head!;
    const firstKept = cuts[0]!;
    assert.equal(marker.head, firstKept, "the summary keeps entries from firstKept");
    assert.ok(marker.id > firstKept, "the head marker's own ID is later than the retained entries");
    assert.ok(anchor1.id < firstKept, "the boundary anchor predates the cut, so it is the state the summary replaces");

    // Same commit wrote the document and the anchor: reading at the anchor yields exactly revision 1.
    assert.equal((await workingAtBoundary(fixture.harness, fixture.root.id, anchor1.id, context)).revision, 1);

    // A later update must not leak into an earlier boundary read, and the marker read is the marker-time value.
    const anchor2 = await addWorkingRevision(fixture, 2);
    assert.equal((await workingAtBoundary(fixture.harness, fixture.root.id, anchor1.id, context)).revision, 1);
    assert.equal((await workingAtBoundary(fixture.harness, fixture.root.id, marker.id, context)).revision, 1);
    assert.equal((await workingAtBoundary(fixture.harness, fixture.root.id, anchor2.id, context)).revision, 2);

    // A fork at the anchor copies the state; a fork before it does not cover the anchor and is rejected.
    const forkAt = await fixture.root.fork(anchor1.id, { ownership: { kind: "ownerless" } }, context);
    assert.equal((await workingAtBoundary(fixture.harness, forkAt.id, anchor1.id, context)).revision, 1);
    const before = await fixture.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: fixture.root.id, maxEntryId: (anchor1.id - 1) as EntryRecord["id"], order: "descending" }, 1)).items[0]!,
      context,
    );
    const forkBefore = await fixture.root.fork(before.id, { ownership: { kind: "ownerless" } }, context);
    await assert.rejects(
      workingAtBoundary(fixture.harness, forkBefore.id, anchor1.id, context),
      (error: unknown) => error instanceof MemoryError && error.code === "not-covered",
    );
    // An as-of read before the first write is also an explicit rejection, never a default state.
    const earliest = await fixture.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: fixture.root.id, order: "ascending" }, 1)).items[0]!,
      context,
    );
    await assert.rejects(
      workingAtBoundary(fixture.harness, fixture.root.id, earliest.id, context),
      (error: unknown) => error instanceof MemoryError && error.code === "not-covered",
    );

    // A replay of one operation returns the stored receipt instead of a second write.
    const receipt: WorkingReceipt = assertSchema<WorkingReceipt>(WorkingReceiptSchema, {
      version: MEMORY_SCHEMA_VERSION,
      operationId: "op-1",
      conversationId: fixture.root.id,
      expectedRevision: 1,
      previousRevision: 1,
      revision: 1,
      changed: true,
      changes: [],
      anchorEntryId: anchor1.id,
      completedEntryId: null,
      at: 1,
    }, "invalid-input");
    const replay = await fixture.harness.commit(async (tx) => {
      const stored = await tx.doc(WorkingReceiptDoc, fixture.root.id, "op-1", receipt);
      return { revision: (await tx.doc(WorkingDoc, fixture.root.id)).revision, receipt: { ...stored } };
    }, context);
    assert.equal(replay.receipt.operationId, "op-1");
    assert.equal(replay.revision, 2, "a replay reads the stored receipt and does not touch the document");
  } finally {
    await dispose(fixture);
  }
});

// 01-C: a queued summary does not switch the application cycle; only formal publication does, a
// stale write does not, and a restart still finds the published summary.
test("01-C: publication, stale and restart re-scan drive the cycle switch", { timeout: 90_000 }, async () => {
  const cuts: number[] = [];
  const gate = Promise.withResolvers<void>();
  const fixture = await openFixture("memory-01c-", {
    compaction: BACKGROUND_COMPACTION,
    extensions: (registry) => registry.install(defineExtension({
      name: "probe",
      tools: [gatedTool(gate.promise)],
      hooks: [hook(CompactionTask, {
        beforeCompact: async (compaction) => {
          cuts.push(compaction.firstKept);
          return { summary: `background ${compaction.firstKept}` };
        },
      })],
    })),
  });
  let open = true;
  try {
    fixture.faux.setResponses([fauxAssistantMessage("seed ".repeat(200))]);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "q1 ".repeat(150), requestId: "1" }, context)).wait(context)).status, "done");
    const beforeCycle = await fixture.root.context(context);
    assert.equal(beforeCycle.head, undefined, "no cycle boundary exists before the first compaction");

    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("after gate"),
    ]);
    const run = await fixture.root.submit({ type: "input", content: "q2 ".repeat(150), requestId: "2" }, context);
    // The background compaction summarizes while the run is busy and queues its write.
    await until(async () => (await compactionTasks(fixture)).some((task) => task.state.status === "terminal"), 10_000);
    const [task] = await compactionTasks(fixture);
    assert.ok(task !== undefined);
    const queued = await summarySubmission(fixture, task.id);
    assert.equal(queued?.type, "write");
    assert.equal(queued?.status, "queued", "the summary is enqueued, not published, while the run is busy");
    assert.equal((await fixture.root.context(context)).head, undefined, "enqueue alone must not switch the cycle");

    gate.resolve();
    assert.equal((await run.wait(context)).status, "done");
    await until(async () => (await summarySubmission(fixture, task.id))?.status === "done");
    const published = await fixture.root.context(context);
    assert.equal(published.head?.kind, "pi.compaction", "formal publication places a new head marker");
    assert.equal(published.head?.head, cuts[0], "the marker's head is the first kept entry");
    const settled = await fixture.harness.getTask(task.id, context);
    assert.equal(settled?.state.status, "terminal");
    assert.deepEqual(settled?.state.outcome, { status: "completed", result: { submissionId: queued?.id } });

    // A restart re-scans: the published summary and its receipt are still observable.
    const convId = fixture.root.id;
    await fixture.harness.close(context);
    open = false;
    const reopened = await Harness.open(await openNodeSqliteStorage(join(fixture.directory, "agent.sqlite")), {
      models: (() => { const models = createModels(); models.setProvider(fixture.faux.provider); return models; })(),
      registry: createRegistry(),
    }, context);
    try {
      const root = await reopened.root(context);
      const view = await root.context(context);
      assert.equal(view.head?.kind, "pi.compaction");
      assert.equal(view.head?.head, cuts[0]);
      const rescan = await reopened.commit(async (tx) => tx.submissionByRequest(convId, `compaction:${task.id}`), context);
      assert.equal(rescan?.status, "done");
      assert.equal((await reopened.getTask(task.id, context))?.state.status, "terminal");
    } finally {
      await reopened.close(context);
    }
  } finally {
    gate.resolve();
    await dispose(fixture, open);
  }
});

test("01-C: a summary write overtaken by a reset settles stale and keeps the cycle", { timeout: 60_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const fixture = await openFixture("memory-01c-stale-", {
    extensions: (registry) => registry.install(defineExtension({
      name: "probe",
      tools: [gatedTool(gate.promise)],
      hooks: [hook(CompactionTask, { beforeCompact: async (compaction) => ({ summary: `stale ${compaction.firstKept}` }) })],
    })),
  });
  try {
    fixture.faux.setResponses([fauxAssistantMessage("a ".repeat(300))]);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "q1 ".repeat(120), requestId: "1" }, context)).wait(context)).status, "done");
    fixture.faux.appendResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("after tool"),
    ]);
    const busy = await fixture.root.submit({ type: "input", content: "q2 ".repeat(120), requestId: "2" }, context);
    await until(async () => (await fixture.harness.inspect(context)).tasks.some((task) => task.record.kind === "pi.tool" && task.state.kind === "running"));
    // The reset ends the current context; the manual summary then queues behind it.
    await fixture.root.reset(undefined, context);
    const manual = await fixture.root.compact(undefined, context);
    await until(async () => (await fixture.harness.getTask(manual, context))?.state.status === "terminal");
    const queued = await summarySubmission(fixture, manual);
    assert.equal(queued?.status, "queued", "the summary waits for a boundary instead of being appended mid-run");
    gate.resolve();
    assert.equal((await busy.wait(context)).status, "unanswered", "the reset withdraws the queued input");
    const submission = await summarySubmission(fixture, manual);
    assert.equal(submission?.status, "unanswered");
    assert.equal((submission as { reason?: string } | undefined)?.reason, "stale");
    const view = await fixture.root.context(context);
    assert.equal(view.head?.kind, "pi.reset", "a stale summary does not publish and does not switch the cycle");
  } finally {
    gate.resolve();
    await dispose(fixture);
  }
});

// 01-D: a display-only write lands mid-run without entering model context; a context-affecting write
// queues instead. Everything goes through public admission, not an internal append.
test("01-D: display-only writes bypass the busy queue, model writes queue", { timeout: 60_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const fixture = await openFixture("memory-01d-", {
    extensions: (registry) => registry.install(defineExtension({ name: "probe", tools: [gatedTool(gate.promise)] })),
  });
  try {
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("after gate"),
    ]);
    const run = await fixture.root.submit({ type: "input", content: "start ".repeat(100), requestId: "1" }, context);
    await until(async () => (await fixture.harness.inspect(context)).tasks.some((task) => task.state.kind === "running" && task.record.kind === "pi.tool"));

    const display = await fixture.root.submit({ type: "write", entry: { kind: "personal.display", data: { from: "host" } }, requestId: "display-1" }, context);
    assert.equal((await display.status(context)).status, "done", "a display-only write is appended at once, even mid-run");
    const note: Message = { role: "user", content: [{ type: "text", text: "queued note" }], timestamp: 1 };
    const modelWrite = await fixture.root.submit({ type: "write", entry: { kind: "personal.note", model: [note] }, requestId: "note-1" }, context);
    assert.equal((await modelWrite.status(context)).status, "queued", "a model-affecting write waits for a boundary");

    const mid = await fixture.root.context(context);
    const index = mid.entries.findIndex((entry) => entry.kind === "personal.display");
    assert.ok(index >= 0, "the display entry is in the transcript");
    assert.equal(mid.contributions[index]?.length, 0, "it contributes no model messages");
    assert.ok(!mid.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("queued note")));

    gate.resolve();
    assert.equal((await run.wait(context)).status, "done");
    await until(async () => (await modelWrite.status(context)).status === "done");
    const after = await fixture.root.context(context);
    assert.ok(after.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("queued note")));
  } finally {
    gate.resolve();
    await dispose(fixture);
  }
});

// 01-E: a custom summary/extraction call is attributed explicitly, survives failure and retry
// without double counting, and its cancellation signal reaches the provider.
test("01-E: custom summary usage is attributed, retried, and cancellable", { timeout: 90_000 }, async () => {
  const summaryFaux = fauxProvider({ provider: "summary", models: [{ id: "summary-1" }] });
  const models = createModels();
  const fixtureFaux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 1200, maxTokens: 512 }] });
  models.setProvider(fixtureFaux.provider);
  models.setProvider(summaryFaux.provider);
  const directory = await mkdtemp(join(tmpdir(), "memory-01e-"));
  const attempts: string[] = [];
  const registry = createRegistry();
  let harness: Harness | undefined;
  registry.install(defineExtension({
    name: "probe",
    hooks: [hook(CompactionTask, {
      beforeCompact: async (compaction, api, ctx) => {
        // A failed attempt, then a retry: both are real model I/O and both spend tokens.
        for (const attempt of [1, 2]) {
          const model = models.getModel("summary", "summary-1")!;
          const message = await models.completeSimple(model, {
            messages: [{ role: "user", content: `summarize ${compaction.firstKept} attempt ${attempt}`, timestamp: 1 }],
          }, { signal: ctx.abortSignal, cacheRetention: "none" });
          attempts.push(message.stopReason);
          await harness!.commit(async (tx) => {
            const bucket = (await tx.doc(UsageDoc, api.conversationId)).models;
            const key = "app/summary";
            const total = bucket[key] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
            for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += message.usage[field];
            for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += message.usage.cost[field];
            bucket[key] = total;
          }, ctx);
        }
        return { summary: `custom ${compaction.firstKept}` };
      },
    })],
  }));
  try {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
      models, registry, settings: { compaction: COMPACTION },
    }, context);
    const root = await harness.root(context, { agent });
    harness.resume();
    summaryFaux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }),
      fauxAssistantMessage("summary text"),
    ]);
    fixtureFaux.setResponses([fauxAssistantMessage("one ".repeat(150)), fauxAssistantMessage("two ".repeat(150)), fauxAssistantMessage("three ".repeat(150))]);
    for (const index of [1, 2, 3]) {
      assert.equal((await (await root.submit({ type: "input", content: `q${index} `.repeat(120), requestId: String(index) }, context)).wait(context)).status, "done");
    }
    await until(async () => (await root.context(context)).head?.kind === "pi.compaction");
    assert.deepEqual(attempts, ["error", "stop"], "the adapter sees the failure and its retry");
    const usage = (await harness.snapshot(UsageDoc, root.id, context))!.models;
    assert.ok(usage["app/summary"] !== undefined, "the app-owned call is attributed to its own bucket");
    assert.ok(usage["app/summary"]!.totalTokens > 0);
    assert.equal(usage["summary/summary-1"], undefined, "the SDK recorded nothing for the hook-owned call, so nothing is counted twice");
    assert.ok(usage["faux/faux-1"] !== undefined, "generation usage keeps its native attribution");

    // Cancellation reaches the provider: the abort signal of the task ends the real call.
    const cancelFaux = fauxProvider({ provider: "cancel", models: [{ id: "cancel-1" }] });
    models.setProvider(cancelFaux.provider);
    const cancelStops: string[] = [];
    // Resolved by the hook invocation that runs while the flag is set: the manual compaction under test.
    const started = Promise.withResolvers<void>();
    let slow = false;
    cancelFaux.setResponses(Array.from({ length: 8 }, () => (_transcript, options) => (slow
      ? new Promise((resolve) => {
        // Answer only on abort or timeout, so the signal is what ends this call.
        const timer = setTimeout(() => resolve(fauxAssistantMessage("late")), 5_000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(fauxAssistantMessage("late"));
        }, { once: true });
      })
      : fauxAssistantMessage("quick"))));
    const cancelRegistry = createRegistry();
    cancelRegistry.install(defineExtension({
      name: "probe",
      hooks: [hook(CompactionTask, {
        beforeCompact: async (_compaction, _api, ctx) => {
          const model = models.getModel("cancel", "cancel-1")!;
          if (slow) started.resolve();
          const message = await models.completeSimple(model, {
            messages: [{ role: "user", content: "slow", timestamp: 1 }],
          }, { signal: ctx.abortSignal });
          cancelStops.push(message.stopReason);
          return { decline: true };
        },
      })],
    }));
    const cancelHarness = await Harness.open(await openNodeSqliteStorage(join(directory, "cancel.sqlite")), {
      models, registry: cancelRegistry, settings: { compaction: COMPACTION },
    }, context);
    try {
      const root = await cancelHarness.root(context, { agent });
      cancelHarness.resume();
      fixtureFaux.setResponses([fauxAssistantMessage("x ".repeat(400)), fauxAssistantMessage("y ".repeat(400)), fauxAssistantMessage("z ".repeat(400))]);
      for (const index of [1, 2, 3]) {
        await (await root.submit({ type: "input", content: `long${index} `.repeat(200), requestId: `c${index}` }, context)).wait(context);
      }
      // Only the compaction under test gets a slow response, so the abort signal is what ends the call.
      slow = true;
      const manual = await root.compact(undefined, context);
      // Abort while the hook's model call is in flight, not before the phase starts.
      await started.promise;
      assert.equal(await cancelHarness.abortTask(manual, context), "marked");
      const settled = await cancelHarness.waitForTask(manual, context);
      assert.equal(settled.state.status, "terminal");
      assert.ok(cancelStops.includes("aborted"), `the task signal reached the provider call: ${cancelStops.join(",")}`);
      assert.equal(settled.state.outcome?.status, "aborted", "the task committed its abort terminal state");
    } finally {
      await cancelHarness.close(context);
    }
  } finally {
    await harness?.close(context).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// The integration order MEM-06 and MEM-07 must follow: first B at an idle boundary, post-reset B
// queued behind the reset, and a long-run compaction publishing B through the native summary.
test("integration order: first B, post-reset B and long-run compaction", { timeout: 90_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const fixture = await openFixture("memory-order-", {
    extensions: (registry) => registry.install(defineExtension({ name: "probe", tools: [gatedTool(gate.promise)] })),
  });
  const snapshot = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
  try {
    // The actual request bodies, so ordering is asserted on what the model receives.
    const requests: Message[][] = [];
    const record = (transcript: { messages: readonly Message[] }) => {
      requests.push([...transcript.messages]);
      return fauxAssistantMessage("ok ".repeat(60));
    };
    fixture.faux.setResponses([record, record, record, record, record]);

    // First B: at an idle boundary the projection is a context-affecting write that settles at once.
    const firstB = await fixture.root.submit({ type: "write", entry: { kind: "personal.cycle", model: [snapshot("<cycle-snapshot>B1</cycle-snapshot>")] }, requestId: "cycle-1" }, context);
    assert.equal((await firstB.status(context)).status, "done", "an idle write is appended before the user input that follows it");
    assert.equal((await (await fixture.root.submit({ type: "input", content: "hello", requestId: "1" }, context)).wait(context)).status, "done");
    const firstRequest = requests[0]!.filter((message) => message.role === "user");
    assert.equal(firstRequest.length, 2, "the request carries B and the user input");
    assert.ok(JSON.stringify(firstRequest[0]).includes("B1"), "B precedes the user input in the first request");

    // Post-reset B: the reset is admitted while busy and the projection queues behind it.
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_gate", {}), { stopReason: "toolUse" }),
      record,
    ]);
    const busy = await fixture.root.submit({ type: "input", content: "busy", requestId: "2" }, context);
    await until(async () => (await fixture.harness.inspect(context)).tasks.some((task) => task.record.kind === "pi.tool" && task.state.kind === "running"));
    await fixture.root.reset("handoff", context);
    const secondB = await fixture.root.submit({ type: "write", entry: { kind: "personal.cycle", model: [snapshot("<cycle-snapshot>B2</cycle-snapshot>")] }, requestId: "cycle-2" }, context);
    assert.equal((await secondB.status(context)).status, "queued", "the post-reset projection waits for the reset to land");
    gate.resolve();
    assert.equal((await busy.wait(context)).status, "unanswered", "the reset withdraws the run's queued input");
    assert.equal((await secondB.status(context)).status, "done");
    const afterReset = await fixture.root.context(context);
    assert.equal(afterReset.head?.kind, "pi.reset");
    const resetUsers = afterReset.messages.filter((message) => message.role === "user");
    assert.equal(resetUsers.length, 2, "the new cycle starts with the handoff text and B");
    assert.ok(JSON.stringify(resetUsers[1]).includes("B2"));
    assert.ok(!JSON.stringify(afterReset.messages).includes("B1"), "the previous cycle's B is no longer in context");

    // Long-run compaction: the native summary publishes B at the next head, keeping the retained C.
    fixture.faux.setResponses([fauxAssistantMessage("summary of the first cycle"), record]);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "after reset ".repeat(600), requestId: "3" }, context)).wait(context)).status, "done");
    const compacted = await fixture.root.context(context);
    assert.equal(compacted.head?.kind, "pi.compaction", "the run compacted under the threshold policy");
    assert.ok(compacted.entries.length >= 2);
    assert.equal(compacted.entries[0]?.id, compacted.head?.id, "the head marker is the first active entry");
    assert.ok(compacted.entries.slice(1).every((entry) => entry.id >= compacted.head!.head!), "retained entries start at firstKept");
    // The request the model actually received after the cut starts from the published summary.
    const postCompaction = requests.at(-1)!;
    assert.ok(JSON.stringify(postCompaction).includes("summary of the first cycle"), "the post-compaction request carries the new B");
  } finally {
    gate.resolve();
    await dispose(fixture);
  }
});

// 01-F: compatibility and the frozen Interface — versioned formats, explicit errors, range and
// calendar rules, and one place that maps business errors to application errors.
test("01-F: frozen formats, ranges, calendar rules and error mapping", () => {
  const working = initialWorkingState();
  assertSchema<WorkingState>(WorkingStateSchema, working, "invalid-input");
  assert.throws(() => assertSchema(WorkingStateSchema, { ...working, revision: 0 }, "invalid-input"), (error: unknown) => error instanceof MemoryError && error.code === "invalid-input");
  assert.throws(() => assertSchema(WorkingStateSchema, { ...working, extra: true }, "invalid-input"), MemoryError);
  assert.throws(() => assertSchema(WorkingStateSchema, { ...working, revision: undefined }, "invalid-input"), MemoryError);
  assert.throws(() => assertSchema(WorkingUpdateArgsSchema, { expectedRevision: 1, changes: [] }, "invalid-input"), MemoryError);
  assert.throws(() => assertSchema(WorkingAnchorSchema, { version: 1, operationId: "bad id", revision: 1, changed: true, completedEntryId: null }, "invalid-input"), MemoryError);
  assert.throws(() => assertSchema(WorkingAnchorSchema, { version: 1, operationId: "op", revision: 1, changed: true }, "invalid-input"), MemoryError, "an omitted field is not a null");

  // Range semantics: (after, through] with an inclusive upper bound and an open lower bound.
  const id = (value: number) => value as EntryId;
  const conversationId = 1 as ConversationId;
  const range = { conversationId, after: id(10), through: id(20) };
  assert.equal(isEmptyRange({ ...range, after: id(20) }), true);
  assert.equal(rangeCovers(range, id(10)), false);
  assert.equal(rangeCovers(range, id(11)), true);
  assert.equal(rangeCovers(range, id(20)), true);
  assert.equal(rangeCovers(range, id(21)), false);
  assert.equal(isEmptyRange({ ...range, after: null }), false);

  // The baseline is a boundary projection of the state: no `updatedAt`, because a rendered snapshot
  // must not carry the time of a write.
  const snapshot: CycleSnapshot = {
    version: MEMORY_SCHEMA_VERSION,
    cycleId: "cycle-1",
    narrative: "Goal: ship the fix.",
    baseline: baselineOf({ ...working, revision: 3, task: { status: "active", goal: "ship", scope: null, constraints: ["no deps"], progress: [], blockers: [], nextStep: "test", notes: null, sources: [{ conversationId, entryId: id(7) }] } }),
    boundary: { kind: "compaction", firstKept: id(12), anchor: id(9) },
    sources: { conversationId, after: id(3), through: id(12) },
    facts: { instructionsDigest: null, memoryDigest: "abc" },
  };
  const encoded = encodeCycleSnapshot(snapshot);
  assert.ok(encoded.includes(CYCLE_BLOCK_OPEN) && encoded.includes(CYCLE_BLOCK_CLOSE));
  assert.equal(encodeCycleSnapshot(snapshot), encoded, "encoding is deterministic");
  assert.deepEqual(decodeCycleSnapshot(encoded), snapshot, "round-trip preserves the structured half");
  assert.equal(decodeCycleSnapshot("A native summary with no application block."), undefined, "an old or native summary decodes as narrative-only");
  assert.throws(
    () => decodeCycleSnapshot(`${CYCLE_BLOCK_OPEN}\n{"version":99}\n${CYCLE_BLOCK_CLOSE}`),
    (error: unknown) => error instanceof MemoryError && error.code === "unsupported-version",
  );
  assert.throws(
    () => decodeCycleSnapshot(`${CYCLE_BLOCK_OPEN}\nnot json\n${CYCLE_BLOCK_CLOSE}`),
    (error: unknown) => error instanceof MemoryError && error.code === "corrupt-state",
  );
  assert.throws(
    () => decodeCycleSnapshot(`${CYCLE_BLOCK_OPEN}\n${JSON.stringify({ version: 1, cycleId: "c" })}\n${CYCLE_BLOCK_CLOSE}`),
    (error: unknown) => error instanceof MemoryError && error.code === "corrupt-state",
  );

  // File naming and event dates: the event date, not the publish date, decides the file.
  assert.equal(dailyFileName("2026-10-25"), "2026-10-25.md");
  assert.equal(dailyFileName("2026-10-25", 2), "2026-10-25-2.md");
  assert.equal(dailyFileName(UNKNOWN_DATE), "unknown.md");
  assert.throws(() => dailyFileName("2026-13-01"), MemoryError);
  assert.throws(() => dailyFileName("2026-10-25", 0), MemoryError);
  assert.throws(() => dailyFileName("2026-10-25", 10), MemoryError);
  const midnight = Date.parse("2026-10-25T23:30:00Z");
  assert.equal(eventDate(midnight, "UTC"), "2026-10-25");
  assert.equal(eventDate(midnight, "Asia/Shanghai"), "2026-10-26");
  assert.equal(eventDate(undefined, "UTC"), UNKNOWN_DATE);
  assert.throws(() => eventDate(midnight, "Not/AZone"), MemoryError);

  // Every business error has one application mapping and none is a Session failure.
  for (const code of MEMORY_ERROR_CODES) {
    const mapping = MEMORY_ERROR_MAPPING[code];
    assert.ok(mapping.appCode.startsWith("MEMORY_"), `${code} has no application code`);
    assert.notEqual(mapping.appCode, "AGENT_SESSION_FAILED");
  }
  assert.equal(new MemoryError("revision-conflict", "stale revision").appCode, "MEMORY_REVISION_CONFLICT");
  assert.equal(new MemoryError("stale", "write overtaken").appCode, "MEMORY_STALE");
  assertSchema(CycleSnapshotSchema, snapshot, "invalid-input");
});
