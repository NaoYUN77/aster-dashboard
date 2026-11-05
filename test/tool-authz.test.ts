import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { connectMcp, type McpConnection, type McpToolInfo } from "../src/mcp.js";
import { validateMcpConfig } from "../src/mcp-config.js";
import { createToolRegistry, type GovernedTool, type ToolAuthority } from "../src/tools.js";

const context = BACKGROUND_CONTEXT;
const lastResult = (messages: readonly Message[]) => messages.findLast((message) => message.role === "toolResult");
const code = (details: unknown) => details && typeof details === "object" && "code" in details ? details.code : undefined;
function models(provider = "faux") {
  const faux = fauxProvider({ provider });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const logs = () => {
  const events: { tool: string; code: string; authority: string; decision: string; callId: string }[] = [];
  return { events, log: (line: string) => { events.push(JSON.parse(line)); } };
};

test("MCP authz config accepts independent pin/read/write options and rejects invalid fields", () => {
  const tools = { mcp__s__one: { authz: "read" }, mcp__s__two: { pin: true, authz: "write" }, mcp__s__three: { pin: false } };
  const parsed = validateMcpConfig({ servers: [], tools });
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.config?.tools, tools);
  for (const options of [{ authz: "admin" }, { authz: null }, { authz: false }, { authz: "read", pin: null }, { authz: "read", unknown: 1 }]) {
    assert.match(validateMcpConfig({ servers: [], tools: { mcp__s__one: options } }).error ?? "", /tools/);
  }
});

test("native execution rejects exact unknown names, unavailable/disabled tools and insufficient authority before side effects", async () => {
  const audit = logs();
  const executed: string[] = [];
  const tool = (name: string, authz: "read" | "write"): GovernedTool => Object.assign(defineTool({
    name, description: name, parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    execute: async () => { executed.push(name); return { output: [{ type: "text", text: "ran" }] }; },
  }), { governance: { source: { kind: "mcp" as const, server: "s" }, trust: "untrusted" as const, authz } });
  const registry = createToolRegistry([{ name: "example", tools: [tool("query", "read"), tool("mutate", "write")] }], {
    authority: "restricted", log: audit.log,
  });
  const fixture = models();
  fixture.faux.setResponses([
    call("queri"),
    (transcript) => {
      assert.match(JSON.stringify(lastResult(transcript.messages)?.content), /Tool queri is not available/);
      assert.equal(audit.events.at(-1)?.code, "TOOL_NOT_FOUND");
      assert.equal(executed.length, 0, "unknown names never fuzzy-match query");
      return call("mutate", { value: "secret-not-in-logs" });
    },
    (transcript) => {
      assert.equal(code(lastResult(transcript.messages)?.details), "TOOL_AUTHZ_DENIED");
      assert.equal(executed.length, 0);
      registry.setMcpAvailability("s", "unavailable");
      return call("query", { value: "ok" });
    },
    (transcript) => {
      assert.equal(code(lastResult(transcript.messages)?.details), "TOOL_UNAVAILABLE");
      assert.match(JSON.stringify(lastResult(transcript.messages)?.content), /restart to reconnect/);
      assert.equal(executed.length, 0);
      registry.setDisabled("query", true);
      registry.setMcpAvailability("s", "available");
      assert.equal(registry.lookup("query")?.state, "disabled", "health recovery cannot re-enable a disabled tool");
      return call("query", { value: "ok" });
    },
    (transcript) => {
      assert.equal(code(lastResult(transcript.messages)?.details), "TOOL_DISABLED");
      assert.match(JSON.stringify(lastResult(transcript.messages)?.content), /Ask the owner to enable/);
      assert.equal(executed.length, 0);
      registry.setDisabled("query", false);
      return call("query", { value: "ok" });
    },
    (transcript) => {
      assert.equal(lastResult(transcript.messages)?.isError, false);
      assert.deepEqual(executed, ["query"]);
      return fauxAssistantMessage("done");
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: fixture.models }, context);
  try {
    const root = await harness.root(context);
    await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    const result = await (await root.submit({ type: "input", content: "exercise guards" }, context)).wait(context);
    assert.equal(result.status, "done");
    assert.deepEqual(audit.events.map(({ code }) => code), ["TOOL_NOT_FOUND", "TOOL_AUTHZ_DENIED", "TOOL_UNAVAILABLE", "TOOL_DISABLED", "TOOL_ALLOWED"]);
    assert.ok(audit.events.every(({ callId }) => typeof callId === "string"));
    assert.doesNotMatch(JSON.stringify(audit.events), /secret-not-in-logs/);
  } finally {
    await harness.close(context);
  }
});

test("builtin and nested calls use the same authority while native schema validation stays in control", async () => {
  const audit = logs();
  let writes = 0;
  const write = defineTool({ name: "mutate", description: "write", parameters: Type.Object({ value: Type.String() }),
    execute: async () => { writes++; return { output: [] }; } });
  const nested = defineTool({ name: "nested", description: "nested probe", parameters: Type.Object({}),
    execute: async (_args, api, context): Promise<ToolExecutionResult> => {
      const missing = await api.executeTool("mutat", {}, context);
      assert.ok(missing.isError);
      const denied = await api.executeTool("mutate", { value: "ok" }, context);
      assert.equal(code(denied.details), "TOOL_AUTHZ_DENIED");
      return { output: [{ type: "text", text: "nested blocked" }] };
    } });
  const registry = createToolRegistry([{ name: "builtin", tools: [write, Object.assign(nested, {
    governance: { source: { kind: "builtin" as const, extension: "builtin" }, trust: "trusted" as const, authz: "read" as const },
  })] }], { authority: "restricted", log: audit.log });
  const fixture = models();
  fixture.faux.setResponses([
    call("mutate"),
    (transcript) => {
      assert.equal(lastResult(transcript.messages)?.details, undefined);
      assert.match(JSON.stringify(lastResult(transcript.messages)?.content), /value/);
      assert.equal(audit.events.length, 0, "invalid arguments are handled before the executor");
      return call("nested");
    },
    () => fauxAssistantMessage("done"),
  ]);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: fixture.models }, context);
  try {
    const root = await harness.root(context);
    await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    assert.equal((await (await root.submit({ type: "input", content: "nested" }, context)).wait(context)).status, "done");
    assert.equal(writes, 0);
    assert.deepEqual(audit.events.map(({ tool, code }) => [tool, code]), [["nested", "TOOL_ALLOWED"], ["mutat", "TOOL_NOT_FOUND"], ["mutate", "TOOL_AUTHZ_DENIED"]]);
  } finally {
    await harness.close(context);
  }
});

test("unknown-call audit remains selected with an explicit extension list", async () => {
  const audit = logs();
  const only = defineTool({ name: "only", description: "only", parameters: Type.Object({}),
    execute: async () => ({ output: [] }) });
  const extension = { name: "only-extension", tools: [only] };
  const registry = createToolRegistry([extension], { log: audit.log });
  const fixture = models();
  fixture.faux.setResponses([call("missing"), () => fauxAssistantMessage("done")]);
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models: fixture.models, settings: { extensions: [extension] },
  }, context);
  try {
    const root = await harness.root(context);
    await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    assert.equal((await (await root.submit({ type: "input", content: "unknown" }, context)).wait(context)).status, "done");
    assert.deepEqual(audit.events.map(({ tool, code }) => [tool, code]), [["missing", "TOOL_NOT_FOUND"]]);
  } finally {
    await harness.close(context);
  }
});

test("safe execution recovery rechecks the current host authority after intent was persisted", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-authz-recovery-"));
  const database = join(directory, "agent.sqlite");
  const entered = Promise.withResolvers<void>();
  let executions = 0;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  const tool = (block: boolean) => defineTool({
    name: "safe_write", description: "host-classified write with safe retry semantics", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, _api, context) => {
      executions++;
      if (block) {
        entered.resolve();
        await awaitWithContext(new Promise<never>(() => {}), context);
      }
      return { output: [{ type: "text", text: "ran" }] };
    },
  });
  const request = { type: "input" as const, requestId: "test:authz:recover", content: "use safe_write" };
  try {
    const first = models();
    first.faux.setResponses([call("safe_write")]);
    harness = await Harness.open(await openNodeSqliteStorage(database), { models: first.models,
      registry: createToolRegistry([{ name: "tools", tools: [tool(true)] }], { log: () => {} }),
    }, context);
    const root = await harness.root(context);
    await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    await root.submit(request, context);
    await entered.promise;
    await harness.close(context); harness = undefined;
    assert.equal(executions, 1);

    const audit = logs();
    const second = models();
    second.faux.setResponses([(transcript) => {
      assert.equal(code(lastResult(transcript.messages)?.details), "TOOL_AUTHZ_DENIED");
      return fauxAssistantMessage("restricted after recovery");
    }]);
    harness = await Harness.open(await openNodeSqliteStorage(database), { models: second.models,
      registry: createToolRegistry([{ name: "tools", tools: [tool(false)] }], { authority: "restricted", log: audit.log }),
    }, context);
    harness.resume();
    const recovered = await harness.root(context);
    assert.equal((await (await recovered.submit(request, context)).wait(context)).status, "done");
    assert.equal(executions, 1, "the recovered execution must not enter the implementation");
    assert.deepEqual(audit.events.map(({ code }) => code), ["TOOL_AUTHZ_DENIED"]);
    const entries = await recovered.entries({}, 100, undefined, context);
    assert.ok(entries.items.some((entry) => ToolResultEntry.is(entry) && entry.model?.some((message) => message.role === "toolResult" && message.isError)));
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP defaults to write despite read-only annotations; only exact owner config can lower the classification", async () => {
  const info: McpToolInfo & { annotations: { readOnlyHint: boolean } } = {
    name: "query", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
  };
  for (const configured of [undefined, "read", "write"] as const) {
    const host = await connectMcp({ servers: [{ name: "s", transport: "stdio", command: "unused", args: [], env: {}, inheritEnv: false, timeoutMs: 1000, connectTimeoutMs: 1000 }],
      ...(configured ? { tools: { mcp__s__query: { authz: configured } } } : {}),
    }, { dataDir: ".", reserved: new Set(), log: () => {}, connect: async (): Promise<McpConnection> => ({
      serverName: "s", listTools: async () => [info], callTool: async () => ({ content: [] }), close: async () => {},
      subscribeAvailability: (listener) => { listener("available"); return () => {}; },
    }) });
    try {
      const registry = createToolRegistry(host.extensions);
      const record = registry.lookup("mcp__s__query");
      assert.equal(record?.authz, configured ?? "write");
      assert.equal(record?.replay, "unsafe");
      assert.equal(record?.trust, "untrusted");
      assert.equal(record?.tier, 2);
    } finally {
      await host.close();
    }
  }
});

test("production host enforces restricted authority and reads authz alongside pin from the MCP file", { timeout: 20_000 }, async () => {
  for (const authority of ["owner", "restricted"] as const satisfies readonly ToolAuthority[]) {
    const directory = await mkdtemp(join(tmpdir(), "tool-authz-"));
    let app: Awaited<ReturnType<typeof openAgent>> | undefined;
    try {
      await writeFile(join(directory, "mcp.json"), JSON.stringify({ servers: [{ name: "s", transport: "stdio", command: process.execPath,
        args: [resolve("test/fixtures/mcp-server.mjs")] }], tools: {
        mcp__s__echo: { pin: true, authz: "read" }, mcp__s__env: { pin: true },
      } }));
      const audit = logs();
      const fixture = models("openai");
      fixture.faux.setResponses([
        call("mcp__s__echo", { text: "from file" }),
        (transcript) => {
          assert.equal(lastResult(transcript.messages)?.isError, false);
          assert.match(JSON.stringify(lastResult(transcript.messages)?.content), /from file/);
          return call("mcp__s__env", { key: "UNUSED_AUTHZ_TEST_VARIABLE" });
        },
        (transcript) => {
          assert.equal(lastResult(transcript.messages)?.isError, authority === "restricted");
          if (authority === "restricted") assert.equal(code(lastResult(transcript.messages)?.details), "TOOL_AUTHZ_DENIED");
          return fauxAssistantMessage("done");
        },
      ]);
      const config = { ...readConfig({ TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai", MODEL_ID: "faux-1", OPENAI_API_KEY: "test", DATA_DIR: directory }),
        memory: readMemoryConfig({ MEMORY_ENABLED: "0" }) };
      app = await openAgent(config, fixture.models, undefined, { toolAuthority: authority, toolReviewLog: audit.log });
      assert.equal(await app.reply({ requestId: "telegram:authz", conversationId: "test", senderId: "1", text: "read and write" }, new AbortController().signal), "done");
      assert.deepEqual(audit.events.map(({ code }) => code), ["TOOL_ALLOWED", authority === "owner" ? "TOOL_ALLOWED" : "TOOL_AUTHZ_DENIED"]);
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
