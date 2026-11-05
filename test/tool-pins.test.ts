import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { defineTool, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { readResidentTools, readToolCatalog, readToolLedger } from "../src/tool-ledger.js";
import { installMcpTools } from "../src/tool-pins.js";
import { createToolRegistry, personalTools, type GovernedTool } from "../src/tools.js";

const context = BACKGROUND_CONTEXT;
const mcpTool = (name: string): GovernedTool => Object.assign(defineTool({
  name, description: name, parameters: Type.Object({}), deferred: true,
  execute: async () => ({ output: [] }),
}), { governance: { source: { kind: "mcp" as const, server: "s" }, trust: "untrusted" as const, authz: "write" as const } });

test("pin validation counts the full resident declaration set and accepts the exact budget", () => {
  const alpha = mcpTool("mcp__s__alpha");
  const beta = mcpTool("mcp__s__beta");
  const base = createToolRegistry([personalTools, createToolSearchExtension()]);
  const budget = estimateTextTokens(JSON.stringify([...base.snapshot().tools().map(({ tool }) => tool), alpha].map(toToolDeclaration)));
  const extensions = [{ name: "mcp-server-s", tools: [beta, alpha] }, createToolSearchExtension()];
  const logs: string[] = [];
  const registry = createToolRegistry([personalTools]);
  const pins = installMcpTools(registry, extensions, { tools: {
    mcp__s__beta: { pin: true }, mcp__s__alpha: { pin: true }, mcp__s__missing: { pin: true },
  }, residentToolBudgetTokens: budget }, (line) => logs.push(line));
  assert.deepEqual(pins, [alpha.name]);
  assert.equal(registry.lookup(alpha.name)?.tier, 1);
  assert.equal(registry.lookup(beta.name)?.tier, 2);
  assert.match(logs.join("\n"), /mcp__s__beta rejected \(TOOL_BUDGET_EXCEEDED/);
  assert.match(logs.join("\n"), /mcp__s__missing rejected \(TOOL_NOT_FOUND/);
  const tiny = createToolRegistry([personalTools]);
  installMcpTools(tiny, extensions, { tools: { [alpha.name]: { pin: true } }, residentToolBudgetTokens: budget - 1 }, () => {});
  assert.equal(tiny.lookup(alpha.name)?.tier, 2, "base tools count against the budget");
  const down = createToolRegistry([personalTools]);
  down.setMcpAvailability("s", "unavailable");
  installMcpTools(down, extensions, { tools: { [alpha.name]: { pin: true } } }, (line) => logs.push(line));
  assert.equal(down.lookup(alpha.name)?.tier, 2);
  assert.match(logs.join("\n"), /mcp__s__alpha rejected \(TOOL_UNAVAILABLE/);
});

test("resident MCP order is stable across config and discovery order", () => {
  const offered = (reverse: boolean) => {
    const registry = createToolRegistry([personalTools]);
    const tools = [mcpTool("mcp__s__alpha"), mcpTool("mcp__s__beta")];
    installMcpTools(registry, [{ name: "mcp-server-s", tools: reverse ? tools.reverse() : tools }], {
      tools: Object.fromEntries((reverse ? ["beta", "alpha"] : ["alpha", "beta"]).map((name) => [`mcp__s__${name}`, { pin: true }])),
    }, () => {});
    return registry.snapshot().tools().map(({ tool }) => tool).filter((tool) => !tool.deferred).map(toToolDeclaration);
  };
  assert.deepEqual(offered(false), offered(true));
});

function models() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

async function ledger(storage: Storage) {
  const page = await storage.scanConversations({}, 10, undefined, context);
  return readToolLedger(storage, page.items[0]!.id, context);
}

test("production startup keeps declaration order when server configuration order changes", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-pin-order-"));
  const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }), memory: readMemoryConfig({ MEMORY_ENABLED: "0" }) };
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let storage: Storage | undefined;
  let declarations: string | undefined;
  try {
    for (const names of [["b", "a"], ["a", "b"]]) {
      await writeFile(join(directory, "mcp.json"), JSON.stringify({
        servers: names.map((name) => ({ name, transport: "stdio", command: process.execPath,
          args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")] })),
        tools: { mcp__a__echo: { pin: true }, mcp__b__echo: { pin: true } },
      }));
      const current = models();
      current.faux.setResponses([(transcript) => {
        const tools = getCurrentTools(transcript.messages);
        assert.deepEqual(tools.filter(({ name }) => name.startsWith("mcp__")).map(({ name }) => name), ["mcp__a__echo", "mcp__b__echo"]);
        const bytes = JSON.stringify(tools);
        if (declarations !== undefined) assert.equal(bytes, declarations);
        declarations = bytes;
        return fauxAssistantMessage("stable");
      }]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config, current.models, storage);
      assert.equal((await ledger(storage))?.epoch, 1);
      assert.equal(await app.reply({ requestId: `telegram:order:${names.join("")}`, conversationId: "test", senderId: "1", text: "hello" }, new AbortController().signal), "stable");
      await app.close(); app = undefined; storage = undefined;
    }
  } finally {
    if (app) await app.close(); else await storage?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("pin changes preserve a committed memory projection whose input was not admitted", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-pin-memory-"));
  const raw = { servers: [{ name: "s", transport: "stdio", command: process.execPath,
    args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")] }], tools: { mcp__s__echo: { pin: false } } };
  const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }), memory: readMemoryConfig({}) };
  const request = { requestId: "telegram:pin:projection", conversationId: "test", senderId: "1", text: "hello" };
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let storage: Storage | undefined;
  try {
    await writeFile(join(directory, "mcp.json"), JSON.stringify(raw));
    const initial = models();
    const backend = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    storage = new Proxy(backend, {
      get(target, property) {
        if (property === "commit") return async (writes: readonly StorageWrite[], callContext: typeof context) => {
          if (writes.some((write) => write.type === "submission" && write.value.type === "input" && write.value.requestId === request.requestId)) {
            throw new Error("stop before input admission");
          }
          return target.commit(writes, callContext);
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    app = await openAgent(config, initial.models, storage);
    await assert.rejects(app.reply(request, new AbortController().signal), { code: "AGENT_SESSION_FAILED" });
    assert.equal(initial.faux.state.callCount, 0);
    await app.close(); app = undefined; storage = undefined;
    raw.tools.mcp__s__echo.pin = true;
    await writeFile(join(directory, "mcp.json"), JSON.stringify(raw));

    const recovered = models();
    recovered.faux.setResponses([(transcript) => {
      assert.match(JSON.stringify(transcript.messages), /<cycle-snapshot>/);
      assert.ok(!getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"));
      return fauxAssistantMessage("projection recovered");
    }]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, recovered.models, storage);
    assert.equal(recovered.faux.state.callCount, 0);
    assert.equal((await ledger(storage))?.epoch, 0);
    assert.equal(await app.reply(request, new AbortController().signal), "projection recovered");
    const page = await storage.scanConversations({}, 10, undefined, context);
    const entries = await storage.scanEntries({ conversationId: page.items[0]!.id }, 100, undefined, context);
    assert.equal(entries.items.filter(({ kind }) => kind === "personal.cycle").length, 1, "the original projection is reused without recomputing");
    await app.close(); app = undefined; storage = undefined;

    const settled = models();
    settled.faux.setResponses([(transcript) => {
      assert.match(JSON.stringify(transcript.messages), /<cycle-snapshot>/);
      assert.ok(getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"));
      return fauxAssistantMessage("pin settled");
    }]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, settled.models, storage);
    assert.equal((await ledger(storage))?.epoch, 1);
    assert.equal(await app.reply({ ...request, requestId: "telegram:pin:after-projection" }, new AbortController().signal), "pin settled");
  } finally {
    if (app) await app.close(); else await storage?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("unchanged pins persist the resident catalog without advancing the declaration epoch", { timeout: 30_000 }, async () => {
  for (const enabled of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "tool-pin-catalog-"));
    const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }),
      memory: readMemoryConfig({ MEMORY_ENABLED: enabled ? "1" : "0" }) };
    let app: Awaited<ReturnType<typeof openAgent>> | undefined;
    let storage: Storage | undefined;
    try {
      await writeFile(join(directory, "mcp.json"), JSON.stringify({ servers: [{ name: "s", transport: "stdio", command: process.execPath,
        args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")] }], tools: { mcp__s__echo: { pin: true } } }));
      const first = models();
      first.faux.setResponses([fauxAssistantMessage("done")]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config, first.models, storage);
      await app.reply({ requestId: "telegram:catalog:1", conversationId: "test", senderId: "1", text: "hello" }, new AbortController().signal);
      const before = await ledger(storage);
      assert.equal((await readToolCatalog(storage, context)).find(({ name }) => name === "mcp__s__echo")?.tier, 1);
      const page = await storage.scanConversations({}, 10, undefined, context);
      const entries = await storage.scanEntries({ conversationId: page.items[0]!.id }, 100, undefined, context);
      await app.close(); app = undefined; storage = undefined;

      const second = models();
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config, second.models, storage);
      assert.equal(second.faux.state.callCount, 0, "startup does not schedule a model call");
      assert.equal((await readToolCatalog(storage, context)).find(({ name }) => name === "mcp__s__echo")?.tier, 1);
      assert.deepEqual(await ledger(storage), before, "catalog synchronization does not change epoch or loads");
      assert.deepEqual((await storage.scanEntries({ conversationId: page.items[0]!.id }, 100, undefined, context)).items, entries.items);
      await app.close(); app = undefined; storage = undefined;
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      assert.equal((await readToolCatalog(storage, context)).find(({ name }) => name === "mcp__s__echo")?.tier, 1, "the catalog remains correct on disk after close");
    } finally {
      if (app) await app.close(); else await storage?.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("startup reconciles a published compaction before considering a pin boundary", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-pin-archive-"));
  const raw = { servers: [{ name: "s", transport: "stdio", command: process.execPath,
    args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")] }], tools: { mcp__s__echo: { pin: false } } };
  const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }),
    memory: readMemoryConfig({ MEMORY_RECENT_VERBATIM_TOKENS: "512", MEMORY_EVALUATE_AFTER_USER_TURNS: "1" }) };
  const gate = Promise.withResolvers<void>();
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let storage: Storage | undefined;
  try {
    await writeFile(join(directory, "mcp.json"), JSON.stringify(raw));
    const started = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const initial = models();
    initial.faux.setResponses([fauxAssistantMessage("B".repeat(3_500)), async () => {
      started.resolve();
      await gate.promise;
      return fauxAssistantMessage("A useful continuity summary.");
    }]);
    const backend = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    storage = new Proxy(backend, {
      get(target, property) {
        if (property === "commit") return async (writes: readonly StorageWrite[], callContext: typeof context) => {
          const seq = await target.commit(writes, callContext);
          if (writes.some((write) => write.type === "task" && write.value.kind === "pi.compaction"
            && write.value.state.status === "terminal" && write.value.state.outcome?.status === "completed")) published.resolve();
          return seq;
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    app = await openAgent(config, initial.models, storage);
    await app.reply({ requestId: "telegram:archive:1", conversationId: "test", senderId: "1", text: "A".repeat(3_500) }, new AbortController().signal);
    await started.promise;
    gate.resolve();
    await published.promise;
    const page = await storage.scanConversations({}, 10, undefined, context);
    const id = page.items[0]!.id;
    const address = { kind: "personal.archive", scope: { kind: "conversation" as const, conversationId: id } };
    const archiveBefore = await storage.findDocument(address, "current", context);
    assert.equal((await storage.document(archiveBefore!.id, "current", context))?.value.target, null, "the completed compaction has not been reconciled yet");
    const before = await ledger(storage);
    const entries = await storage.scanEntries({ conversationId: id }, 100, undefined, context);
    const compaction = entries.items.findLast(({ kind }) => kind === "pi.compaction");
    assert.ok(compaction?.head);
    const cutoff = entries.items.findLast(({ id }) => id < compaction.head!)!.id;
    await app.close(); app = undefined; storage = undefined;

    raw.tools.mcp__s__echo.pin = true;
    await writeFile(join(directory, "mcp.json"), JSON.stringify(raw));
    const recovered = models();
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, recovered.models, storage);
    const archiveAfter = await storage.findDocument(address, "current", context);
    const archive = (await storage.document(archiveAfter!.id, "current", context))!.value;
    assert.equal(typeof archive.target, "number");
    assert.ok((archive.target as number) >= cutoff, "published compaction coverage is persisted before changing the head");
    assert.equal(typeof archive.activeTask, "number", "the archive is scheduled from the published coverage");
    assert.equal(recovered.faux.state.callCount, 0, "startup keeps the archive task paused");
    assert.deepEqual(await ledger(storage), before, "new archive work defers pin settlement");
    assert.deepEqual(await readResidentTools(storage, id, context), []);
    assert.ok(!(await storage.scanEntries({ conversationId: id }, 100, undefined, context)).items.some(({ kind }) => kind === "pi.reset"));
  } finally {
    gate.resolve();
    if (app) await app.close(); else await storage?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("pin changes wait through recovery and preserve loaded tools and their sequences", { timeout: 30_000 }, async () => {
  for (const priorPin of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "tool-pin-recovery-"));
    const path = join(directory, "mcp.json");
    const raw = { servers: [{ name: "s", transport: "stdio", command: process.execPath,
      args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")] }],
      tools: { mcp__s__echo: { pin: priorPin } }, residentToolBudgetTokens: 8_192 };
    const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }), memory: readMemoryConfig({ MEMORY_ENABLED: "0" }) };
    const request = { requestId: "telegram:pin:recover", conversationId: "test", senderId: "1", text: "load env" };
    let app: Awaited<ReturnType<typeof openAgent>> | undefined;
    let storage: Storage | undefined;
    try {
      await writeFile(path, JSON.stringify(raw));
      const first = models();
      const started = Promise.withResolvers<void>();
      let declarations: string;
      first.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("tool_search", { query: "env", limit: 1 }), { stopReason: "toolUse" }),
        async (transcript, options) => {
          declarations = JSON.stringify(getCurrentTools(transcript.messages));
          started.resolve();
          await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      ]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config, first.models, storage);
      const shutdown = new AbortController();
      const pending = assert.rejects(app.reply(request, shutdown.signal));
      await started.promise;
      const before = await ledger(storage);
      assert.equal(before?.sequence, 1);
      shutdown.abort(); await pending;
      await app.close(); app = undefined; storage = undefined;
      raw.tools.mcp__s__echo.pin = !priorPin;
      raw.residentToolBudgetTokens = priorPin ? 1 : 8_192;
      await writeFile(path, JSON.stringify(raw));

      const second = models();
      second.faux.setResponses([(transcript) => {
        assert.equal(JSON.stringify(getCurrentTools(transcript.messages)), declarations, "recovery retains original declaration bytes and order");
        return fauxAssistantMessage("recovered");
      }]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config, second.models, storage);
      assert.equal(second.faux.state.callCount, 0, "startup keeps recovered tasks paused");
      const page = await storage.scanConversations({}, 10, undefined, context);
      assert.deepEqual(await readResidentTools(storage, page.items[0]!.id, context), priorPin ? ["mcp__s__echo"] : []);
      assert.deepEqual(await ledger(storage), before);
      assert.equal(await app.reply(request, new AbortController().signal), "recovered");
      assert.deepEqual(await ledger(storage), before);
      await app.close(); app = undefined; storage = undefined;

      const third = models();
      third.faux.setResponses([(transcript) => {
        assert.equal(getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"), !priorPin);
        return fauxAssistantMessage("settled");
      }]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config, third.models, storage);
      const after = await ledger(storage);
      assert.equal(after?.epoch, before!.epoch + 1);
      assert.equal(after?.sequence, before!.sequence);
      assert.deepEqual(after?.loads, before!.loads, "pin settlement never rewrites prior load snapshots");
      assert.equal(await app.reply({ ...request, requestId: "telegram:pin:next" }, new AbortController().signal), "settled");
    } finally {
      if (app) await app.close(); else await storage?.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("file pins settle on idle restart, allow direct calls and leave the active cycle unchanged", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-pins-"));
  const path = join(directory, "mcp.json");
  const raw = { servers: [{ name: "s", transport: "stdio", command: process.execPath,
    args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")] }], tools: { mcp__s__echo: { pin: false } } };
  const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }), memory: readMemoryConfig({ MEMORY_ENABLED: "0" }) };
  const request = (id: number) => ({ requestId: `telegram:pin:${id}`, conversationId: "test", senderId: "1", text: "echo" });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let storage: Storage | undefined;
  try {
    await writeFile(path, JSON.stringify(raw));
    const first = models();
    let prefix: string;
    first.faux.setResponses([
      (transcript) => {
        prefix = JSON.stringify(transcript.messages);
        assert.ok(!getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"));
        return fauxAssistantMessage("before");
      },
      (transcript) => {
        assert.ok(JSON.stringify(transcript.messages).startsWith(prefix.slice(0, -1)));
        assert.ok(!getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"));
        return fauxAssistantMessage("still deferred");
      },
    ]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, first.models, storage);
    assert.equal(await app.reply(request(1), new AbortController().signal), "before");
    raw.tools.mcp__s__echo.pin = true;
    await writeFile(path, JSON.stringify(raw));
    assert.equal(await app.reply(request(2), new AbortController().signal), "still deferred");
    assert.equal((await ledger(storage))?.epoch, 0);
    await app.close(); app = undefined; storage = undefined;

    const second = models();
    second.faux.setResponses([
      (transcript) => {
        assert.ok(getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"));
        assert.ok(!transcript.messages.some((message) => message.role === "assistant"), "pin change creates a context boundary");
        return fauxAssistantMessage(fauxToolCall("mcp__s__echo", { text: "direct" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const result = transcript.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && !result.isError);
        assert.match(JSON.stringify(result.content), /direct/);
        return fauxAssistantMessage("pinned");
      },
    ]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, second.models, storage);
    assert.deepEqual(await ledger(storage), { sequence: 0, epoch: 1, loads: [] });
    assert.equal((await readToolCatalog(storage, context)).find(({ name }) => name === "mcp__s__echo")?.tier, 1);
    assert.equal(await app.reply(request(3), new AbortController().signal), "pinned");
    assert.equal(await app.reply(request(1), new AbortController().signal), "before", "completed requests replay across pin boundary");
    await app.close(); app = undefined; storage = undefined;

    const third = models();
    third.faux.setResponses([fauxAssistantMessage("same pins")]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, third.models, storage);
    assert.deepEqual(await ledger(storage), { sequence: 0, epoch: 1, loads: [] }, "unchanged pin set does not advance epoch");
    assert.equal(await app.reply(request(4), new AbortController().signal), "same pins");
    await app.close(); app = undefined; storage = undefined;

    raw.tools.mcp__s__echo.pin = false;
    await writeFile(path, JSON.stringify(raw));
    const fourth = models();
    fourth.faux.setResponses([(transcript) => {
      assert.ok(!getCurrentTools(transcript.messages).some(({ name }) => name === "mcp__s__echo"));
      return fauxAssistantMessage("unpin");
    }]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config, fourth.models, storage);
    assert.deepEqual(await ledger(storage), { sequence: 0, epoch: 2, loads: [] });
    assert.equal(await app.reply(request(5), new AbortController().signal), "unpin");
  } finally {
    if (app) await app.close(); else await storage?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
