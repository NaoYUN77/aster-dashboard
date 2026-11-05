// crash-archive <directory> <boundary>: IPC marks an exact window; the parent kills this process.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { createArchiveTask, initializeArchive, requestArchive } from "../../src/memory/archive-task.js";
import { openDaily } from "../../src/memory/daily.js";

const [directory, stopAt] = process.argv.slice(2);
if (!directory || !stopAt) throw new Error("Missing archive fixture arguments");
const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
const faux = fauxProvider({ provider: "faux" });
const models = createModels();
models.setProvider(faux.provider);
const task = createArchiveTask({ store: openDaily(directory), model, boundary: async (name) => {
  if (name !== stopAt) return;
  process.send?.({ boundary: name });
  await new Promise(() => {});
} });
const registry = createRegistry();
registry.install({ name: "archive", tasks: [task] });
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models, registry }, context);
const root = await harness.root(context, { agent: { model } });
await initializeArchive(harness, root.id, null, "UTC", context);
const ids = await harness.commit(async (tx) => {
  const result = [];
  for (const timestamp of [Date.parse("2026-10-24T12:00Z"), Date.parse("2026-10-25T12:00Z")]) {
    result.push((await tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "original", timestamp }] })).id);
  }
  return result;
}, context);
faux.setResponses([() => {
  appendFileSync(join(directory, "model-attempts.txt"), "call\n");
  return fauxAssistantMessage(JSON.stringify({ segments: ids.map((id) => ({ sourceEntryId: id,
    kind: "result", status: "confirmed", text: `saved body ${id}`, supersedes: [] })) }));
}]);
await requestArchive(harness, root.id, ids.at(-1)!, task, context);
harness.resume();
