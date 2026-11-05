import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, UsageDoc, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { archiveSource, ARCHIVE_INSTRUCTIONS, ARCHIVE_LIMITS } from "../src/memory/archive.js";
import { createArchiveTask, initializeArchive, readArchive, reconcileArchive, requestArchive, retryArchive,
  type ArchiveTaskOptions } from "../src/memory/archive-task.js";
import { MEMORY_LIMITS } from "../src/memory/contracts.js";
import { openDaily, searchDaily } from "../src/memory/daily.js";
import { profileOperationId } from "../src/memory/profile.js";
import { applyWorkingUpdate, readWorking } from "../src/memory/working.js";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
const day = Date.parse("2026-10-24T12:00:00Z");

async function fixture(options: Partial<ArchiveTaskOptions> = {}, existing?: string) {
  const directory = existing ?? await mkdtemp(join(tmpdir(), "memory-archive-"));
  const store = openDaily(directory);
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: { ids: number[] }[] = [];
  faux.setResponses(Array.from({ length: 100 }, () => (transcript: { messages: readonly { role: string; content: unknown }[] }) => {
    const input = transcript.messages.find((item) => item.role === "user")!;
    const text = typeof input.content === "string" ? input.content : (input.content as { text: string }[])[0]!.text;
    const sources = JSON.parse(text) as { entryId: number; text: string }[];
    calls.push({ ids: sources.map((source) => source.entryId) });
    return fauxAssistantMessage(JSON.stringify({ segments: sources.map((source) => ({
      sourceEntryId: source.entryId, kind: "result", status: "confirmed", text: source.text, supersedes: [],
    })) }));
  }));
  const task = createArchiveTask({ store, model, ...options });
  const registry = createRegistry();
  registry.install({ name: "archive", tasks: [task] });
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
    models, registry, settings: { compaction: { enabled: false } },
  }, context);
  const root = await harness.root(context, { agent: { model, instructions: "Be concise." } });
  await initializeArchive(harness, root.id, null, "UTC", context);
  const append = async (count: number, timestamp = day) => harness.commit(async (tx) => {
    const ids: EntryId[] = [];
    for (let i = 0; i < count; i++) ids.push((await tx.appendEntry(root.id, { kind: "pi.user",
      model: [{ role: "user", content: `event ${i}`, timestamp }] })).id);
    return ids;
  }, context);
  const wait = async (id: TaskId | null) => {
    assert.notEqual(id, null);
    harness.resume();
    return harness.waitForTask(id!, context);
  };
  const close = async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); };
  return { directory, store, faux, task, harness, root, calls, append, wait, close };
}

test("05-A/F: monotonic coverage, bounded batches and one background writer under trigger pressure", async () => {
  const f = await fixture();
  try {
    const ids = await f.append(200);
    const first = await requestArchive(f.harness, f.root.id, ids[149]!, f.task, context);
    const all = await Promise.all(Array.from({ length: 30 }, () => requestArchive(f.harness, f.root.id, ids[149]!, f.task, context)));
    assert.ok(all.every((id) => id === first));
    assert.equal((await f.wait(first)).state.outcome.status, "completed");
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, ids[149]);
    assert.ok(f.calls.every((call) => call.ids.length <= ARCHIVE_LIMITS.entries));
    const previousCalls = f.calls.length;
    await f.wait(await requestArchive(f.harness, f.root.id, ids[169]!, f.task, context));
    assert.deepEqual(f.calls.slice(previousCalls).flatMap((call) => call.ids), ids.slice(150, 170));
    await f.wait(await requestArchive(f.harness, f.root.id, ids[199]!, f.task, context));
    const calls = f.calls.length;
    assert.equal(await requestArchive(f.harness, f.root.id, ids[169]!, f.task, context), null);
    assert.equal(f.calls.length, calls);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, ids[199]);
    const usage = (await f.harness.snapshot(UsageDoc, f.root.id, context))!.models;
    assert.ok(usage["app/archive"]!.totalTokens > 0);
    assert.equal(usage["faux/faux-1"], undefined);
  } finally { await f.close(); }
});

test("05-B: derived records are skipped and durable empty extraction is not called again after restart", async () => {
  let f = await fixture();
  const directory = f.directory;
  try {
    const id = await f.harness.commit(async (tx) => {
      for (const kind of ["pi.compaction", "personal.cycle", "personal.working.revision", "pi.system"]) {
        await tx.appendEntry(f.root.id, { kind, model: [{ role: "user", content: "derived fact", timestamp: day }] });
      }
      return (await tx.appendEntry(f.root.id, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "search",
        toolName: "memory_search", content: [{ type: "text", text: "old memory" }], isError: false, timestamp: day }] })).id;
    }, context);
    await f.wait(await requestArchive(f.harness, f.root.id, id, f.task, context));
    assert.equal(f.calls.length, 0);
    const [raw] = await f.append(1);
    f.faux.setResponses([fauxAssistantMessage('{"segments":[]}')]);
    await f.wait(await requestArchive(f.harness, f.root.id, raw!, f.task, context));
    await f.harness.close(context);
    f = await fixture({}, directory);
    assert.equal(await requestArchive(f.harness, f.root.id, raw!, f.task, context), null);
    assert.equal(f.calls.length, 0);
    assert.equal((await searchDaily(f.store, {})).available, 0);
  } finally { await f.close(); }
});

for (const boundary of ["extracted", "saved", "published", "confirmed", "before-cursor"] as const) {
  test(`05-C: restart at ${boundary} retains a continuous prefix and stable published body`, async () => {
    const reached = Promise.withResolvers<void>();
    let paused = false;
    let f = await fixture({ boundary: async (name, signal) => {
      if (name !== boundary || paused) return;
      paused = true;
      reached.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const directory = f.directory;
    try {
      await f.append(1, day);
      const [last] = await f.append(1, day + 86_400_000);
      const id = await requestArchive(f.harness, f.root.id, last!, f.task, context);
      f.harness.resume();
      await reached.promise;
      assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, null);
      await f.harness.close(context);
      f = await fixture({}, directory);
      assert.equal((await f.wait(id)).state.outcome.status, "completed");
      const state = (await readArchive(f.harness, f.root.id, context))!;
      assert.equal(state.archivedThrough, last);
      assert.equal(state.pending, null);
      assert.equal(f.calls.length, boundary === "extracted" ? 1 : 0);
      const result = await searchDaily(f.store, {});
      assert.equal(result.hits.length, 2);
      assert.equal(new Set(result.hits.map((hit) => hit.segment.id)).size, 2);
      assert.deepEqual(result.hits.map((hit) => hit.segment.date), ["2026-10-24", "2026-10-25"]);
    } finally { await f.close(); }
  });
}

test("05-D: failed model and invalid output exhaust bounded attempts, preserve coverage, and allow retry", async () => {
  const f = await fixture();
  try {
    const [id] = await f.append(1);
    f.faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "unavailable" }),
      fauxAssistantMessage('{"segments":[{"sourceEntryId":999,"kind":"result","status":"confirmed","text":"fabricated","supersedes":[]}]}'),
      fauxAssistantMessage("invalid json"),
    ]);
    const result = await f.wait(await requestArchive(f.harness, f.root.id, id!, f.task, context));
    assert.equal(result.state.outcome.status, "failed");
    const failed = (await readArchive(f.harness, f.root.id, context))!;
    assert.equal(failed.archivedThrough, null);
    assert.equal(failed.pending!.attempts, 3);
    assert.equal(failed.failure!.code, "invalid-input");
    assert.equal(await requestArchive(f.harness, f.root.id, id!, f.task, context), null);
    const usageBefore = (await f.harness.snapshot(UsageDoc, f.root.id, context))!.models["app/archive"]!.totalTokens;
    assert.ok(usageBefore > 0);
    f.faux.setResponses([fauxAssistantMessage('{"segments":[]}')]);
    assert.equal((await f.wait(await retryArchive(f.harness, f.root.id, f.task, context))).state.outcome.status, "completed");
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, id);
    assert.ok((await f.harness.snapshot(UsageDoc, f.root.id, context))!.models["app/archive"]!.totalTokens > usageBefore);
  } finally { await f.close(); }
});

test("05-D: file failure retains saved body and retry does not call the extractor", async () => {
  const f = await fixture();
  try {
    const [id] = await f.append(1);
    const blocked = join(f.directory, "memory", "daily", "2026-10-24.md");
    await mkdir(blocked, { recursive: true });
    assert.equal((await f.wait(await requestArchive(f.harness, f.root.id, id!, f.task, context))).state.outcome.status, "failed");
    const state = (await readArchive(f.harness, f.root.id, context))!;
    assert.equal(state.failure!.code, "io-failure");
    assert.equal(state.archivedThrough, null);
    assert.equal(state.pending!.body!.length, 1);
    assert.equal(f.calls.length, 1);
    await rm(blocked, { recursive: true });
    assert.equal((await f.wait(await retryArchive(f.harness, f.root.id, f.task, context))).state.outcome.status, "completed");
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("05-D/F: explicit cancellation reaches model I/O, background work does not block ordinary idle", async () => {
  const f = await fixture();
  try {
    const [id] = await f.append(1);
    const started = Promise.withResolvers<void>();
    let aborted = false;
    f.faux.setResponses([(_transcript, options) => new Promise((resolve) => {
      options?.signal?.addEventListener("abort", () => { aborted = true; resolve(fauxAssistantMessage("cancelled")); }, { once: true });
      started.resolve();
    })]);
    const taskId = await requestArchive(f.harness, f.root.id, id!, f.task, context);
    f.harness.resume();
    await started.promise;
    await f.root.waitForIdle(context);
    await f.harness.abortTask(taskId!, context);
    const result = await f.harness.waitForTask(taskId!, context);
    assert.equal(result.state.outcome.status, "aborted");
    assert.equal(aborted, true);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.failure!.code, "cancelled");
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, null);
    f.faux.setResponses([fauxAssistantMessage('{"segments":[]}')]);
    assert.equal((await f.wait(await retryArchive(f.harness, f.root.id, f.task, context))).state.outcome.status, "completed");
  } finally { await f.close(); }
});

test("05-E/F: startup reconciles completion, published compaction and past dates without notifications", async () => {
  let f = await fixture();
  const directory = f.directory;
  try {
    const ids = await f.append(70, day);
    await f.harness.close(context);
    f = await fixture({}, directory);
    let sweep = await reconcileArchive(f.harness, f.root.id, f.task, day + 86_400_000, context);
    assert.equal(sweep.more, true);
    sweep = await reconcileArchive(f.harness, f.root.id, f.task, day + 86_400_000, context);
    assert.equal(sweep.more, false);
    await f.wait(sweep.taskId);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, ids.at(-1));
    const fresh = await f.append(3, day + 86_400_000);
    await f.harness.commit((tx) => tx.appendEntry(f.root.id, { kind: "pi.compaction", head: fresh[2]!,
      model: [{ role: "user", content: "derived summary", timestamp: day }] }), context);
    sweep = await reconcileArchive(f.harness, f.root.id, f.task, day + 86_400_000, context);
    await f.wait(sweep.taskId);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, fresh[1]);
    const completed = await f.harness.commit((tx) => tx.appendEntry(f.root.id, { kind: "personal.working.completed", data: {
      version: 1, operationId: "done", revision: 2, goal: "done", scope: null, sources: [], at: day + 86_400_000,
    } }), context);
    sweep = await reconcileArchive(f.harness, f.root.id, f.task, day + 86_400_000, context);
    await f.wait(sweep.taskId);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, completed.id);
    const raw = { id: fresh[0]!, conversationId: f.root.id, kind: "pi.user", model: [{ role: "user" as const, content: "late", timestamp: Date.parse("2026-10-24T23:30:00Z") }] };
    assert.equal(archiveSource(raw, "UTC")!.date, "2026-10-24");
    assert.equal(archiveSource(raw, "Asia/Shanghai")!.date, "2026-10-25");
    assert.throws(() => archiveSource({ ...raw, model: [{ ...raw.model[0]!, timestamp: NaN }] }, "UTC"), /timestamp is invalid/);
    const unknownTime = structuredClone(raw);
    Reflect.deleteProperty(unknownTime.model[0]!, "timestamp");
    assert.equal(archiveSource(unknownTime, "UTC")!.date, "unknown");
    const failedTool = archiveSource({ ...raw, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "failure",
      toolName: "bash", content: [{ type: "text", text: "exit 1" }], isError: true, timestamp: day }] }, "UTC");
    assert.match(failedTool!.text, /failed.*\nexit 1/);
  } finally { await f.close(); }
});

for (const boundary of ["extracted", "saved", "published", "before-cursor"] as const) {
  test(`05-C: SIGKILL at ${boundary} recovers saved bytes and every date`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "archive-kill-"));
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/crash-archive.ts", import.meta.url)), directory, boundary],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exited = once(child, "exit");
    try {
      const ready = await Promise.race([
        once(child, "message"),
        exited.then(() => { throw new Error(`Archive child exited before boundary: ${stderr}`); }),
      ]);
      assert.deepEqual(ready[0], { boundary });
      child.kill("SIGKILL");
      await exited;
      assert.equal(await readFile(join(directory, "model-attempts.txt"), "utf8"), "call\n");
      f = await fixture({}, directory);
      const before = (await readArchive(f.harness, f.root.id, context))!;
      assert.equal(before.archivedThrough, null);
      assert.equal((await f.wait(before.activeTask)).state.outcome.status, "completed");
      assert.equal(f.calls.length, boundary === "extracted" ? 1 : 0);
      const hits = (await searchDaily(f.store, {})).hits;
      assert.equal(hits.length, 2);
      assert.equal(new Set(hits.map((hit) => hit.segment.id)).size, 2);
      if (boundary !== "extracted") assert.ok(hits.every((hit) => hit.segment.text.startsWith("saved body")));
      assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, before.target);
    } finally {
      child.kill("SIGKILL");
      if (f) await f.close();
      else await rm(directory, { recursive: true, force: true });
    }
  });
}

test("05-D/F: model timeout stops actual I/O and leaves a bounded retryable failure", async () => {
  const f = await fixture({ timeoutMs: 20 });
  try {
    const [id] = await f.append(1);
    let aborted = 0;
    f.faux.setResponses(Array.from({ length: 3 }, () => (_transcript, options) => new Promise((resolve) => {
      options?.signal?.addEventListener("abort", () => { aborted++; resolve(fauxAssistantMessage("late")); }, { once: true });
    })));
    assert.equal((await f.wait(await requestArchive(f.harness, f.root.id, id!, f.task, context))).state.outcome.status, "failed");
    assert.equal(aborted, 3);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, null);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.failure!.code, "model-failure");
  } finally { await f.close(); }
});

test("05-D: failed background archive leaves saved business response and original request intact", async () => {
  const f = await fixture();
  try {
    f.faux.setResponses([fauxAssistantMessage("saved reply")]);
    f.harness.resume();
    const response = await (await f.root.submit({ type: "input", content: "do work", requestId: "business" }, context)).wait(context);
    assert.equal(response.status, "done");
    assert.ok(response.type === "input" && response.status === "done");
    const answer = response.answer;
    f.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("bad json")));
    assert.equal((await f.wait(await requestArchive(f.harness, f.root.id, answer, f.task, context))).state.outcome.status, "failed");
    const recovered = await (await f.root.submit({ type: "input", content: "do work", requestId: "business" }, context)).wait(context);
    assert.ok(recovered.type === "input" && recovered.status === "done");
    assert.equal(recovered.answer, answer);
    const entry = await f.harness.commit((tx) => tx.entry(answer), context);
    assert.equal(entry!.model![0]!.role, "assistant");
    assert.match(JSON.stringify(entry), /saved reply/);
  } finally { await f.close(); }
});

test("05-F: oversized source is rejected without a coverage gap or model I/O", async () => {
  const f = await fixture();
  try {
    const entry = await f.harness.commit((tx) => tx.appendEntry(f.root.id, { kind: "pi.user",
      model: [{ role: "user", content: "x".repeat(ARCHIVE_LIMITS.sourceBytes + 1), timestamp: day }] }), context);
    assert.equal((await f.wait(await requestArchive(f.harness, f.root.id, entry.id, f.task, context))).state.outcome.status, "failed");
    const state = (await readArchive(f.harness, f.root.id, context))!;
    assert.equal(state.failure!.code, "budget-exceeded");
    assert.equal(state.archivedThrough, null);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

// F-2 regression guard (found by the MEM-08 live run): a real extraction model completed a
// month-and-day deadline with an invented year. The extraction prompt must order date fidelity.
test("05-H: the archive instructions forbid inventing or completing dates", () => {
  assert.match(ARCHIVE_INSTRUCTIONS, /never invent or complete a missing year, month, or day/);
});

function userRequirementResponse() {
  return (transcript: { messages: readonly { role: string; content: unknown }[] }) => {
    const input = transcript.messages.find((item) => item.role === "user")!;
    const text = typeof input.content === "string" ? input.content : (input.content as { text: string }[])[0]!.text;
    const sources = JSON.parse(text) as { entryId: number }[];
    return fauxAssistantMessage(JSON.stringify({
      segments: sources.map((source) => ({
        sourceEntryId: source.entryId,
        kind: "user-requirement",
        status: "confirmed",
        text: "Answers in Chinese",
        supersedes: [],
      })),
    }));
  };
}

test("a confirmed batch writes the profile with the cursor, and a crash before that commit applies it once", async () => {
  const reached = Promise.withResolvers<void>();
  let paused = false;
  let f = await fixture({ boundary: async (name, signal) => {
    if (name !== "before-cursor" || paused) return;
    paused = true;
    reached.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const directory = f.directory;
  try {
    f.faux.setResponses([userRequirementResponse()]);
    const [id] = await f.append(1);
    const taskId = await requestArchive(f.harness, f.root.id, id!, f.task, context);
    f.harness.resume();
    await reached.promise;
    assert.deepEqual((await readWorking(f.harness, f.root.id, context)).profile, []);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, null);
    await f.harness.close(context);
    f = await fixture({}, directory);
    assert.equal((await f.wait(taskId)).state.outcome.status, "completed");
    assert.equal(f.calls.length, 0, "the saved body is reused, so extraction does not run again");
    const restored = await readWorking(f.harness, f.root.id, context);
    assert.equal(restored.revision, 2);
    assert.equal(restored.profile.length, 1);
    assert.equal(restored.profile[0]?.text, "Answers in Chinese");
    assert.equal(restored.profile[0]?.evidence[0]?.date, "2026-10-24");
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, id);
    const replay = await applyWorkingUpdate(f.harness, {
      conversationId: f.root.id,
      operationId: profileOperationId(`archive:${f.root.id}:0:${id}`),
      expectedRevision: 1,
      evidence: [],
      changes: [{
        op: "profile.put",
        item: {
          id: "other",
          text: "Answers in English",
          category: "user-requirement",
          evidence: [{ date: "2026-10-24", id: "other", page: 1 }],
        },
      }],
      resolveProfileEvidence: async () => {},
      now: 9,
    }, context);
    assert.equal(replay.changed, true);
    assert.equal(replay.revision, 2, "the archive operation id replays its receipt instead of applying again");
    assert.equal((await readWorking(f.harness, f.root.id, context)).profile[0]?.text, "Answers in Chinese");
    assert.equal(await requestArchive(f.harness, f.root.id, id!, f.task, context), null);
  } finally { await f.close(); }
});

test("profile extraction can be turned off without stopping the archive cursor", async () => {
  const f = await fixture({ profile: false });
  try {
    f.faux.setResponses([userRequirementResponse()]);
    const [id] = await f.append(1);
    assert.equal((await f.wait(await requestArchive(f.harness, f.root.id, id!, f.task, context))).state.outcome.status, "completed");
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, id);
    assert.deepEqual((await readWorking(f.harness, f.root.id, context)).profile, []);
  } finally { await f.close(); }
});

test("a full profile does not block the archive cursor or drop stored items", async () => {
  const f = await fixture();
  try {
    await applyWorkingUpdate(f.harness, {
      conversationId: f.root.id,
      operationId: "seed-profile",
      expectedRevision: 1,
      evidence: [],
      changes: Array.from({ length: MEMORY_LIMITS.profile }, (_, index) => ({
        op: "profile.put" as const,
        item: {
          id: `p${index + 1}`,
          text: `fact ${index + 1}`,
          category: "user-requirement",
          evidence: [{ date: "2026-10-25", id: `seed-${index + 1}`, page: 1 }],
        },
      })),
      resolveProfileEvidence: async () => {},
      now: 1,
    }, context);
    f.faux.setResponses([userRequirementResponse()]);
    const [id] = await f.append(1);
    assert.equal((await f.wait(await requestArchive(f.harness, f.root.id, id!, f.task, context))).state.outcome.status, "completed");
    const state = await readWorking(f.harness, f.root.id, context);
    assert.equal((await readArchive(f.harness, f.root.id, context))!.archivedThrough, id);
    assert.equal(state.revision, 2);
    assert.equal(state.profile.length, MEMORY_LIMITS.profile);
    assert.equal(state.profile.some((item) => item.text === "Answers in Chinese"), false);
  } finally { await f.close(); }
});
