// Child process fixture: starts a tool call and blocks inside it until the parent kills the process.
// The parent uses the marker files as explicit synchronization points instead of sleeping.
import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [database, startedFile, mode] = process.argv.slice(2);
if (!database || !startedFile || (mode !== "safe" && mode !== "unsafe")) {
  throw new Error("Usage: crash-tool <database> <started-marker> <safe|unsafe>");
}
const context = BACKGROUND_CONTEXT;
const runsFile = `${startedFile}.runs`;

const tool = defineTool({
  name: "side_effect",
  description: "Record one execution, then block.",
  parameters: Type.Object({}, { additionalProperties: false }),
  replay: mode === "safe" ? "safe" : "unsafe",
  execute: async () => {
    appendFileSync(runsFile, "run\n");
    appendFileSync(startedFile, "started\n");
    await new Promise(() => {});
    return { output: [{ type: "text", text: "unreachable" }] };
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "crash-tools", tools: [tool] }));
const faux = fauxProvider({ provider: "faux" });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "side" }), { stopReason: "toolUse" })]);

const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
await root.submit({ type: "input", content: "Run the side effect.", requestId: "crash-request" }, context);
await new Promise(() => {});
