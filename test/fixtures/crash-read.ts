// Child process fixture: records a model-issued `read` call, then blocks inside it until the
// parent kills the process. The durable tool task stays unfinished, as after an upgrade crash.
import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [database, startedFile] = process.argv.slice(2);
if (!database || !startedFile) {
  throw new Error("Usage: crash-read <database> <started-marker>");
}
const context = BACKGROUND_CONTEXT;

const blockingRead = defineTool({
  name: "read",
  description: "Record one call, then block.",
  parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
  execute: async () => {
    appendFileSync(startedFile, "started\n");
    await new Promise(() => {});
    return { output: [{ type: "text", text: "unreachable" }] };
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "crash-read", tools: [blockingRead] }));
const faux = fauxProvider({ provider: "openai" });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt" }, { id: "old-read" }), { stopReason: "toolUse" }),
]);

const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "faux-1" } } });
harness.resume();
await root.submit({ type: "input", content: "Read the probe.", requestId: "crash-read-request" }, context);
await new Promise(() => {});
