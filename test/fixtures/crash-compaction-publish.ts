// crash-compaction-publish <directory> <attempts-file>: IPC marks the exact "summary result
// persisted, publication not yet returned" window of MEM-06; the parent kills this process there.
//
// The compaction Adapter persists its result through the injected host commit in two steps on
// the success path: (1) the summary attempt's usage accumulation, (2) the summary record itself
// ("Persist BEFORE returning", src/memory/compaction.ts). This fixture wraps the injected commit:
// once the summary model has been called, the second completed commit is exactly the persisted
// result, so the wrapper reports the boundary over IPC and blocks before returning to the hook.
// The hook therefore never returns the summary and the native machinery never appends the
// `pi.compaction` entry: the record is durable, publication has not happened. No sleeps are
// involved; the barrier is the commit itself.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCompactionExtension } from "../../src/memory/compaction.js";
import { applyWorkingUpdate } from "../../src/memory/working.js";
import { workingExtension } from "../../src/memory/working-tools.js";

const [directory, attemptsFile] = process.argv.slice(2);
if (!directory || !attemptsFile) throw new Error("Usage: crash-compaction-publish <directory> <attempts-file>");

const context = BACKGROUND_CONTEXT;
const agent = { model: { provider: "faux", modelId: "faux-1" }, instructions: "SYSTEM RULES: be concise." };
const SUMMARY_MODEL = { provider: "summary", modelId: "summary-1" };
const COMPACTION = { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 0 };

const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "faux-1", contextWindow: 1200, maxTokens: 512 }],
});
const summaryFaux = fauxProvider({ provider: "summary", models: [{ id: "summary-1" }] });
const models = createModels();
models.setProvider(faux.provider);
models.setProvider(summaryFaux.provider);

let summaryCalled = false;
summaryFaux.setResponses([() => {
  summaryCalled = true;
  appendFileSync(attemptsFile, "call\n");
  return fauxAssistantMessage("The release work continues; the tracked task and its constraints are preserved.");
}]);
faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage("Noted.")));

const registry = createRegistry();
registry.install(workingExtension);

let harness: Harness | undefined;
let commitsAfterSummary = 0;
let blocked = false;
registry.install(createCompactionExtension({
  commit: {
    commit: async (change, ctx) => {
      const result = await harness!.commit(change, ctx);
      if (summaryCalled && !blocked) {
        commitsAfterSummary += 1;
        if (commitsAfterSummary === 2) {
          blocked = true;
          process.send?.({ boundary: "summary-persisted" });
          await new Promise(() => {});
        }
      }
      return result;
    },
  },
  model: SUMMARY_MODEL,
}));

harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
  models,
  registry,
  settings: { compaction: COMPACTION },
}, context);
const root = await harness.root(context, { agent });
harness.resume();

const long = "release checklist item ".repeat(60);
async function say(requestId: string, text: string): Promise<void> {
  const submission = await root.submit({ type: "input", content: text, requestId }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done") throw new Error(`request ${requestId} did not complete: ${settled.status}`);
}

await say("seed-1", long);
// A working anchor inside the range the compaction will replace, so the adapter can pin the
// boundary revision instead of declining `not-covered`.
const entries = (await root.entries({ order: "ascending" }, 100, undefined, context)).items;
const evidence = entries.find((entry) => entry.kind === "pi.user")!.id;
await applyWorkingUpdate(harness, {
  conversationId: root.id,
  operationId: "seed-task",
  expectedRevision: 1,
  evidence: [evidence],
  changes: [{
    op: "task.set",
    task: {
      status: "active", goal: "Ship the fix", scope: null, constraints: ["keep the diff small"],
      progress: [], blockers: [], nextStep: null, notes: null,
    },
  }],
  now: 1,
}, context);
await say("seed-2", long);
await say("seed-3", long);

// Blocking compaction: the hook runs in this process. It will persist the summary result and
// then block inside the wrapped commit, before the summary can be published.
void root.compact(undefined, context).catch(() => {});
await new Promise(() => {});
