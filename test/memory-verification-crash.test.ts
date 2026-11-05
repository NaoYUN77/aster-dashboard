// MEM-08 acceptance, part 2 (08-B process-interruption windows): real child processes are
// SIGKILLed at durable barriers — never at guessed moments — and a fresh process then proves
// the recovered state, files and call counts.
//
//   window 2  working commit durable, tool result not        (fixtures/crash-working.ts)
//   window 3  compaction summary persisted, not yet published (fixtures/crash-compaction-publish.ts)
//   window 4  Markdown file replaced, publication unconfirmed (fixtures/crash-archive.ts @ published)
//   window 5  archive confirmed, cursor not yet advanced      (fixtures/crash-archive.ts @ before-cursor)
//
// Windows 1 (projection) and 6 (reply saved) are in memory-verification.test.ts: their
// barriers are a resolved prepare and a settled submission, which an abandoned instance
// reproduces exactly, with no process kill needed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type Conversation,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { WorkingAnchorEntry, type WorkingReceipt } from "../src/memory/contracts.js";
import { activeTask, readWorking, readWorkingReceipt } from "../src/memory/working.js";
import { workingTools } from "../src/memory/working-tools.js";
import {
  createCompactionExtension,
  publishedSnapshot,
  readCompactionSummary,
  summaryBodyOfEntry,
  type CompactionObservation,
} from "../src/memory/compaction.js";
import { workingExtension } from "../src/memory/working-tools.js";
import { createArchiveTask, initializeArchive, readArchive } from "../src/memory/archive-task.js";
import { openDaily, searchDaily } from "../src/memory/daily.js";

const context = BACKGROUND_CONTEXT;
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(projectRoot, "test", "fixtures");

async function until(check: () => Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await delay(25);
  }
}

async function allEntries(harness: Harness, root: Conversation): Promise<EntryRecord[]> {
  const page = await root.entries({ order: "ascending" }, 2_000, undefined, context);
  return [...page.items];
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
}

// ---------------------------------------------------------------------------
// 08-B window 2: the working commit is durable; the tool result is not.
// The rerun in the recovering process must return the original receipt and
// apply the change exactly once (MEM-02's 02-B conclusion, re-verified).
// ---------------------------------------------------------------------------

test("08-B/2: SIGKILL after the working commit — the rerun returns the original receipt, applied once", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mem08-b2-"));
  const database = join(directory, "agent.sqlite");
  const marker = join(directory, "committed.txt");
  let harness: Harness | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", join(fixturesDir, "crash-working.ts"), database, marker], {
    cwd: projectRoot, stdio: "ignore", windowsHide: true,
  });
  const exited = once(child, "exit");
  try {
    await until(async () => {
      try { await access(marker); return true; } catch { return false; }
    }, "the child commits the working update");
    child.kill("SIGKILL");
    await exited;
    const beforeCrash = JSON.parse(await readFile(marker, "utf8")) as WorkingReceipt;

    const faux = fauxProvider({ provider: "faux" });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const reruns: string[] = [];
    const update = workingTools().find((tool) => tool.name === "working_update")!;
    registry.install({
      name: "working-crash",
      tools: [{
        ...update,
        execute: async (args, api, ctx) => {
          reruns.push(api.taskId.toString());
          return update.execute(args, api, ctx);
        },
      }],
    });
    harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    faux.setResponses([fauxAssistantMessage("Recovered.")]);
    harness.resume();
    const submission = await harness.commit(
      async (tx) => tx.submissionByRequest(root.id, "crash-working"),
      context,
    );
    assert.ok(submission !== undefined, "the interrupted request is still recoverable by its id");
    await harness.waitForIdle(context);

    const state = await readWorking(harness, root.id, context);
    assert.equal(state.revision, beforeCrash.revision, "the rerun must not increment the revision again");
    assert.equal(activeTask(state)?.goal, "Ship the fix");
    const anchors = (await allEntries(harness, root)).filter((entry) => entry.kind === WorkingAnchorEntry.kind);
    assert.equal(anchors.length, 1, "the change applied exactly once");
    const stored = await readWorkingReceipt(harness, root.id, beforeCrash.operationId, context);
    assert.deepEqual(stored, beforeCrash, "the rerun returns the original receipt");
    assert.equal(reruns.length, 1, "the recovering process reran the update exactly once");
    const entries = await allEntries(harness, root);
    const result = entries
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "toolResult" && message.toolCallId === "update") as
      Extract<Message, { role: "toolResult" }> | undefined;
    assert.ok(result !== undefined && !result.isError, "the recovered run stored a successful tool result");
  } finally {
    child.kill("SIGKILL");
    await harness?.close(context).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 08-B window 3: the compaction summary result is persisted, the hook has
// not returned, publication has not happened — the crash window MEM-06
// explicitly left unverified end to end. Recovery must reuse the saved
// bytes: no second summary call, no double usage, and the published head
// carries exactly the saved rendering.
// ---------------------------------------------------------------------------

test("08-B/3: SIGKILL after the summary is persisted — recovery reuses it and publishes it verbatim", { timeout: 300_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mem08-b3-"));
  const attemptsFile = join(directory, "summary-attempts.txt");
  const database = join(directory, "agent.sqlite");
  const child = spawn(process.execPath, ["--import", "tsx", join(fixturesDir, "crash-compaction-publish.ts"), directory, attemptsFile], {
    cwd: projectRoot, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  let harness: Harness | undefined;
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      exited.then(() => { throw new Error(`compaction child exited before the barrier: ${stderr}`); }),
      delay(240_000).then(() => { throw new Error(`timed out waiting for the persist barrier: ${stderr}`); }),
    ]);
    assert.deepEqual(message, { boundary: "summary-persisted" });
    child.kill("SIGKILL");
    await exited;
    assert.equal(await readFile(attemptsFile, "utf8"), "call\n", "exactly one summary attempt happened before the kill");

    // Post-kill inspection in a fresh process: nothing was published, but the attempt's
    // usage is already accounted and the seeded working state is intact.
    const inspectModels = createModels();
    harness = await Harness.open(await openNodeSqliteStorage(database), {
      models: inspectModels, registry: createRegistry(),
    }, context);
    let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "SYSTEM RULES: be concise." } });
    const entriesAfterKill = await allEntries(harness, root);
    assert.equal(entriesAfterKill.filter((entry) => entry.kind === "pi.compaction").length, 0,
      "no compaction entry exists: publication never happened");
    const usageAfterKill = (await harness.snapshot(UsageDoc, root.id, context))?.models["app/summary"]?.totalTokens ?? 0;
    assert.ok(usageAfterKill > 0, "the killed attempt's usage is already accounted under app/summary");
    const workingAfterKill = await readWorking(harness, root.id, context);
    assert.equal(workingAfterKill.revision, 2);
    assert.equal(activeTask(workingAfterKill)?.goal, "Ship the fix");
    const conversationId = root.id;
    await harness.close(context);
    harness = undefined;

    // Recovery: a fresh harness with the adapter and a counting summary model. The saved
    // result must be reused — the summary model is not called again.
    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 1200, maxTokens: 512 }],
    });
    const summaryFaux = fauxProvider({ provider: "summary", models: [{ id: "summary-1" }] });
    let recoverySummaryCalls = 0;
    summaryFaux.setResponses([() => {
      recoverySummaryCalls += 1;
      return fauxAssistantMessage("A different narrative that must never be used.");
    }]);
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Noted.")));
    const models = createModels();
    models.setProvider(faux.provider);
    models.setProvider(summaryFaux.provider);
    const registry = createRegistry();
    registry.install(workingExtension);
    const observations: CompactionObservation[] = [];
    let recoveryHarness: Harness | undefined;
    registry.install(createCompactionExtension({
      commit: { commit: (change, ctx) => recoveryHarness!.commit(change, ctx) },
      model: { provider: "summary", modelId: "summary-1" },
      onResult: (observation) => observations.push(observation),
    }));
    recoveryHarness = await Harness.open(await openNodeSqliteStorage(database), {
      models,
      registry,
      settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 0 } },
    }, context);
    harness = recoveryHarness;
    root = await recoveryHarness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "SYSTEM RULES: be concise." } });
    assert.equal(root.id, conversationId);
    recoveryHarness.resume();
    // The killed run's compaction task is durable: the harness resumes it, and its hook
    // re-run is what must find the saved record. Wait for that publication first; only if
    // the task demonstrably settled without publishing (checked over consecutive polls)
    // drive one explicit compaction, whose hook takes the same reuse path.
    let settledPolls = 0;
    await until(async () => {
      const entries = await allEntries(recoveryHarness!, root);
      if (entries.some((entry) => entry.kind === "pi.compaction")) return true;
      const tasks = await recoveryHarness!.commit(
        async (tx) => (await tx.scanTasks({ conversationId: root.id, kind: "pi.compaction" }, 40)).items,
        context,
      );
      if (tasks.length > 0 && tasks.every((task) => task.state.status === "terminal")) {
        settledPolls += 1;
        if (settledPolls >= 3) {
          settledPolls = 0;
          await root.compact(undefined, context);
        }
      }
      return false;
    }, "the reused summary is published as the new head", 240_000);

    assert.equal(recoverySummaryCalls, 0, "recovery does not call the summary model again");
    const reused = observations.find((observation) => observation.outcome === "reused");
    assert.ok(reused !== undefined, `the adapter reports the saved result as reused (saw ${observations.map((o) => o.outcome).join(", ")})`);
    const saved = await readCompactionSummary(recoveryHarness, root.id, reused.key, context);
    assert.ok(saved !== undefined && saved.status === "succeeded" && saved.rendered !== null);
    const head = (await allEntries(recoveryHarness, root)).find((entry) => entry.kind === "pi.compaction")!;
    assert.equal(summaryBodyOfEntry(head), saved.rendered, "the published head carries the saved bytes verbatim");
    assert.equal(publishedSnapshot(head)?.baseline.revision, 2, "the published B pins the boundary working revision");
    const usageAfterRecovery = (await recoveryHarness.snapshot(UsageDoc, root.id, context))?.models["app/summary"]?.totalTokens ?? 0;
    assert.equal(usageAfterRecovery, usageAfterKill, "reuse does not double-account summary usage");
  } finally {
    child.kill("SIGKILL");
    await harness?.close(context).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 08-B windows 4 and 5: archive publication windows, driven by the existing
// MEM-05 crash fixture (IPC barrier inside the archive task).
//   published     — the Markdown file has been replaced on disk; the
//                   publication is not yet confirmed in the archive state.
//   before-cursor — every segment is confirmed; the cursor commit has not
//                   run, so coverage still shows the old position.
// ---------------------------------------------------------------------------

async function openArchiveRecovery(directory: string) {
  const store = openDaily(directory);
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  let extractionCalls = 0;
  faux.setResponses(Array.from({ length: 16 }, () => (transcript: { messages: readonly Message[] }) => {
    extractionCalls += 1;
    const user = transcript.messages.find((message) => message.role === "user")!;
    const sources = JSON.parse(messageText(user)) as { entryId: number; text: string }[];
    return fauxAssistantMessage(JSON.stringify({
      segments: sources.map((source) => ({
        sourceEntryId: source.entryId, kind: "result", status: "confirmed", text: `saved body ${source.entryId}`, supersedes: [],
      })),
    }));
  }));
  const task = createArchiveTask({ store, model: { provider: "faux", modelId: "faux-1" } });
  const registry = createRegistry();
  registry.install({ name: "archive", tasks: [task] });
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
    models, registry,
  }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await initializeArchive(harness, root.id, null, "UTC", context);
  return { store, harness, root, extractionCalls: () => extractionCalls };
}

for (const boundary of ["published", "before-cursor"] as const) {
  test(`08-B/${boundary === "published" ? 4 : 5}: SIGKILL at the archive ${boundary} barrier recovers exactly once`, { timeout: 300_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `mem08-b-${boundary}-`));
    const child = spawn(process.execPath, ["--import", "tsx", join(fixturesDir, "crash-archive.ts"), directory, boundary], {
      cwd: projectRoot, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exited = once(child, "exit");
    let recovery: Awaited<ReturnType<typeof openArchiveRecovery>> | undefined;
    try {
      const [message] = await Promise.race([
        once(child, "message"),
        exited.then(() => { throw new Error(`archive child exited before the barrier: ${stderr}`); }),
        delay(240_000).then(() => { throw new Error(`timed out waiting for the ${boundary} barrier: ${stderr}`); }),
      ]);
      assert.deepEqual(message, { boundary });
      child.kill("SIGKILL");
      await exited;
      assert.equal(await readFile(join(directory, "model-attempts.txt"), "utf8"), "call\n",
        "exactly one extraction call happened before the kill");

      recovery = await openArchiveRecovery(directory);
      const { harness, root, store } = recovery;
      const before = (await readArchive(harness, root.id, context))!;
      assert.equal(before.archivedThrough, null, "the cursor has not advanced at either barrier");
      assert.ok(before.target !== null && before.pending !== null, "the batch is retained for recovery");
      const hitsBefore = (await searchDaily(store, {})).hits;
      if (boundary === "published") {
        assert.equal(before.pending!.confirmed.length, 0, "the replaced file is not yet confirmed in the state");
        assert.equal(hitsBefore.length, 1, "the first segment is already on disk (the file was replaced)");
      } else {
        assert.equal(before.pending!.confirmed.length, 2, "both segments are confirmed; only the cursor commit is missing");
        assert.equal(hitsBefore.length, 2, "both segments are on disk");
      }

      harness.resume();
      const settled = await harness.waitForTask(before.activeTask!, context);
      assert.equal(settled.state.outcome.status, "completed");
      assert.equal(recovery.extractionCalls(), 0, "recovery re-extracts nothing: the saved body is reused");
      const after = (await readArchive(harness, root.id, context))!;
      assert.equal(after.archivedThrough, before.target, "the cursor advances exactly to the batch target");
      const hits = (await searchDaily(store, {})).hits;
      assert.equal(hits.length, 2, "both dates are filed after recovery");
      assert.equal(new Set(hits.map((hit) => hit.segment.id)).size, 2, "no segment was duplicated by the recovery publication");
      // The file bytes themselves carry each segment id exactly once (no double append).
      for (const hit of hits) {
        const fileText = await readFile(join(directory, "memory", "daily", `${hit.segment.date}.md`), "utf8");
        assert.equal(fileText.split(hit.segment.id).length - 1, 1, `segment ${hit.segment.id} appears once in ${hit.segment.date}.md`);
      }
    } finally {
      child.kill("SIGKILL");
      await recovery?.harness.close(context).catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
