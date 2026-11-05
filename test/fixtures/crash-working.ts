// Child process fixture for 02-B: run one `working_update` to the point where its commit is durable
// but its tool result is not, then block until the parent kills the process.
//
//   crash-working.ts <database> <started-marker>
//
// The update tool is wrapped so each attempt is recorded before it commits and the marker is written
// after the commit, before the result: the document, the anchor entry and the receipt are durable,
// the tool result is not. Killing here is exactly the "Document committed, tool result not
// committed" window. The runs file shows whether the recovered process executed the tool again.
import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readWorkingReceipt } from "../../src/memory/working.js";
import { workingTools } from "../../src/memory/working-tools.js";

const [database, startedFile] = process.argv.slice(2);
if (!database || !startedFile) throw new Error("Usage: crash-working <database> <started-marker>");

const context = BACKGROUND_CONTEXT;
const agent = { model: { provider: "faux", modelId: "faux-1" } };

const update = workingTools().find((tool) => tool.name === "working_update");
if (update === undefined) throw new Error("working_update is missing");
const commitThenBlock: typeof update = {
  ...update,
  execute: async (args, api, ctx) => {
    appendFileSync(`${startedFile}.runs`, "run\n");
    const result = await update.execute(args, api, ctx);
    // The commit is durable; the result is not. Report what was committed, then block until killed.
    const receipt = await readWorkingReceipt(api, api.conversationId, `tool:${api.taskId}`, ctx);
    appendFileSync(startedFile, `${JSON.stringify(receipt)}\n`);
    await new Promise(() => {});
    return result;
  },
};

const registry = createRegistry();
registry.install({ name: "working-crash", tools: [commitThenBlock] });
const faux = fauxProvider({ provider: "faux" });
const models = createModels();
models.setProvider(faux.provider);

const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
const root = await harness.root(context, { agent });
harness.resume();

const user = await harness.commit(
  async (tx) => (await tx.appendEntry(root.id, {
    kind: "pi.user",
    model: [{ role: "user", content: [{ type: "text", text: "Track this task." }], timestamp: 1 }],
  })).id,
  context,
);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("working_update", {
    expectedRevision: 1,
    evidence: [user],
    changes: [{
      op: "task.set",
      task: {
        status: "active",
        goal: "Ship the fix",
        scope: null,
        constraints: ["keep the diff small"],
        progress: [],
        blockers: [],
        nextStep: null,
        notes: null,
      },
    }],
  }, { id: "update" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("Task tracked."),
]);
await root.submit({ type: "input", content: "Track this task.", requestId: "crash-working" }, context);
await new Promise(() => {});
