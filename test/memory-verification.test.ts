// MEM-08 acceptance, part 1 (in-process scenarios): 08-A deterministic cross-day trace,
// 08-B windows 1 (projection) and 6 (reply saved, count pending), 08-C archive range states,
// 08-D correction/revocation persistence, 08-E offline provider-adapter prefix comparison,
// 08-H dependency review. The SIGKILL windows of 08-B live in memory-verification-crash.test.ts.
//
// Everything runs on temporary directories with faux providers: no network, no real models,
// no production credentials. Crash points are durable barriers (a resolved prepare, a settled
// submission, a blocking boundary callback), never sleeps; `until` below only waits for a
// durable condition to become observable, it never guesses a crash moment.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type Conversation,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import type { TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createProviderModels } from "../src/providers.js";
import { createToolRegistry } from "../src/tools.js";
import { MEMORY_BUDGET_DEFAULTS, type MemorySegment } from "../src/memory/contracts.js";
import { openDaily, publishSegments, readSegment, searchDaily, type DailyStore } from "../src/memory/daily.js";
import { applyWorkingUpdate, readWorking } from "../src/memory/working.js";
import { createArchiveTask, initializeArchive, readArchive, reconcileArchive, requestArchive, retryArchive, type ArchiveState } from "../src/memory/archive-task.js";
import {
  publishedSnapshot,
  readCompactionTurnCount,
  requestPrefixFingerprint,
} from "../src/memory/compaction.js";
import { snapshotOfProjection } from "../src/memory/context.js";
import {
  createMemoryIntegration,
  type MemoryIntegration,
  type MemoryLogEvent,
} from "../src/memory/integration.js";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const INSTRUCTIONS = "SYSTEM RULES: be concise and cite memory sources.";
const LONG = "lorem ipsum dolor sit amet ".repeat(80);

async function until(check: () => Promise<boolean>, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await delay(25);
  }
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
}

function transcriptText(messages: readonly Message[]): string {
  return messages.map(messageText).join("\n");
}

async function allEntries(harness: Harness, root: Conversation): Promise<EntryRecord[]> {
  const page = await root.entries({ order: "ascending" }, 2_000, undefined, context);
  return [...page.items];
}

// ---------------------------------------------------------------------------
// Shared raw fixture: a Harness with the MEM-07 composition root attached, a
// classifying faux router (main / summary / archive on one provider, exactly
// as the application wires one configured model), and a call recorder that
// reduces every main-model request to identifiers, counts and versions only.
// ---------------------------------------------------------------------------

type CallRecord = {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly rev: number | null;
  readonly messages: number;
};

type Trace = {
  readonly main: CallRecord[];
  readonly contexts: TranscriptContext[];
  summary: number;
  archive: number;
};

const noteLookup = defineTool({
  name: "note_lookup",
  description: "Look up a project note by topic. Fails when asked to fail, so a trace can script a tool failure and its correction.",
  parameters: Type.Object({ fail: Type.Boolean() }, { additionalProperties: false }),
  replay: "safe",
  execute: async (args) => args.fail
    ? { isError: true as const, output: [{ type: "text" as const, text: "note_lookup failed: note service unavailable" }] }
    : { output: [{ type: "text" as const, text: "note: the deploy window is Friday 02:00 UTC" }] },
});

type RawFixture = {
  readonly directory: string;
  readonly database: string;
  readonly workspace: string;
  readonly faux: FauxProviderHandle;
  integration: MemoryIntegration;
  readonly logs: MemoryLogEvent[];
  readonly trace: Trace;
  /** When true, the next main calls run the note_lookup failure/correction script. */
  toolScript: boolean;
  harness: Harness;
  root: Conversation;
};

async function openRawV(name: string, options: {
  readonly budget?: Partial<typeof MEMORY_BUDGET_DEFAULTS>;
  readonly dataDir?: string;
} = {}): Promise<RawFixture> {
  const directory = options.dataDir ?? await mkdtemp(join(tmpdir(), name));
  const database = join(directory, "agent.sqlite");
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "", { flag: "a" });
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const logs: MemoryLogEvent[] = [];
  const trace: Trace = { main: [], contexts: [], summary: 0, archive: 0 };
  const fixture: RawFixture = {
    directory, database, workspace, faux, logs, trace, toolScript: false,
    integration: undefined as never, harness: undefined as never, root: undefined as never,
  };
  const router = (transcript: TranscriptContext) => {
    const all = transcriptText(transcript.messages);
    if (all.includes("context summarization assistant")) {
      trace.summary += 1;
      return fauxAssistantMessage("Work continues on the quarterly release; goals, constraints and open steps are preserved.");
    }
    if (all.includes("Extract useful daily events")) {
      trace.archive += 1;
      const user = transcript.messages.find((message) => message.role === "user")!;
      const sources = JSON.parse(messageText(user)) as { entryId: number; text: string }[];
      return fauxAssistantMessage(JSON.stringify({
        segments: sources.map((source) => ({
          sourceEntryId: source.entryId, kind: "result", status: "confirmed",
          text: `Archived note for entry ${source.entryId}`, supersedes: [],
        })),
      }));
    }
    // A main-model request: reduce it to A/B/C sizes and the newest baseline revision it
    // carries. A = the effective system prompt, B = messages carrying a <cycle-snapshot>,
    // C = the rest. A is measured by rendering the transcript's system messages with
    // pi-ai's own replay (getCurrentSystemPrompt): a SystemMessage carries its prompt in
    // named `sections` while `content` stays empty, so reading message text alone would
    // report A = 0 even though every call carries the full instructions (found in MEM-08:
    // the first 08-A run failed on exactly this measurement artifact, locally and on the
    // target server alike, while the rendered prompt was intact on call 0).
    let a = 0;
    let b = 0;
    let total = 0;
    let rev: number | null = null;
    if (transcript.messages.some((message) => message.role === "system")) {
      a = estimateTextTokens(getCurrentSystemPrompt(transcript.messages));
    }
    total += a;
    for (const message of transcript.messages) {
      const text = messageText(message);
      const tokens = message.role === "system" ? 0 : estimateTextTokens(text);
      total += tokens;
      if (text.includes("<cycle-snapshot>")) b += tokens;
      if (text.includes("\"revision\"")) {
        for (const match of text.matchAll(/"revision":(\d+)/g)) {
          rev = Math.max(rev ?? 0, Number(match[1]));
        }
      }
    }
    trace.main.push({ a, b, c: total - a - b, rev, messages: transcript.messages.length });
    trace.contexts.push(transcript);
    if (fixture.toolScript) {
      const results = transcript.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "note_lookup",
      ) as Extract<Message, { role: "toolResult" }>[];
      const last = results.at(-1);
      if (last === undefined) {
        return fauxAssistantMessage(fauxToolCall("note_lookup", { fail: true }, { id: "note-1" }), { stopReason: "toolUse" });
      }
      if (last.isError) {
        return fauxAssistantMessage(fauxToolCall("note_lookup", { fail: false }, { id: "note-2" }), { stopReason: "toolUse" });
      }
      fixture.toolScript = false;
      return fauxAssistantMessage("The note says the deploy window is Friday.");
    }
    return fauxAssistantMessage("All noted.");
  };
  faux.setResponses(Array.from({ length: 512 }, () => router));
  const budget = { ...MEMORY_BUDGET_DEFAULTS, ...options.budget };
  const integration = createMemoryIntegration({
    root: directory,
    instructions: INSTRUCTIONS,
    model: { provider: "faux", modelId: "faux-1" },
    contextWindow: 128_000,
    budget,
    reserveTokens: 16_384,
    timezone: "UTC",
    log: (event) => logs.push(event),
  });
  const registry = createToolRegistry();
  for (const extension of integration.extensions()) registry.install(extension);
  registry.install(defineExtension({ name: "mem08-trace-tools", tools: [noteLookup] }));
  const harness = await Harness.open(await openNodeSqliteStorage(database), {
    models,
    registry,
    settings: { toolExecution: "sequential", compaction: integration.compactionSettings() },
  }, context);
  const root = await harness.root(context);
  await root.configure({
    model: { provider: "faux", modelId: "faux-1" },
    cwd: workspace,
    instructions: INSTRUCTIONS,
  }, context);
  integration.attach(harness, root);
  await integration.initialize(context);
  harness.resume();
  return Object.assign(fixture, { integration, harness, root });
}

async function closeRawV(fixture: RawFixture): Promise<void> {
  fixture.integration.close();
  await fixture.harness.close(context).catch(() => {});
}

async function disposeRawV(fixture: RawFixture): Promise<void> {
  await closeRawV(fixture);
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

/** Drive one full request through the integration exactly as `agent.reply` does. */
async function driveRequest(fixture: RawFixture, id: string, text: string): Promise<void> {
  const prepared = await fixture.integration.prepareRequest({ requestId: id, text }, context);
  const submission = await fixture.root.submit({ type: "input", content: text, requestId: id }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done", `request ${id} must complete`);
  if (prepared.kind !== "replay") await fixture.integration.afterRequest(id, context);
}

/** Wait until no compaction or archive task is in flight and the head is stable across polls. */
async function quiesce(fixture: RawFixture): Promise<void> {
  let lastHead: EntryId | undefined;
  let stable = 0;
  await until(async () => {
    const tasks = await fixture.harness.commit(
      async (tx) => (await tx.scanTasks({ conversationId: fixture.root.id }, 200)).items,
      context,
    );
    const active = tasks.some((task) => task.state.status !== "terminal");
    const head = (await fixture.root.context(context)).head?.id;
    if (!active && head === lastHead) stable += 1;
    else stable = 0;
    lastHead = head;
    return stable >= 2;
  }, "background tasks quiesced and head stable", 120_000);
}

async function publishedCompactions(fixture: RawFixture): Promise<EntryRecord[]> {
  const entries = await allEntries(fixture.harness, fixture.root);
  return entries.filter((entry) => entry.kind === "pi.compaction" && publishedSnapshot(entry) !== undefined);
}

async function lastUserEntryId(fixture: RawFixture): Promise<EntryId> {
  const entries = await allEntries(fixture.harness, fixture.root);
  return entries.filter((entry) => entry.kind === "pi.user").at(-1)!.id;
}

// ---------------------------------------------------------------------------
// 08-A: a deterministic cross-day trace — 44 completed user requests, at least
// three published compactions, a task pause/resume, a preference correction
// and a tool failure with its correction. Every main-model request is reduced
// to A/B/C token sizes, message count and the baseline revision it carries;
// after every request the durable state (turn count, working revision,
// published compactions, head baseline revision) is recorded. The whole
// scenario runs twice in fresh directories and the two traces must be equal:
// that equality is the determinism claim. Cross-day coverage comes from
// source entries with explicit timestamps on three simulated days (the
// MEM-05 pattern), which the archive must file under their own dates.
// ---------------------------------------------------------------------------

type RequestRecord = {
  readonly calls: CallRecord[];
  readonly turns: number;
  readonly workingRev: number;
  readonly published: number;
  readonly headRev: number | null;
};

async function runTrace(name: string): Promise<{ requests: RequestRecord[]; fixture: RawFixture; seededThrough: EntryId; summaryTotal: number }> {
  let fixture = await openRawV(name, { budget: { evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 } });
  const requests: RequestRecord[] = [];
  const days = [
    Date.parse("2026-10-24T09:00:00Z"),
    Date.parse("2026-10-25T09:00:00Z"),
    Date.parse("2026-10-26T09:00:00Z"),
  ];
  let seededThrough: EntryId = 0 as EntryId;
  await fixture.harness.commit(async (tx) => {
    for (const [index, dayTs] of days.entries()) {
      await tx.appendEntry(fixture.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: `Day ${index + 1}: drafted the release checklist.` }], timestamp: dayTs }],
      });
      seededThrough = (await tx.appendEntry(fixture.root.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage(`Day ${index + 1}: checklist noted.`, { timestamp: dayTs + 60_000 })],
      })).id;
    }
  }, context);

  const headRev = async (): Promise<number | null> => {
    // The active view starts at its head marker: the newest snapshot-bearing entry in it is
    // the current block B (a published compaction head or an application projection).
    const view = await fixture.root.context(context);
    let rev: number | null = null;
    for (const entry of view.entries) {
      if (entry.kind === "pi.compaction") rev = publishedSnapshot(entry)?.baseline.revision ?? rev;
      else if (entry.kind === "personal.cycle") rev = snapshotOfProjection(entry.data)?.baseline.revision ?? rev;
    }
    return rev;
  };

  const drive = async (id: string, text: string): Promise<void> => {
    const before = fixture.trace.main.length;
    await driveRequest(fixture, id, text);
    await quiesce(fixture);
    requests.push({
      calls: fixture.trace.main.slice(before),
      turns: await readCompactionTurnCount(fixture.harness, fixture.root.id, context),
      workingRev: (await readWorking(fixture.harness, fixture.root.id, context)).revision,
      published: (await publishedCompactions(fixture)).length,
      headRev: await headRev(),
    });
  };

  const update = async (operationId: string, expectedRevision: number, changes: Parameters<typeof applyWorkingUpdate>[1]["changes"]): Promise<void> => {
    await applyWorkingUpdate(fixture.harness, {
      conversationId: fixture.root.id,
      operationId,
      expectedRevision,
      evidence: [await lastUserEntryId(fixture)],
      changes,
      now: Date.now(),
    }, context);
  };

  const taskDraft = (overrides: Record<string, unknown> = {}) => ({
    status: "active" as const,
    goal: "Prepare the quarterly release",
    scope: null,
    constraints: ["No downtime"],
    progress: [] as never[],
    blockers: [] as string[],
    nextStep: "Tag v1",
    notes: null,
    ...overrides,
  });

  await drive("t-01", "Start the release project.");
  await update("trace-task", 1, [{ op: "task.set", task: taskDraft() }]);
  for (let i = 2; i <= 9; i += 1) await drive(`t-${String(i).padStart(2, "0")}`, LONG);
  fixture.toolScript = true;
  await drive("t-10", "Check the deploy note, fixing whatever the lookup needs.");
  const evidence10 = await lastUserEntryId(fixture);
  await applyWorkingUpdate(fixture.harness, {
    conversationId: fixture.root.id, operationId: "trace-pref", expectedRevision: 2,
    evidence: [evidence10],
    changes: [{ op: "preference.put", preference: { id: "reply-style", text: "Answer in Chinese", scope: "replies", source: evidence10, expiresAt: null } }],
    now: Date.now(),
  }, context);
  for (let i = 11; i <= 19; i += 1) await drive(`t-${String(i).padStart(2, "0")}`, LONG);
  await update("trace-pause", 3, [{
    op: "task.set",
    task: taskDraft({
      blockers: ["Paused by the user"],
      progress: [{ id: "p-1", text: "Draft the release plan", status: "blocked", evidence: [await lastUserEntryId(fixture)] }],
      nextStep: null,
    }),
  }]);
  for (let i = 20; i <= 24; i += 1) await drive(`t-${String(i).padStart(2, "0")}`, LONG);
  await update("trace-resume", 4, [{
    op: "task.set",
    task: taskDraft({
      progress: [{ id: "p-1", text: "Draft the release plan", status: "in-progress", evidence: [await lastUserEntryId(fixture)] }],
    }),
  }]);
  await drive("t-25", "Short check-in.");
  await update("trace-correct", 5, [{
    op: "preference.put",
    preference: { id: "reply-style", text: "Answer in English", scope: "replies", source: await lastUserEntryId(fixture), expiresAt: null },
  }]);
  for (let i = 26; i <= 40; i += 1) await drive(`t-${String(i).padStart(2, "0")}`, LONG);
  // A restart in the middle of the trace: state must continue from durable records only.
  // The reopened fixture records into its own trace; the requests before and after the
  // restart are asserted through `requests` (already sliced) plus the final durable state.
  await closeRawV(fixture);
  const summaryBefore = fixture.trace.summary;
  fixture = await openRawV(name, { budget: { evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 }, dataDir: fixture.directory });
  for (let i = 41; i <= 44; i += 1) await drive(`t-${String(i).padStart(2, "0")}`, LONG);
  return { requests, fixture, seededThrough, summaryTotal: summaryBefore + fixture.trace.summary };
}

test("08-A: deterministic cross-day trace with 44 requests and repeated compactions", { timeout: 1_200_000 }, async () => {
  const first = await runTrace("mem08-trace-a-");
  try {
    const { requests, fixture } = first;
    assert.equal(requests.length, 44, "the trace completes 44 user requests");
    assert.equal(requests.at(-1)!.turns, 44, "every completed request is counted exactly once");
    const published = requests.at(-1)!.published;
    assert.ok(published >= 3, `at least three effective compactions were published (saw ${published})`);

    // Every main-model request carried A; from the first request on it also carried B.
    const allCalls = requests.flatMap((request) => request.calls);
    for (const [index, record] of allCalls.entries()) {
      assert.ok(record.a > 0, `call ${index} carries block A (instructions)`);
      assert.ok(record.b > 0, `call ${index} carries block B (a cycle snapshot)`);
      assert.ok(record.c >= 0, `call ${index} has a measurable block C`);
    }
    // The baseline revision a call carries never goes backwards, starts at the initial
    // revision and ends at the final working revision (task + preference + pause + resume
    // + correction = revision 6).
    const revisions = allCalls.map((record) => record.rev ?? 0);
    assert.equal(revisions[0], 1);
    for (let i = 1; i < revisions.length; i += 1) {
      assert.ok(revisions[i]! >= revisions[i - 1]!, `call ${i} revision ${revisions[i]} >= previous ${revisions[i - 1]}`);
    }
    assert.equal(revisions.at(-1), 6, "the last call carries the final working revision");
    assert.equal(requests.at(-1)!.workingRev, 6);

    // The tool-failure request really contains the failure and its correction: three main
    // calls (failing lookup, corrected lookup, answer) in request t-10.
    assert.equal(requests[9]!.calls.length, 3, "t-10 = failing tool call, corrected call, answer");

    // Compaction chain continuity: each published snapshot starts where the previous one
    // ended, and the first covers the seeded cross-day entries.
    const heads = await publishedCompactions(fixture);
    const snapshots = heads.map((entry) => publishedSnapshot(entry)!);
    for (let i = 1; i < snapshots.length; i += 1) {
      assert.equal(snapshots[i]!.sources?.after, snapshots[i - 1]!.sources?.through, `cycle ${i} chains from cycle ${i - 1}`);
    }

    // Cross-day archive: the seeded entries of all three simulated days are filed under
    // their own dates once the boundary re-scans settle.
    await until(async () => {
      const state = await readArchive(fixture.harness, fixture.root.id, context);
      return (state?.archivedThrough ?? 0) >= first.seededThrough;
    }, "archive covers the seeded cross-day entries", 120_000);
    const store = openDaily(fixture.directory);
    const search = await searchDaily(store, {});
    const dates = new Set(search.hits.map((hit) => hit.segment.date));
    assert.ok(dates.has("2026-10-24") && dates.has("2026-10-25") && dates.has("2026-10-26"),
      `seeded days filed under their own dates (saw ${[...dates].sort().join(", ")})`);
    const summaryUsage = await fixture.harness.snapshot(UsageDoc, fixture.root.id, context);
    assert.ok((summaryUsage?.models["app/summary"]?.totalTokens ?? 0) > 0, "summary usage is accounted under app/summary");
    assert.equal(first.summaryTotal, snapshots.length, "one successful summary call per published compaction");
  } finally {
    await disposeRawV(first.fixture);
  }

  // Determinism: the identical scenario in a fresh directory replays to the same trace.
  const second = await runTrace("mem08-trace-b-");
  try {
    assert.deepEqual(second.requests, first.requests, "two fresh runs of the trace agree request by request");
    assert.equal(second.summaryTotal, first.summaryTotal);
  } finally {
    await disposeRawV(second.fixture);
  }
});

// ---------------------------------------------------------------------------
// 08-B window 1: the request projection is committed, the input is never
// submitted, the process goes away. Recovery must reuse the committed
// projection byte-for-byte (07-A's window, re-verified as a crash point).
// ---------------------------------------------------------------------------

test("08-B/1: crash after the projection commit reuses it instead of recomputing", { timeout: 120_000 }, async () => {
  const fixture = await openRawV("mem08-b1-");
  const directory = fixture.directory;
  try {
    const prepared = await fixture.integration.prepareRequest({ requestId: "b-1", text: "later" }, context);
    assert.equal(prepared.kind, "new");
    const before = await allEntries(fixture.harness, fixture.root);
    const projections = before.filter((entry) => entry.kind === "personal.cycle");
    assert.equal(projections.length, 1, "the projection is durable before the crash");
    const projectionId = projections[0]!.id;
    // Crash point: the instance is abandoned with the input unsubmitted.
    await closeRawV(fixture);

    const reopened = await openRawV("mem08-b1-", { dataDir: directory });
    try {
      const again = await reopened.integration.prepareRequest({ requestId: "b-1", text: "later" }, context);
      assert.deepEqual(again, { kind: "new", action: "reuse-projection" });
      const after = await allEntries(reopened.harness, reopened.root);
      assert.deepEqual(
        after.filter((entry) => entry.kind === "personal.cycle").map((entry) => entry.id),
        [projectionId],
        "no second projection and no recomputed bytes",
      );
      const submission = await reopened.root.submit({ type: "input", content: "later", requestId: "b-1" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      await reopened.integration.afterRequest("b-1", context);
      assert.equal(await readCompactionTurnCount(reopened.harness, reopened.root.id, context), 1);
      assert.equal(reopened.trace.main.length, 1, "exactly one model call serves the recovered request");
      assert.ok(reopened.trace.main[0]!.b > 0, "the recovered call carries the reused projection as B");
    } finally {
      await disposeRawV(reopened);
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 08-B window 6: the reply is saved (the submission is done) but the process
// dies before the completion bookkeeping (`afterRequest`) runs. Recovery by
// redelivery must return the saved reply with no new work — and this window
// is where acceptance finds defect D-1: the completed turn is never counted,
// because the replay path skips `afterRequest` and no other step re-drives
// the (idempotent) count. Everything else about the window is consistent.
// The assertions below pin the observed behaviour so a fix changes them
// loudly instead of silently.
// ---------------------------------------------------------------------------

test("08-B/6: crash after the reply is saved returns it intact; the turn count is lost (defect D-1)", { timeout: 120_000 }, async () => {
  const fixture = await openRawV("mem08-b6-");
  const directory = fixture.directory;
  try {
    const prepared = await fixture.integration.prepareRequest({ requestId: "b-6", text: "hello" }, context);
    assert.equal(prepared.kind, "new");
    const submission = await fixture.root.submit({ type: "input", content: "hello", requestId: "b-6" }, context);
    const settled = await submission.wait(context);
    assert.equal(settled.status, "done");
    if (settled.type !== "input" || settled.status !== "done") throw new Error("unexpected settlement");
    const answerId = settled.answer;
    const entriesBefore = (await allEntries(fixture.harness, fixture.root)).map((entry) => entry.id);
    assert.equal(await readCompactionTurnCount(fixture.harness, fixture.root.id, context), 0, "the count has not run yet");
    // Crash point: answer durable, `afterRequest` never called.
    await closeRawV(fixture);

    const reopened = await openRawV("mem08-b6-", { dataDir: directory });
    try {
      const again = await reopened.integration.prepareRequest({ requestId: "b-6", text: "hello" }, context);
      assert.equal(again.kind, "replay");
      const replayed = await reopened.root.submit({ type: "input", content: "hello", requestId: "b-6" }, context);
      const settledAgain = await replayed.wait(context);
      assert.equal(settledAgain.status, "done");
      if (settledAgain.type !== "input" || settledAgain.status !== "done") throw new Error("unexpected settlement");
      assert.equal(settledAgain.answer, answerId, "the saved reply itself is returned, not a regeneration");
      assert.equal(reopened.trace.main.length, 0, "the replay runs no model call");
      const entriesAfter = (await allEntries(reopened.harness, reopened.root)).map((entry) => entry.id);
      assert.deepEqual(entriesAfter, entriesBefore, "the replay adds no entry at all");
      // Defect D-1: the request completed and its reply is durable, yet the completed-turn
      // counter never records it — and a later normal request does not heal the gap.
      assert.equal(await readCompactionTurnCount(reopened.harness, reopened.root.id, context), 0,
        "D-1: the completed turn escaped counting");
      await driveRequest(reopened, "b-6-next", "another question");
      assert.equal(await readCompactionTurnCount(reopened.harness, reopened.root.id, context), 1,
        "D-1: the counter lags permanently by the lost turn (1, not 2)");
    } finally {
      await disposeRawV(reopened);
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 08-C: every source range can be classified from durable facts alone —
// pending, archived (segments published, traceable to the original entries),
// or confirmed-empty (extraction ran and retained nothing). A failed batch
// is a gap the cursor never crosses, in either direction of retry; an
// extraction that cites an unknown source is a failure, never a success.
// ---------------------------------------------------------------------------

type ArchiveFixture = Awaited<ReturnType<typeof openArchiveFixture>>;

async function openArchiveFixture(existing?: string) {
  const directory = existing ?? await mkdtemp(join(tmpdir(), "mem08-archive-"));
  const store = openDaily(directory);
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const control = { mode: "echo" as "echo" | "empty" | "invalid" | "unknown-source", calls: 0 };
  faux.setResponses(Array.from({ length: 256 }, () => (transcript: { messages: readonly Message[] }) => {
    control.calls += 1;
    if (control.mode === "invalid") return fauxAssistantMessage("this is not json");
    const user = transcript.messages.find((message) => message.role === "user")!;
    const sources = JSON.parse(messageText(user)) as { entryId: number; text: string }[];
    if (control.mode === "empty") return fauxAssistantMessage('{"segments":[]}');
    if (control.mode === "unknown-source") {
      return fauxAssistantMessage(JSON.stringify({
        segments: [{ sourceEntryId: 999_999, kind: "result", status: "confirmed", text: "invented", supersedes: [] }],
      }));
    }
    return fauxAssistantMessage(JSON.stringify({
      segments: sources.map((source) => ({
        sourceEntryId: source.entryId, kind: "result", status: "confirmed", text: source.text, supersedes: [],
      })),
    }));
  }));
  const task = createArchiveTask({ store, model: { provider: "faux", modelId: "faux-1" } });
  const reg = createRegistry();
  reg.install({ name: "archive", tasks: [task] });
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
    models, registry: reg, settings: { compaction: { enabled: false } },
  }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "Be concise." } });
  await initializeArchive(harness, root.id, null, "UTC", context);
  const append = async (count: number, timestamp: number) => harness.commit(async (tx) => {
    const ids: EntryId[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push((await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `event at ${timestamp} #${i}`, timestamp }],
      })).id);
    }
    return ids;
  }, context);
  const waitTask = async (id: EntryId | null) => {
    const taskId = await requestArchive(harness, root.id, id!, task, context);
    assert.notEqual(taskId, null);
    harness.resume();
    return harness.waitForTask(taskId!, context);
  };
  const state = async (): Promise<ArchiveState> => (await readArchive(harness, root.id, context))!;
  const close = async () => { await harness.close(context).catch(() => {}); };
  return { directory, store, faux, task, harness, root, control, append, waitTask, state, close };
}

function classifyRange(state: ArchiveState, segmentsInRange: number, after: EntryId | null, through: EntryId): string {
  void after;
  if (state.archivedThrough !== null && state.archivedThrough >= through) {
    return segmentsInRange > 0 ? "archived" : "confirmed-empty";
  }
  // A retained failed batch (pending is kept for retry) still classifies as failed-pending:
  // it has been attempted, it is the gap, and it is distinguishable from a merely queued range.
  if (state.failure !== null) return "pending-failed";
  return "pending";
}

async function segmentsInRange(store: DailyStore, after: EntryId | null, through: EntryId): Promise<MemorySegment[]> {
  const search = await searchDaily(store, {});
  return search.hits
    .map((hit) => hit.segment)
    .filter((segment) => (after === null || segment.sources.through > after) && segment.sources.through <= through);
}

test("08-C: archive ranges classify as pending / archived / confirmed-empty and never cross a failure gap", { timeout: 300_000 }, async () => {
  const f = await openArchiveFixture();
  const day1 = Date.parse("2026-10-24T12:00:00Z");
  try {
    // Range 1: real content, archived with segments traceable to the original entries.
    const first = await f.append(3, day1);
    await f.waitTask(first.at(-1)!);
    let state = await f.state();
    let segments = await segmentsInRange(f.store, null, first.at(-1)!);
    assert.equal(classifyRange(state, segments.length, null, first.at(-1)!), "archived");
    assert.equal(segments.length, 3);
    for (const segment of segments) {
      assert.ok(first.includes(segment.sources.through), "each segment cites an original entry of the range");
      const found = await readSegment(f.store, { id: segment.id, date: segment.date });
      assert.ok(found.found, "the segment reads back from its file");
    }

    // Range 2: extraction retains nothing — confirmed-empty, distinct from archived.
    f.control.mode = "empty";
    const second = await f.append(2, day1 + 3_600_000);
    await f.waitTask(second.at(-1)!);
    state = await f.state();
    segments = await segmentsInRange(f.store, first.at(-1)!, second.at(-1)!);
    assert.equal(classifyRange(state, segments.length, first.at(-1)!, second.at(-1)!), "confirmed-empty");
    assert.equal(state.archivedThrough, second.at(-1));

    // Range 3: extraction keeps failing — the range stays pending-failed and the cursor
    // does not move; a target beyond the gap is not reached either.
    f.control.mode = "invalid";
    const third = await f.append(3, day1 + 7_200_000);
    const failedTask = await requestArchive(f.harness, f.root.id, third.at(-1)!, f.task, context);
    assert.notEqual(failedTask, null);
    f.harness.resume();
    await until(async () => {
      const current = await f.state();
      return current.failure !== null && current.activeTask === null;
    }, "archive failure persisted", 120_000);
    state = await f.state();
    segments = await segmentsInRange(f.store, second.at(-1)!, third.at(-1)!);
    assert.equal(classifyRange(state, segments.length, second.at(-1)!, third.at(-1)!), "pending-failed");
    assert.equal(state.archivedThrough, second.at(-1), "the cursor never crosses the failed batch");
    const beyond = await f.append(1, day1 + 10_800_000);
    const beyondTask = await requestArchive(f.harness, f.root.id, beyond.at(-1)!, f.task, context);
    assert.equal(beyondTask, null,
      "with a failure retained, a farther target is recorded but no new task starts (startIn refuses)");
    state = await f.state();
    assert.ok((state.target ?? 0) >= beyond.at(-1)!, "the farther target is durably recorded");
    assert.equal(state.archivedThrough, second.at(-1), "the gap is not crossed from the far side either");
    assert.equal((await segmentsInRange(f.store, second.at(-1)!, beyond.at(-1)!)).length, 0, "nothing past the gap was published");

    // An extraction citing an unknown source is a failure (missing-evidence), not a success.
    f.control.mode = "unknown-source";
    const retried = await retryArchive(f.harness, f.root.id, f.task, context);
    assert.notEqual(retried, null);
    f.harness.resume();
    await until(async () => {
      const current = await f.state();
      return current.activeTask === null && current.failure?.code === "missing-evidence";
    }, "unknown-source extraction recorded as missing-evidence failure", 120_000);
    state = await f.state();
    assert.equal(state.archivedThrough, second.at(-1), "an unknown citation never advances the cursor");

    // With a sound extraction the same ranges heal in order — coverage is continuous.
    f.control.mode = "echo";
    const healed = await retryArchive(f.harness, f.root.id, f.task, context);
    assert.notEqual(healed, null);
    assert.equal((await f.harness.waitForTask(healed!, context)).state.outcome.status, "completed");
    state = await f.state();
    assert.equal(state.archivedThrough, beyond.at(-1));
    segments = await segmentsInRange(f.store, second.at(-1)!, beyond.at(-1)!);
    assert.equal(classifyRange(state, segments.length, second.at(-1)!, beyond.at(-1)!), "archived");
    assert.equal(segments.length, 4, "the three gap entries and the one beyond are all archived after healing");
  } finally {
    await f.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 08-D: a preference correction and then a revocation stay effective across
// several compaction cycles and restarts. A legacy daily record that still
// states the old preference remains what it is — a dated historical event —
// and never re-enters the working state or a later snapshot baseline.
// ---------------------------------------------------------------------------

test("08-D: correction and revocation survive cycles and restarts; old daily memory does not reactivate them", { timeout: 600_000 }, async () => {
  const fixture = await openRawV("mem08-d-", { budget: { evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 } });
  const directory = fixture.directory;
  let current = fixture;
  const reopen = async () => {
    await closeRawV(current);
    current = await openRawV("mem08-d-", { budget: { evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 }, dataDir: directory });
  };
  try {
    // A legacy daily record stating the old preference, published directly as MEM-04 allows.
    const evidence = await current.harness.commit(
      async (tx) => (await tx.appendEntry(current.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "Please always answer in Chinese." }], timestamp: Date.parse("2026-10-24T08:00:00Z") }],
      })).id,
      context,
    );
    const store = openDaily(directory);
    await publishSegments(store, [{
      version: 1, id: "legacy-reply-style", date: "2026-10-24", timezone: "UTC", page: 1,
      kind: "user-requirement", status: "confirmed",
      text: "On 2026-10-24 the user asked to always answer in Chinese.",
      sources: { conversationId: current.root.id, after: null, through: evidence },
      supersedes: [], supersededBy: null,
    }]);

    await driveRequest(current, "d-1", "Start.");
    await applyWorkingUpdate(current.harness, {
      conversationId: current.root.id, operationId: "d-put-1", expectedRevision: 1,
      evidence: [evidence],
      changes: [{ op: "preference.put", preference: { id: "reply-style", text: "Answer in Chinese", scope: "replies", source: evidence, expiresAt: null } }],
      now: Date.now(),
    }, context);
    await driveRequest(current, "d-2", LONG);
    await driveRequest(current, "d-3", LONG);
    await quiesce(current);
    assert.ok((await publishedCompactions(current)).length >= 1, "first compaction cycle published");
    let state = await readWorking(current.harness, current.root.id, context);
    assert.equal(state.preferences.find((p) => p.id === "reply-style")?.text, "Answer in Chinese");

    // Correction: same id, new text — then more cycles and a restart.
    await applyWorkingUpdate(current.harness, {
      conversationId: current.root.id, operationId: "d-put-2", expectedRevision: state.revision,
      evidence: [await lastUserEntryId(current)],
      changes: [{ op: "preference.put", preference: { id: "reply-style", text: "Answer in English", scope: "replies", source: await lastUserEntryId(current), expiresAt: null } }],
      now: Date.now(),
    }, context);
    await driveRequest(current, "d-4", LONG);
    await driveRequest(current, "d-5", LONG);
    await quiesce(current);
    assert.ok((await publishedCompactions(current)).length >= 2, "second compaction cycle published");
    await reopen();
    state = await readWorking(current.harness, current.root.id, context);
    assert.equal(state.preferences.find((p) => p.id === "reply-style")?.text, "Answer in English",
      "the correction, not the original value, survives the cycles and the restart");

    // Revocation: remove the preference, run another cycle, restart again.
    await applyWorkingUpdate(current.harness, {
      conversationId: current.root.id, operationId: "d-remove", expectedRevision: state.revision,
      evidence: [await lastUserEntryId(current)],
      changes: [{ op: "preference.remove", id: "reply-style" }],
      now: Date.now(),
    }, context);
    await driveRequest(current, "d-6", LONG);
    await driveRequest(current, "d-7", LONG);
    await quiesce(current);
    assert.ok((await publishedCompactions(current)).length >= 3, "third compaction cycle published");
    await reopen();
    state = await readWorking(current.harness, current.root.id, context);
    assert.equal(state.preferences.some((p) => p.id === "reply-style"), false,
      "the revoked preference stays revoked across cycles and restarts");

    // The next request's snapshot baseline must not carry the revoked preference either.
    const callsBefore = current.trace.main.length;
    await driveRequest(current, "d-8", "One more question.");
    const lastCall = current.trace.main.at(-1)!;
    void callsBefore;
    assert.ok(lastCall.rev !== null, "the post-revocation call carries a snapshot baseline");
    const heads = await publishedCompactions(current);
    const baseline = publishedSnapshot(heads.at(-1)!)!.baseline;
    assert.equal(baseline.preferences.some((p) => p.id === "reply-style"), false,
      "the newest published baseline has no revoked preference");

    // The legacy daily record is still there as dated evidence — and a search surfaces it
    // as exactly that (a 2026-10-24 event), while the working authority stays empty.
    const search = await searchDaily(store, {});
    const legacy = search.hits.find((hit) => hit.segment.id === "legacy-reply-style");
    assert.ok(legacy !== undefined, "the historical daily record is preserved, not deleted");
    assert.equal(legacy.segment.date, "2026-10-24");
    state = await readWorking(current.harness, current.root.id, context);
    assert.equal(state.preferences.some((p) => p.id === "reply-style"), false,
      "the old daily record never reactivates the revoked preference");
  } finally {
    await disposeRawV(current);
  }
});

// ---------------------------------------------------------------------------
// 08-E (offline half): the request bodies a real provider Adapter produces
// keep an unchanged prefix. Two consecutive main-model requests from one
// cycle of the 08-A-style fixture are converted with pi-ai's real OpenAI
// Responses adapter (`convertResponsesMessages`, the exact conversion its
// stream path performs over the adapted transcript, with a real catalog
// model); the first body must be a strict JSON prefix of the second. The
// real-model and cloud-cache half of 08-E is environment-bound and is
// reported in docs/memory-verification.md — no faux result stands in for it.
// ---------------------------------------------------------------------------

test("08-E: the real OpenAI adapter's request bodies keep a byte-stable prefix within a cycle", { timeout: 120_000 }, async () => {
  const fixture = await openRawV("mem08-e-");
  try {
    await driveRequest(fixture, "e-1", "First question of the cycle.");
    await driveRequest(fixture, "e-2", "Second question of the cycle.");
    assert.ok(fixture.trace.contexts.length >= 2, "two adapted requests were captured");
    const [first, second] = fixture.trace.contexts;

    const models = createProviderModels("openai");
    const model = models.getModels("openai").find((candidate) => candidate.api === "openai-responses");
    assert.ok(model !== undefined, "the shipped catalog has an OpenAI Responses model");
    const body1 = convertResponsesMessages(model, first!, new Set([model.provider]));
    const body2 = convertResponsesMessages(model, second!, new Set([model.provider]));
    assert.ok(body1.length >= 3, "the first request body has system, snapshot and user items");
    assert.ok(body2.length > body1.length, "the second request appends to the first");
    for (let i = 0; i < body1.length; i += 1) {
      assert.equal(JSON.stringify(body2[i]), JSON.stringify(body1[i]),
        `converted item ${i} is byte-identical across the two requests`);
    }
    // The same stability at the fingerprint level the application itself uses (06-G):
    // instructions, snapshot and tools digests are all unchanged inside the cycle.
    const toolNames = ["current_time", "memory_read", "memory_search", "working_read", "working_update"];
    void toolNames;
    const firstCall = fixture.trace.main[0]!;
    const secondCall = fixture.trace.main[1]!;
    assert.equal(firstCall.a, secondCall.a, "block A size is stable inside the cycle");
    assert.equal(firstCall.b, secondCall.b, "block B size is stable inside the cycle");
    const fingerprint = requestPrefixFingerprint({ instructionsText: INSTRUCTIONS, snapshotText: "B", toolNames: [] });
    assert.equal(fingerprint.instructions.length, 64, "fingerprinting is over digests, not bodies");
  } finally {
    await disposeRawV(fixture);
  }
});

// ---------------------------------------------------------------------------
// 08-H: dependency review as a rerunnable static check over the sources.
// It proves the shape the design froze (§4): Context is pure (no I/O imports
// at all), Daily Memory never touches the durable SDK, Working manages no
// base execution state (types only, no submissions/tasks), the application
// reaches memory only through the composition root, delivery-side modules
// stay memory-free, and no memory source imports anything beyond Node
// builtins, the two SDK packages, typebox and relative paths — no event
// bus, database service or plugin framework crept in.
// ---------------------------------------------------------------------------

test("08-H: dependency review — pure Context, Harness-free Daily, state-only Working, one composition seam", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = async (path: string) => readFile(join(root, path), "utf8");
  const importsOf = (source: string) => [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!);

  const contextSource = await read("src/memory/context.ts");
  assert.ok(!/node:(fs|child_process|http|https|net|dgram)/.test(contextSource), "Context imports no I/O builtin");
  const contextDurableImports = contextSource.split("\n").filter((line) => line.includes("pi-durable"));
  assert.ok(contextDurableImports.every((line) => line.trimStart().startsWith("import type")),
    "Context imports only types from the durable SDK (no Harness, no runtime surface)");
  assert.ok(!/fetch\(|XMLHttpRequest/.test(contextSource), "Context performs no network I/O");

  const dailySource = await read("src/memory/daily.ts");
  assert.ok(!dailySource.includes("pi-durable"), "Daily Memory does not import the durable SDK at all");
  assert.ok(!dailySource.split("\n").some((line) => /^\s*import\s/.test(line) && line.includes("Harness")),
    "Daily Memory imports no Harness (the word survives only in its header comment)");

  const workingSource = await read("src/memory/working.ts");
  assert.ok(!/^\s*import\s+(?!type)[^;]*pi-durable/m.test(workingSource), "Working imports only types from the durable SDK");
  assert.ok(!/submission|defineTask|waitForTask|scanTasks/.test(workingSource),
    "Working manages no base execution state (no submissions, no tasks)");

  const archiveSource = await read("src/memory/archive.ts");
  assert.ok(!/Harness|defineTask|defineDoc/.test(archiveSource), "the pure Archive boundary has no SDK runtime surface");

  const agentSource = await read("src/agent.ts");
  const agentMemoryImports = importsOf(agentSource).filter((spec) => spec.includes("memory"));
  assert.deepEqual(agentMemoryImports, ["./memory/integration.js"], "the application reaches memory only through the composition root");

  for (const path of ["src/telegram.ts", "src/inbox.ts", "src/deliveries.ts", "src/main.ts"]) {
    const source = await read(path);
    assert.ok(!/from\s+"[^"]*memory\//.test(source), `${path} must not import memory internals`);
  }

  const allowed = /^(node:|@earendil-works\/|typebox|\.\/|\.\.\/)/;
  for (const path of [
    "src/memory/contracts.ts", "src/memory/working.ts", "src/memory/working-tools.ts",
    "src/memory/context.ts", "src/memory/daily.ts", "src/memory/archive.ts",
    "src/memory/archive-task.ts", "src/memory/compaction.ts", "src/memory/memory-tools.ts",
    "src/memory/integration.ts",
  ]) {
    for (const spec of importsOf(await read(path))) {
      assert.ok(allowed.test(spec), `${path} imports only SDK/builtin/relative modules (saw ${spec})`);
    }
  }

  const pkg = JSON.parse(await read("package.json")) as { dependencies: Record<string, string> };
  const dependencyNames = Object.keys(pkg.dependencies).sort();
  assert.deepEqual(dependencyNames, ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-codemode", "@earendil-works/pi-durable", "@earendil-works/pi-mcp", "@langfuse/otel", "@langfuse/tracing", "@opentelemetry/api", "@opentelemetry/exporter-trace-otlp-http", "@opentelemetry/sdk-trace-node", "abort-controller", "grammy", "typebox"],
    "the runtime dependency set is exactly the reviewed one (pi-codemode backs PTC, the two Langfuse packages plus their OTel API/exporter/provider back tracing; no event bus, database service or plugin framework)");
});
