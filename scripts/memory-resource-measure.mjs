// MEM-08 / 08-F resource measurement for the memory subsystem (composition-root level).
//
//   node --import tsx scripts/memory-resource-measure.mjs
//
// Drives three workloads against the real MEM-07 composition root on temporary directories
// with faux providers (deterministic content; latency therefore measures local machinery,
// not a network or a real model):
//   typical       30 short user requests
//   tool-dense    12 requests, each with two tool executions (a forced failure, then its
//                 correction) across three model calls
//   cross-day     a database built over three simulated days with two published compactions,
//                 closed and reopened: reopen latency, first-request latency, archive lag
//
// Prints one JSON object with the raw measurements. Peak RSS is the child sampler's view of
// this process (VmHWM from /proc/self/status at the end, plus a 25 ms sampler).
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createToolRegistry } from "../src/tools.ts";
import { MEMORY_BUDGET_DEFAULTS } from "../src/memory/contracts.ts";
import { openDaily, searchDaily } from "../src/memory/daily.ts";
import { readArchive } from "../src/memory/archive-task.ts";
import { publishedSnapshot, readCompactionTurnCount } from "../src/memory/compaction.ts";
import { createMemoryIntegration } from "../src/memory/integration.ts";

const context = BACKGROUND_CONTEXT;
const INSTRUCTIONS = "SYSTEM RULES: be concise and cite memory sources.";
const LONG = "lorem ipsum dolor sit amet ".repeat(80);

let peakRss = 0;
const sampler = setInterval(async () => {
  try {
    const status = await readFile("/proc/self/status", "utf8");
    const hwm = /VmHWM:\s+(\d+) kB/.exec(status);
    if (hwm) peakRss = Math.max(peakRss, Number(hwm[1]) * 1024);
  } catch { /* sampler is best-effort */ }
}, 25);
sampler.unref();

async function dirBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await dirBytes(path);
    else total += (await stat(path)).size;
  }
  return total;
}

const noteLookup = defineTool({
  name: "note_lookup",
  description: "Look up a project note by topic.",
  parameters: Type.Object({ fail: Type.Boolean() }, { additionalProperties: false }),
  replay: "safe",
  execute: async (args) => args.fail
    ? { isError: true, output: [{ type: "text", text: "note_lookup failed: note service unavailable" }] }
    : { output: [{ type: "text", text: "note: the deploy window is Friday 02:00 UTC" }] },
});

async function openFixture(name, budgetOverrides = {}, dataDir = undefined) {
  const directory = dataDir ?? await mkdtemp(join(tmpdir(), name));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "", { flag: "a" });
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = { main: 0, summary: 0, archive: 0, inputTokens: 0 };
  const router = (transcript) => {
    const all = transcript.messages.map((m) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("")).join("\n");
    if (all.includes("context summarization assistant")) {
      calls.summary += 1;
      return fauxAssistantMessage("Work continues on the quarterly release; goals, constraints and open steps are preserved.");
    }
    if (all.includes("Extract useful daily events")) {
      calls.archive += 1;
      const user = transcript.messages.find((m) => m.role === "user");
      const text = typeof user.content === "string" ? user.content : user.content.filter((p) => p.type === "text").map((p) => p.text).join("");
      const sources = JSON.parse(text);
      return fauxAssistantMessage(JSON.stringify({
        segments: sources.map((s) => ({ sourceEntryId: s.entryId, kind: "result", status: "confirmed", text: `Archived note for entry ${s.entryId}`, supersedes: [] })),
      }));
    }
    calls.main += 1;
    for (const message of transcript.messages) {
      const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
      calls.inputTokens += estimateTextTokens(text);
    }
    // Tool results of the CURRENT request only: the transcript accumulates every earlier
    // request's results, so slice from the last user message (the current input) onward.
    // (The first version of this script filtered the whole transcript and silently
    // degraded requests 2..12 of the tool-dense workload to one call each.)
    const lastUserIndex = transcript.messages.map((m) => m.role).lastIndexOf("user");
    const results = transcript.messages.slice(lastUserIndex + 1).filter((m) => m.role === "toolResult" && m.toolName === "note_lookup");
    const last = results.at(-1);
    if (fixture.toolArmed) {
      if (last === undefined) return fauxAssistantMessage(fauxToolCall("note_lookup", { fail: true }, { id: "n1" }), { stopReason: "toolUse" });
      if (last.isError) return fauxAssistantMessage(fauxToolCall("note_lookup", { fail: false }, { id: "n2" }), { stopReason: "toolUse" });
      fixture.toolArmed = false;
      return fauxAssistantMessage("The note says the deploy window is Friday.");
    }
    return fauxAssistantMessage("All noted.");
  };
  faux.setResponses(Array.from({ length: 1024 }, () => router));
  const budget = { ...MEMORY_BUDGET_DEFAULTS, ...budgetOverrides };
  const integration = createMemoryIntegration({
    root: directory, instructions: INSTRUCTIONS,
    model: { provider: "faux", modelId: "faux-1" },
    contextWindow: 128_000, budget, reserveTokens: 16_384, timezone: "UTC",
    log: () => {},
  });
  const registry = createToolRegistry();
  for (const extension of integration.extensions()) registry.install(extension);
  registry.install(defineExtension({ name: "mem08-measure-tools", tools: [noteLookup] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
    models, registry,
    settings: { toolExecution: "sequential", compaction: integration.compactionSettings() },
  }, context);
  const root = await harness.root(context);
  await root.configure({ model: { provider: "faux", modelId: "faux-1" }, cwd: workspace, instructions: INSTRUCTIONS }, context);
  integration.attach(harness, root);
  await integration.initialize(context);
  harness.resume();
  const fixture = { directory, faux, integration, harness, root, calls, toolArmed: false };
  return fixture;
}

async function drive(fixture, id, text) {
  const started = performance.now();
  const prepared = await fixture.integration.prepareRequest({ requestId: id, text }, context);
  const submission = await fixture.root.submit({ type: "input", content: text, requestId: id }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done") throw new Error(`request ${id} settled ${settled.status}`);
  if (prepared.kind !== "replay") await fixture.integration.afterRequest(id, context);
  return performance.now() - started;
}

async function quiesce(fixture, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tasks = await fixture.harness.commit(async (tx) => (await tx.scanTasks({ conversationId: fixture.root.id }, 200)).items, context);
    if (tasks.every((task) => task.state.status === "terminal")) return;
    if (Date.now() > deadline) throw new Error("quiesce timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10;
  return { count: latencies.length, meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 10) / 10, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: pick(1) };
}

async function snapshotSizes(fixture) {
  const page = await fixture.root.entries({ order: "ascending" }, 2_000, undefined, context);
  const sizes = [];
  for (const entry of page.items) {
    if (entry.kind !== "pi.compaction") continue;
    const snapshot = publishedSnapshot(entry);
    if (snapshot) sizes.push({ cycleId: snapshot.cycleId, renderedBytes: Buffer.byteLength(JSON.stringify(snapshot)), baselineRevision: snapshot.baseline.revision });
  }
  return sizes;
}

const report = { environment: {}, workloads: {} };

// --- typical -----------------------------------------------------------------
{
  const fixture = await openFixture("mem08-f-typical-");
  const diskBefore = await dirBytes(fixture.directory);
  const latencies = [];
  for (let i = 1; i <= 30; i += 1) latencies.push(await drive(fixture, `f-t-${i}`, i % 3 === 0 ? LONG : "A short question about the release."));
  await quiesce(fixture);
  const archive = await readArchive(fixture.harness, fixture.root.id, context);
  const search = await searchDaily(openDaily(fixture.directory), {});
  report.workloads.typical = {
    requests: 30,
    latency: summarize(latencies),
    modelCalls: { ...fixture.calls },
    meanInputTokensPerMainCall: Math.round(fixture.calls.inputTokens / Math.max(1, fixture.calls.main)),
    snapshots: await snapshotSizes(fixture),
    archiveLagEntries: archive ? Math.max(0, (archive.target ?? 0) - (archive.archivedThrough ?? 0)) : null,
    dailyScan: { filesScanned: search.scanned.files.length, hits: search.hits.length, available: search.available },
    diskGrowthBytes: (await dirBytes(fixture.directory)) - diskBefore,
    turns: await readCompactionTurnCount(fixture.harness, fixture.root.id, context),
  };
  fixture.integration.close();
  await fixture.harness.close(context);
  var typicalDir = fixture.directory;
}

// --- tool-dense ---------------------------------------------------------------
{
  const fixture = await openFixture("mem08-f-tools-");
  const diskBefore = await dirBytes(fixture.directory);
  const latencies = [];
  const mainCallsPerRequest = [];
  for (let i = 1; i <= 12; i += 1) {
    fixture.toolArmed = true;
    const callsBefore = fixture.calls.main;
    latencies.push(await drive(fixture, `f-x-${i}`, "Check the deploy note, fixing whatever the lookup needs."));
    mainCallsPerRequest.push(fixture.calls.main - callsBefore);
  }
  await quiesce(fixture);
  report.workloads.toolDense = {
    requests: 12,
    modelCallsPerRequest: mainCallsPerRequest,
    toolExecutionsPerRequest: 2,
    latency: summarize(latencies),
    modelCalls: { ...fixture.calls },
    meanInputTokensPerMainCall: Math.round(fixture.calls.inputTokens / Math.max(1, fixture.calls.main)),
    diskGrowthBytes: (await dirBytes(fixture.directory)) - diskBefore,
    turns: await readCompactionTurnCount(fixture.harness, fixture.root.id, context),
  };
  fixture.integration.close();
  await fixture.harness.close(context);
  var toolsDir = fixture.directory;
}

// --- cross-day recovery ---------------------------------------------------------
{
  const budget = { evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 };
  const fixture = await openFixture("mem08-f-days-", budget);
  const days = [Date.parse("2026-10-24T09:00:00Z"), Date.parse("2026-10-25T09:00:00Z"), Date.parse("2026-10-26T09:00:00Z")];
  await fixture.harness.commit(async (tx) => {
    for (const [index, dayTs] of days.entries()) {
      await tx.appendEntry(fixture.root.id, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: `Day ${index + 1}: drafted the release checklist.` }], timestamp: dayTs }] });
      await tx.appendEntry(fixture.root.id, { kind: "pi.assistant", model: [fauxAssistantMessage(`Day ${index + 1}: checklist noted.`, { timestamp: dayTs + 60_000 })] });
    }
  }, context);
  for (let i = 1; i <= 12; i += 1) await drive(fixture, `f-d-${i}`, LONG);
  await quiesce(fixture);
  const snapshots = await snapshotSizes(fixture);
  const archiveBefore = await readArchive(fixture.harness, fixture.root.id, context);
  const diskBuilt = await dirBytes(fixture.directory);
  fixture.integration.close();
  await fixture.harness.close(context);

  const reopenStarted = performance.now();
  const reopened = await openFixture("mem08-f-days-", budget, fixture.directory);
  const reopenMs = performance.now() - reopenStarted;
  const firstLatency = await drive(reopened, "f-d-13", "First question after the restart.");
  await quiesce(reopened);
  const archiveAfter = await readArchive(reopened.harness, reopened.root.id, context);
  const search = await searchDaily(openDaily(reopened.directory), {});
  report.workloads.crossDayRecovery = {
    buildRequests: 12,
    snapshots,
    reopenMs: Math.round(reopenMs * 10) / 10,
    firstRequestAfterReopen: summarize([firstLatency]),
    archiveLagEntriesBeforeReopen: archiveBefore ? Math.max(0, (archiveBefore.target ?? 0) - (archiveBefore.archivedThrough ?? 0)) : null,
    archiveLagEntriesAfterRecovery: archiveAfter ? Math.max(0, (archiveAfter.target ?? 0) - (archiveAfter.archivedThrough ?? 0)) : null,
    archivedThrough: archiveAfter?.archivedThrough ?? null,
    dailyScan: { filesScanned: search.scanned.files.length, hits: search.hits.length, available: search.available, dates: [...new Set(search.hits.map((h) => h.segment.date))].sort() },
    builtDiskBytes: diskBuilt,
    turns: await readCompactionTurnCount(reopened.harness, reopened.root.id, context),
  };
  reopened.integration.close();
  await reopened.harness.close(context);
  var daysDir = reopened.directory;
}

clearInterval(sampler);
try {
  const status = await readFile("/proc/self/status", "utf8");
  const hwm = /VmHWM:\s+(\d+) kB/.exec(status);
  if (hwm) peakRss = Math.max(peakRss, Number(hwm[1]) * 1024);
} catch { /* ignore */ }
report.environment = {
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  cpus: (await import("node:os")).cpus().length,
  peakRssBytes: peakRss,
};
console.log(JSON.stringify(report, null, 2));
await rm(typicalDir, { recursive: true, force: true });
await rm(toolsDir, { recursive: true, force: true });
await rm(daysDir, { recursive: true, force: true });
