import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AgentDoc, Harness, defineTool, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import type { McpHost } from "../src/mcp.js";
import { readToolCatalog, readToolLedger, withToolLedger } from "../src/tool-ledger.js";
import { installMcpTools } from "../src/tool-pins.js";
import { createToolRegistry, type GovernedTool } from "../src/tools.js";

const context = BACKGROUND_CONTEXT;
const githubName = "mcp__github__issue_read";
const request = (id: string) => ({ requestId: `telegram:github:${id}`, conversationId: "test", senderId: "1", text: "Read GitHub" });
const signal = () => new AbortController().signal;
function models() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}
function tool(approval?: string, server = "github"): GovernedTool {
  return Object.assign(defineTool({
    name: server === "github" ? githubName : "mcp__other__read", description: `Read issue approved ${approval ?? "legacy"}`,
    parameters: Type.Object({}), deferred: true, replay: "unsafe",
    execute: async () => ({ output: [{ type: "text", text: "read" }] }),
  }), { governance: { source: { kind: "mcp" as const, server }, trust: "untrusted" as const, authz: "read" as const,
    ...(approval === undefined ? {} : { githubApproval: approval }) } });
}
function host(approval?: string, present = true): McpHost {
  return { extensions: [{ name: "github", tools: present ? [tool(approval)] : [] }, createToolSearchExtension()],
    subscribeAvailability: (listener) => { listener("github", "available"); return () => {}; }, close: async () => {} };
}
function config(directory: string) {
  return { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }), memory: readMemoryConfig({ MEMORY_ENABLED: "0" }) };
}
async function rootId(storage: Storage) {
  return (await storage.scanConversations({}, 100, undefined, context)).items[0]!.id;
}

test("GitHub pins are rejected for configuration and old recovery selections; other MCP pins retain behavior", () => {
  for (const recovering of [undefined, [githubName, "mcp__other__read"]]) {
    const registry = createToolRegistry([]);
    const logs: string[] = [];
    const pins = installMcpTools(registry, [{ name: "mcp", tools: [tool("v1"), tool(undefined, "other")] }], {
      tools: { [githubName]: { pin: true }, mcp__other__read: { pin: true } },
    }, (line) => logs.push(line), recovering);
    assert.deepEqual(pins, ["mcp__other__read"]);
    assert.equal(registry.lookup(githubName)?.tier, 2);
    assert.equal(registry.lookup(githubName)?.githubApproval, "v1");
    assert.match(logs.join("\n"), /GITHUB_PIN_FORBIDDEN/);
  }
});

for (const catalogAdvanced of [false, true]) {
  test(`idle approval refresh preserves history${catalogAdvanced ? " even if catalog already advanced" : ""}`, { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-idle-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let storage: Storage | undefined;
  try {
    const first = models();
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "issue", limit: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("loaded"),
    ]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config(directory), first.models, storage, { mcp: host("v1"), toolReviewLog: () => {} });
    assert.equal(await app.reply(request("load"), signal()), "loaded");
    const id = await rootId(storage);
    const before = (await readToolLedger(storage, id, context))!;
    assert.equal(before.loads[0]?.registration?.githubApproval, "v1");
    const entries = await storage.scanEntries({ conversationId: id }, 100, undefined, context);
    const point = (await storage.entry(id, Math.max(...entries.items.map(({ id }) => id)) as typeof entries.items[number]["id"], context))!.commitSeq;
    const ledgerRecord = (await storage.findDocument({ kind: "personal.tools.loads", scope: { kind: "conversation", conversationId: id } }, "current", context))!;
    await app.close(); app = undefined; storage = undefined;

    if (catalogAdvanced) {
      // A prior partial startup may have synchronized observation metadata but not the loaded snapshot.
      storage = await withToolLedger(await openNodeSqliteStorage(join(directory, "agent.sqlite")),
        createToolRegistry([{ name: "github", tools: [tool("v2")] }]), context);
      await storage.close(context); storage = undefined;
    }
    const second = models();
    second.faux.setResponses([(transcript) => {
      const declaration = getCurrentTools(transcript.messages).find(({ name }) => name === githubName);
      assert.match(declaration?.description ?? "", /v2/);
      assert.ok(!transcript.messages.some((message) => message.role === "assistant"), "new approval starts a fresh context");
      return fauxAssistantMessage("refreshed");
    }]);
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config(directory), second.models, storage, { mcp: host("v2"), toolReviewLog: () => {} });
    const after = (await readToolLedger(storage, id, context))!;
    assert.equal(after.sequence, before.sequence);
    assert.equal(after.loads[0]?.loadSequence, before.loads[0]?.loadSequence);
    assert.equal(after.epoch, before.epoch + 1);
    assert.equal(after.loads[0]?.registration?.githubApproval, "v2");
    const historical = await storage.document(ledgerRecord.id, point, context);
    assert.equal((historical!.value.loads as Record<string, { registration: { githubApproval: string } }>)[githubName]?.registration.githubApproval, "v1");
    assert.equal((await readToolCatalog(storage, context)).find(({ name }) => name === githubName)?.githubApproval, "v2");
    assert.equal(second.faux.state.callCount, 0);
    assert.equal(await app.reply(request("refresh"), signal()), "refreshed");
    await app.close(); app = undefined; storage = undefined;

    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config(directory), models().models, storage, { mcp: host("v2") });
    assert.deepEqual(await readToolLedger(storage, id, context), after, "unchanged approval does not create another epoch");
  } finally {
    if (app) await app.close(); else await storage?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
  });
}

for (const changed of [false, true]) {
  test(`${changed ? "changed" : "unchanged"} approval with unfinished work ${changed ? "blocks before catalog overwrite" : "resumes original declarations"}`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-recovery-"));
    let app: Awaited<ReturnType<typeof openAgent>> | undefined;
    let storage: Storage | undefined;
    try {
      const first = models();
      const started = Promise.withResolvers<void>();
      first.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("tool_search", { query: "issue", limit: 1 }), { stopReason: "toolUse" }),
        async (_transcript, options) => {
          started.resolve();
          await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      ]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      app = await openAgent(config(directory), first.models, storage, { mcp: host("v1"), toolReviewLog: () => {} });
      const shutdown = new AbortController();
      const pending = assert.rejects(app.reply(request("pending"), shutdown.signal));
      await started.promise;
      const id = await rootId(storage);
      const before = await readToolLedger(storage, id, context);
      const catalog = await readToolCatalog(storage, context);
      shutdown.abort(); await pending;
      await app.close(); app = undefined; storage = undefined;

      const second = models();
      second.faux.setResponses([fauxAssistantMessage("recovered")]);
      storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
      if (changed) {
        await assert.rejects(openAgent(config(directory), second.models, storage, { mcp: host("v2") }), { code: "GITHUB_APPROVAL_RECOVERY" });
        storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
        assert.deepEqual(await readToolCatalog(storage, context), catalog, "old startup catalog is retained");
        assert.deepEqual(await readToolLedger(storage, id, context), before, "loaded snapshots are retained");
        const entries = await storage.scanEntries({ conversationId: id }, 100, undefined, context);
        assert.ok(!entries.items.some(({ kind }) => kind === "pi.reset"));
      } else {
        app = await openAgent(config(directory), second.models, storage, { mcp: host("v1") });
        assert.equal(await app.reply(request("pending"), signal()), "recovered");
        assert.deepEqual(await readToolLedger(storage, id, context), before);
      }
      assert.equal(second.faux.state.callCount, changed ? 0 : 1);
    } finally {
      if (app) await app.close(); else await storage?.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("legacy loaded GitHub declarations retain unknown approval until an idle boundary", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-legacy-"));
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let storage: Storage | undefined;
  try {
    const fixture = models();
    const registry = createToolRegistry([{ name: "github", tools: [tool()] }]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { registry, models: fixture.models }, context);
    const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "faux-1" } } });
    await root.commit(async (tx) => { (await tx.doc(AgentDoc, root.id)).modelTools = { add: [githubName] }; }, context);
    await harness.close(context); harness = undefined;
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    const nextRegistry = createToolRegistry([{ name: "github", tools: [tool("v2")] }]);
    storage = await withToolLedger(storage, nextRegistry, context, { catalogSync: () => false });
    assert.equal((await readToolLedger(storage, root.id, context))?.loads[0]?.registration, null, "migration does not invent historical approval");
    await storage.close(context); storage = undefined;
    storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
    app = await openAgent(config(directory), fixture.models, storage, { mcp: host("v2") });
    const loaded = (await readToolLedger(storage, root.id, context))!;
    assert.equal(loaded.loads[0]?.registration?.githubApproval, "v2");
    assert.equal(loaded.loads[0]?.loadSequence, 1);
    assert.equal(loaded.sequence, 1);
    assert.equal(loaded.epoch, 2);
  } finally {
    await harness?.close(context);
    if (app) await app.close(); else await storage?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
