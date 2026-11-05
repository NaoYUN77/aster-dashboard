// Exit around the one backend commit containing both native modelTools and its ledger.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, defineTool, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { withToolLedger } from "../../src/tool-ledger.js";
import { createToolRegistry } from "../../src/tools.js";

const [database, window] = process.argv.slice(2);
if (!database || (window !== "before" && window !== "after")) throw new Error("Usage: crash-tool-load <database> <before|after>");
const context = BACKGROUND_CONTEXT;
const registry = createToolRegistry([]);
registry.install({ name: "deferred", tools: [defineTool({
  name: "alpha", description: "alpha unique lookup", parameters: Type.Object({}), deferred: true,
  replay: "safe", execute: async () => ({ output: [] }),
})] });
registry.install(createToolSearchExtension());
const raw = await openNodeSqliteStorage(database);
const storage = new Proxy(raw, {
  get(target, property) {
    if (property === "commit") return async (writes: readonly StorageWrite[], callContext: typeof context) => {
      const append = writes.some((write) => write.type === "document.change" && write.content.kind === "base" && write.content.value.sequence === 1);
      if (append && window === "before") process.exit(23);
      const seq = await target.commit(writes, callContext);
      if (append && window === "after") process.exit(23);
      return seq;
    };
    const member = Reflect.get(target, property, target);
    return typeof member === "function" ? member.bind(target) : member;
  },
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall("tool_search", { query: "alpha", limit: 1 }), { stopReason: "toolUse" })]);
const harness = await Harness.open(await withToolLedger(storage, registry, context), { registry, models }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
await (await root.submit({ type: "input", content: "load alpha", requestId: "crash-load" }, context)).wait(context);
throw new Error("The append crash barrier was not reached");
