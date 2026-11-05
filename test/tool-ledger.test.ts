import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, Harness, MemoryStorage, ResetEntry, defineTool, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { readResidentTools, readToolCatalog, readToolLedger, withToolLedger } from "../src/tool-ledger.js";
import { createToolRegistry } from "../src/tools.js";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
const deferred = (name: string) => defineTool({
  name, description: `${name} unique lookup`, parameters: Type.Object({}), deferred: true,
  replay: "safe", execute: async () => ({ output: [{ type: "text", text: name }] }),
});
function offered(messages: readonly Message[]): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return [...names];
}
const selected = (...names: string[]) => ({ add: names.map((name) => deferred(name)) });
function fixture() {
  const registry = createToolRegistry([]);
  registry.install({ name: "deferred", tools: [deferred("alpha"), deferred("beta"), deferred("gamma")] });
  registry.install(createToolSearchExtension());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { registry, faux, models };
}

function observe(storage: Storage, batches: StorageWrite[][]): Storage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === "commit") return async (writes: readonly StorageWrite[], callContext: typeof context) => {
        batches.push(structuredClone([...writes]));
        return target.commit(writes, callContext);
      };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

test("native search appends persist sequence and epoch atomically, retaining declarations across reopen and reset", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-ledger-"));
  const database = join(directory, "agent.sqlite");
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const first = fixture();
    const batches: StorageWrite[][] = [];
    let storage = await withToolLedger(observe(await openNodeSqliteStorage(database), batches), first.registry, context);
    first.faux.setResponses([
      (transcript) => {
        assert.deepEqual(offered(transcript.messages), ["tool_search"]);
        return fauxAssistantMessage([
          fauxToolCall("tool_search", { query: "alpha", limit: 1 }, { id: "search-a" }),
          fauxToolCall("tool_search", { query: "beta", limit: 1 }, { id: "search-b" }),
        ], { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.deepEqual(offered(transcript.messages), ["tool_search", "alpha", "beta"]);
        return fauxAssistantMessage("loaded");
      },
    ]);
    harness = await Harness.open(storage, { registry: first.registry, models: first.models, settings: { toolExecution: "sequential" } }, context);
    const root = await harness.root(context, { agent: { model } });
    const input = { type: "input" as const, content: "load both", requestId: "load-both" };
    assert.equal((await (await root.submit(input, context)).wait(context)).status, "done");
    const loaded = await readToolLedger(storage, root.id, context);
    assert.ok(loaded);
    assert.equal(loaded.sequence, 2);
    assert.equal(loaded.epoch, 1, "one native append batch is one declaration epoch");
    assert.deepEqual(loaded.loads.map(({ name, loadSequence, epoch }) => [name, loadSequence, epoch]), [["alpha", 1, 1], ["beta", 2, 1]]);
    assert.equal(loaded.loads[0]?.registration?.schemaHash, first.registry.lookup("alpha")?.schemaHash);
    const appendBatch = batches.find((batch) => batch.some((write) => write.type === "document.change" && write.content.kind === "base" && (write.content.value.modelTools as { add?: string[] } | undefined)?.add?.includes("alpha")));
    assert.ok(appendBatch);
    assert.ok(appendBatch.some((write) => write.type === "document.change" && write.content.kind === "base" && write.content.value.sequence === 2), "native and ledger writes share a backend commit");
    await harness.close(context);
    harness = undefined;

    const second = fixture();
    storage = await withToolLedger(await openNodeSqliteStorage(database), second.registry, context);
    harness = await Harness.open(storage, { registry: second.registry, models: second.models }, context);
    const reopened = await harness.root(context);
    harness.resume();
    assert.equal((await (await reopened.submit(input, context)).wait(context)).status, "done");
    assert.equal(second.faux.state.callCount, 0);
    assert.deepEqual(await readToolLedger(storage, reopened.id, context), loaded);
    await reopened.reset(undefined, context);
    second.faux.setResponses([(transcript) => {
      assert.deepEqual(offered(transcript.messages), ["tool_search", "alpha", "beta"]);
      return fauxAssistantMessage("after reset");
    }]);
    await (await reopened.submit({ type: "input", content: "continue" }, context)).wait(context);
    assert.deepEqual(await readToolLedger(storage, reopened.id, context), loaded, "baseline redeclaration is not a load");
    await reopened.configure({ modelTools: selected("alpha", "beta") }, context);
    assert.deepEqual(await readToolLedger(storage, reopened.id, context), loaded, "equal writes do not renumber");
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("removal and reload preserve the high water mark, and forks keep their as-of ledger", { timeout: 15_000 }, async () => {
  const { registry, models } = fixture();
  const storage = await withToolLedger(new MemoryStorage(), registry, context);
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const root = await harness.root(context, { agent: { model, modelTools: selected("alpha", "beta") } });
    const at = await root.commit((tx) => tx.appendEntry(root.id, { kind: "test.point", data: {} }), context);
    await root.configure({ modelTools: selected("beta") }, context);
    await root.configure({ modelTools: selected("beta", "alpha", "gamma") }, context);
    const loaded = await readToolLedger(storage, root.id, context);
    assert.deepEqual(loaded?.loads.map(({ name, loadSequence, epoch }) => [name, loadSequence, epoch]), [["beta", 2, 1], ["alpha", 3, 2], ["gamma", 4, 2]]);
    assert.equal(loaded?.sequence, 4);
    const fork = await root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    assert.deepEqual((await readToolLedger(storage, fork.id, context))?.loads.map(({ name, loadSequence }) => [name, loadSequence]), [["alpha", 1], ["beta", 2]]);
    const augmented = await root.fork(at.id, { ownership: { kind: "ownerless" }, agent: { modelTools: selected("alpha", "beta", "gamma") } }, context);
    assert.deepEqual((await readToolLedger(storage, augmented.id, context))?.loads.map(({ name, loadSequence, epoch }) => [name, loadSequence, epoch]), [["alpha", 1, 1], ["beta", 2, 1], ["gamma", 3, 2]]);
    assert.equal((await readToolLedger(storage, root.id, context))?.sequence, 4);
    await root.configure({ modelTools: [deferred("gamma"), deferred("beta"), deferred("alpha")] }, context);
    assert.equal((await readToolLedger(storage, root.id, context))?.sequence, 4, "representation and ordering changes are not new loads");
    const explicit = await harness.createConversation({
      ownership: { kind: "ownerless" }, agent: { modelTools: [deferred("alpha"), deferred("beta")] },
    }, context);
    assert.deepEqual((await readToolLedger(storage, explicit.id, context))?.loads.map(({ name, loadSequence }) => [name, loadSequence]), [["alpha", 1], ["beta", 2]], "explicit selections get their own conversation sequence");
    registry.install({ name: "late", tools: [deferred("delta")] });
    await root.configure({ modelTools: selected("gamma", "beta", "alpha", "delta") }, context);
    assert.ok((await readToolCatalog(storage, context)).some(({ name }) => name === "delta"), "late registrations persist with the next native commit");
  } finally {
    await harness.close(context);
  }
});

test("fork reset settles pins from the staged historical ledger without losing load sequences", async () => {
  const { registry, models } = fixture();
  const storage = await withToolLedger(new MemoryStorage(), registry, context);
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const root = await harness.root(context, { agent: { model, modelTools: selected("alpha", "beta") } });
    const at = await root.commit((tx) => tx.appendEntry(root.id, { kind: "test.point", data: {} }), context);
    const before = (await readToolLedger(storage, root.id, context))!;
    await root.configure({ modelTools: selected("alpha", "beta", "gamma") }, context);
    registry.install({ name: "mcp-resident", tools: [Object.assign(defineTool({
      name: "mcp__s__echo", description: "echo", parameters: Type.Object({}), execute: async () => ({ output: [] }),
    }), { governance: { source: { kind: "mcp" as const, server: "s" }, trust: "untrusted" as const, authz: "write" as const } })] });
    for (const augmented of [false, true]) {
      const fork = await root.fork(at.id, {
        ownership: { kind: "ownerless" },
        ...(augmented ? { agent: { modelTools: selected("alpha", "beta", "gamma") } } : {}),
        init: async (tx, id) => { await tx.appendEntry(id, { kind: ResetEntry.kind, head: "self" }); },
      }, context);
      const ledger = (await readToolLedger(storage, fork.id, context))!;
      assert.equal(ledger.sequence, before.sequence + (augmented ? 1 : 0));
      assert.equal(ledger.epoch, before.epoch + (augmented ? 2 : 1));
      assert.deepEqual(ledger.loads.slice(0, 2), before.loads);
      assert.deepEqual(await readResidentTools(storage, fork.id, context), ["mcp__s__echo"]);
    }
    assert.equal((await readToolLedger(storage, root.id, context))?.sequence, 3);
    assert.deepEqual(await readResidentTools(storage, root.id, context), []);
  } finally {
    await harness.close(context);
  }
});

test("legacy SQLite migration retains missing registrations, is idempotent, and reconstructs the current catalog", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-legacy-"));
  const database = join(directory, "agent.sqlite");
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const { registry, models } = fixture();
    harness = await Harness.open(await openNodeSqliteStorage(database), { registry, models }, context);
    const root = await harness.root(context, { agent: { model } });
    await root.commit(async (tx) => {
      const state = await tx.doc(AgentDoc, root.id);
      state.modelTools = { add: ["alpha", "missing", "alpha", "beta"], remove: ["beta"] };
    }, context);
    const at = await root.commit((tx) => tx.appendEntry(root.id, { kind: "legacy.point", data: {} }), context);
    await harness.close(context);
    harness = undefined;

    let storage = await withToolLedger(await openNodeSqliteStorage(database), registry, context);
    const migrated = await readToolLedger(storage, root.id, context);
    assert.deepEqual(migrated?.loads.map(({ name, loadSequence, epoch }) => [name, loadSequence, epoch]), [["alpha", 1, 1], ["missing", 2, 1], ["beta", 3, 1]]);
    assert.equal(migrated?.loads[1]?.registration, null);
    assert.deepEqual(await readToolCatalog(storage, context), registry.records());
    harness = await Harness.open(storage, { registry, models }, context);
    const reopened = await harness.root(context);
    const historical = await reopened.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    assert.deepEqual((await readToolLedger(storage, historical.id, context))?.loads, migrated?.loads, "forks before migration receive deterministic baseline metadata");
    await reopened.configure({ modelTools: selected("alpha", "missing", "beta", "gamma") }, context);
    assert.equal((await readToolLedger(storage, root.id, context))?.loads.at(-1)?.loadSequence, 4);
    await harness.close(context);
    harness = undefined;
    registry.uninstall({ name: "deferred" });
    storage = await withToolLedger(await openNodeSqliteStorage(database), registry, context);
    assert.equal((await readToolCatalog(storage, context)).some(({ name }) => name === "alpha"), false);
    assert.equal((await readToolLedger(storage, root.id, context))?.loads[0]?.registration?.name, "alpha", "historical registration snapshots survive uninstall/restart");
    await storage.close(context);
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("failed append commits neither the agent selection nor the tool ledger", { timeout: 10_000 }, async () => {
  const { registry, models } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "tool-ledger-failed-"));
  const database = join(directory, "agent.sqlite");
  const raw = await openNodeSqliteStorage(database);
  let fail = false;
  const failing = new Proxy(raw, {
    get(target, property) {
      if (property === "commit") return async (writes: readonly StorageWrite[], callContext: typeof context) => {
        if (fail) {
          assert.ok(writes.some((write) => write.type === "document.change" && write.content.kind === "base" && write.content.value.sequence === 1));
          throw new Error("append commit failed");
        }
        return target.commit(writes, callContext);
      };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const storage = await withToolLedger(failing, registry, context);
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const root = await harness.root(context, { agent: { model } });
    fail = true;
    await assert.rejects(root.configure({ modelTools: selected("alpha") }, context));
    await harness.close(context);
    const recovered = await openNodeSqliteStorage(database);
    try {
      const ledger = await readToolLedger(recovered, root.id, context);
      assert.equal(ledger?.sequence, 0);
      assert.deepEqual(ledger?.loads, []);
      const agent = await recovered.findDocument({ kind: "pi.agent", scope: { kind: "conversation", conversationId: root.id } }, "current", context);
      assert.equal((await recovered.document(agent!.id, "current", context))?.value.modelTools, undefined);
    } finally {
      await recovered.close(context);
    }
  } finally {
    try { await harness.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

for (const window of ["before", "after"] as const) {
  test(`process exit ${window} append commit recovers one tool load without renumbering`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `tool-load-crash-${window}-`));
    const database = join(directory, "agent.sqlite");
    let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
    try {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/crash-tool-load.ts", import.meta.url)), database, window], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      const [code] = await once(child, "exit");
      assert.equal(code, 23, stderr);
      const { registry, models, faux } = fixture();
      const storage = await withToolLedger(await openNodeSqliteStorage(database), registry, context);
      harness = await Harness.open(storage, { registry, models }, context);
      const root = await harness.root(context);
      assert.equal((await readToolLedger(storage, root.id, context))?.sequence, window === "before" ? 0 : 1);
      faux.setResponses([(transcript) => {
        assert.deepEqual(offered(transcript.messages), ["tool_search", "alpha"]);
        return fauxAssistantMessage("recovered");
      }]);
      harness.resume();
      assert.equal((await (await root.submit({ type: "input", content: "load alpha", requestId: "crash-load" }, context)).wait(context)).status, "done");
      const ledger = await readToolLedger(storage, root.id, context);
      assert.equal(ledger?.sequence, 1);
      assert.equal(ledger?.epoch, 1);
      assert.equal(ledger?.loads[0]?.name, "alpha");
      assert.equal(faux.state.callCount, 1, "recovery reuses the durable search result");
    } finally {
      try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
}

test("openAgent persists tool governance on the production storage path", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-tool-ledger-"));
  try {
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("done")]);
    const app = await openAgent(readConfig({
      TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai", MODEL_ID: "faux-1",
      OPENAI_API_KEY: "test", DATA_DIR: directory,
    }), models);
    try {
      assert.equal(await app.reply({ requestId: "telegram:tools:1", conversationId: "test", senderId: "1", text: "hello" }, new AbortController().signal), "done");
    } finally {
      await app.close();
    }
    const storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    try {
      assert.ok((await readToolCatalog(storage, context)).some(({ name }) => name === "current_time"));
      const conversations = await storage.scanConversations({}, 10, undefined, context);
      const ledger = await readToolLedger(storage, conversations.items[0]!.id, context);
      assert.deepEqual(ledger, { sequence: 0, epoch: 0, loads: [] });
    } finally {
      await storage.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
