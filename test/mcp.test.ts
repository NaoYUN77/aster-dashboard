import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  McpAbortError,
  McpConnectionClosedError,
  McpError,
  McpTimeoutError,
  type CallToolResult,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { buildMcpTool, connectMcp, mcpToolName, openMcpConnection, type McpConnection, type McpToolInfo } from "../src/mcp.js";
import type { McpFileConfig, McpServerConfig } from "../src/mcp-config.js";
import type { TextRequest } from "../src/messages.js";
import { readToolCatalog, readToolLedger } from "../src/tool-ledger.js";
import { createToolRegistry, type GovernedTool } from "../src/tools.js";

const unusedApi = undefined as unknown as ToolExecutionApi;

type Call = { name: string; args: Record<string, unknown>; signal?: AbortSignal; timeoutMs: number };

interface FakeConnection extends McpConnection {
  readonly calls: Call[];
  readonly closedCount: number;
  setAvailability(state: "available" | "unavailable"): void;
}

function fakeConnection(
  serverName: string,
  tools: McpToolInfo[],
  options: {
    call?: (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<CallToolResult>;
    list?: () => Promise<McpToolInfo[]>;
  } = {},
): FakeConnection {
  const calls: Call[] = [];
  const listeners = new Set<(state: "available" | "unavailable") => void>();
  let availability: "available" | "unavailable" = "available";
  let closedCount = 0;
  const setAvailability = (state: typeof availability) => {
    availability = state;
    for (const listener of [...listeners]) listener(state);
  };
  return {
    serverName,
    calls,
    get closedCount() {
      return closedCount;
    },
    listTools: () => options.list?.() ?? Promise.resolve(tools),
    async callTool(name, args, request) {
      calls.push({ name, args, ...(request.signal === undefined ? {} : { signal: request.signal }), timeoutMs: request.timeoutMs });
      return options.call?.(name, args, request.signal) ?? { content: [{ type: "text", text: "ok" }] };
    },
    setAvailability,
    async close() {
      closedCount++;
      setAvailability("unavailable");
    },
    subscribeAvailability(listener) {
      listeners.add(listener);
      listener(availability);
      return () => { listeners.delete(listener); };
    },
  };
}

function stdioServer(name: string, timeoutMs = 5_000): McpServerConfig {
  return { name, transport: "stdio", command: "npx", args: [], env: {}, inheritEnv: false, timeoutMs, connectTimeoutMs: 1_000 };
}

function tool(name: string, inputSchema: Record<string, unknown> = { type: "object" }, description?: string): McpToolInfo {
  return { name, ...(description === undefined ? {} : { description }), inputSchema };
}

function config(...servers: McpServerConfig[]): McpFileConfig {
  return { servers };
}

async function run(tool: ReturnType<typeof buildMcpTool>, args: Record<string, unknown>, context: Context = BACKGROUND_CONTEXT) {
  assert.ok(tool, "the tool must have been built");
  return tool.execute(args as never, unusedApi, context);
}

test("MCP tool names stay deterministic, bounded, and collision-free", () => {
  assert.equal(mcpToolName("github", "get_issue", new Set()), "mcp__github__get_issue");
  assert.equal(mcpToolName("git hub", "get/issue", new Set()), "mcp__git_hub__get_issue");
  assert.equal(mcpToolName("github", "!!!", new Set()), "mcp__github_____");

  const raw = "x".repeat(80);
  const truncated = mcpToolName("github", raw, new Set())!;
  assert.equal(truncated.length, 64);
  assert.match(truncated, /_[0-9a-f]{8}$/);
  // Identical input yields an identical name across restarts, different input does not collide.
  assert.equal(truncated, mcpToolName("github", raw, new Set()));
  assert.notEqual(truncated, mcpToolName("github", "y".repeat(80), new Set()));

  const reserved = mcpToolName("github", "get_issue", new Set(["mcp__github__get_issue"]))!;
  assert.notEqual(reserved, "mcp__github__get_issue");
  assert.ok(reserved.length <= 64);

  // Two raw names that sanitize alike must not share one name.
  const first = mcpToolName("s", "a.b", new Set())!;
  const second = mcpToolName("s", "a_b", new Set([first]))!;
  assert.notEqual(first, second);

  const hashed = mcpToolName("s", "t", new Set(["mcp__s__t"]))!;
  assert.equal(mcpToolName("s", "t", new Set(["mcp__s__t", hashed])), undefined);
});

test("an unrepresentable input schema makes the tool unavailable", () => {
  const connection = fakeConnection("s", []);
  const server = stdioServer("s");
  const build = (inputSchema: unknown) => buildMcpTool(server, connection, tool("t", inputSchema as Record<string, unknown>), "mcp__s__t");

  const minimal = build({});
  assert.deepEqual(minimal?.parameters, { type: "object", properties: {} });
  assert.equal(minimal?.description, "t", "a missing description falls back to the tool name");

  assert.deepEqual(build({ type: "object", properties: { q: { type: "string" } } })?.parameters, {
    type: "object",
    properties: { q: { type: "string" } },
  });
  assert.equal(build({ type: "array", items: { type: "string" } }), undefined, "only object arguments are supported");
  assert.equal(build({ type: "object", properties: [] }), undefined, "properties must be an object");
  assert.equal(build({ type: "object", required: "q" }), undefined, "required must be an array of names");
  assert.equal(build({ type: "object", properties: { q: { $ref: "#/definitions/q" } } }), undefined, "unresolvable references are rejected");
  assert.equal(build({ type: "object", properties: { q: { type: "string", pattern: "[" } } }), undefined, "an uncompilable schema is rejected");

  let nested: Record<string, unknown> = { type: "object" };
  for (let level = 0; level < 8; level++) nested = { type: "object", properties: { next: nested } };
  assert.equal(build(nested), undefined, "a too deeply nested schema is rejected");

  // Deep enough that JSON.stringify would overflow the stack; the depth walk must run first.
  let deep: Record<string, unknown> = { type: "object" };
  for (let level = 0; level < 5_000; level++) deep = { type: "object", properties: { next: deep } };
  assert.equal(build(deep), undefined, "a schema too deep to serialize is rejected, not thrown");

  const wide = Object.fromEntries(Array.from({ length: 300 }, (_value, index) => [`p${index}`, { type: "string" }]));
  assert.equal(build({ type: "object", properties: wide }), undefined, "a schema with too many properties is rejected");

  const huge = { type: "object", properties: { q: { type: "string", description: "x".repeat(20_000) } } };
  assert.equal(build(huge), undefined, "an oversized schema is rejected");
});

test("a tool call maps MCP content, forwards cancellation, and always asks for a bounded result", async () => {
  const connection = fakeConnection("s", [], {
    call: async () => ({
      content: [{ type: "text", text: "hi" }, { type: "image", data: "aGk=", mimeType: "image/png" }],
    }),
  });
  const built = buildMcpTool(stdioServer("s", 4_000), connection, tool("t", { type: "object" }, "desc"), "mcp__s__t");
  const controller = new AbortController();
  const result = await run(built, { q: 1 }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));

  assert.deepEqual(result.output, [
    { type: "text", text: "hi" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, { server: "s", tool: "t" });
  assert.deepEqual(connection.calls, [{ name: "t", args: { q: 1 }, signal: controller.signal, timeoutMs: 4_000 }]);

  const aborted = new AbortController();
  aborted.abort();
  await run(built, {}, withAbortSignal(aborted.signal, BACKGROUND_CONTEXT));
  assert.equal(connection.calls[1]?.signal?.aborted, true, "cancellation reaches the server call");
});

test("an oversized image result is replaced by a placeholder instead of entering the transcript", async () => {
  const big = "A".repeat(5 * 1024 * 1024);
  const connection = fakeConnection("s", [], {
    call: async () => ({
      content: [{ type: "text", text: "shot" }, { type: "image", data: big, mimeType: "image/png" }],
    }),
  });
  const result = await run(buildMcpTool(stdioServer("s"), connection, tool("t"), "mcp__s__t"), {});
  assert.deepEqual(result.output?.[0], { type: "text", text: "shot" });
  assert.equal(result.output?.length, 2);
  const placeholder = result.output?.[1];
  assert.ok(placeholder?.type === "text" && /image from t omitted/.test(placeholder.text), "the image is dropped with a visible reason");

  const small = fakeConnection("s", [], {
    call: async () => ({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }),
  });
  const kept = await run(buildMcpTool(stdioServer("s"), small, tool("t"), "mcp__s__t"), {});
  assert.deepEqual(kept.output, [{ type: "image", data: "aGk=", mimeType: "image/png" }], "a normal image passes through");
});

test("a structured-only or empty result still reaches the model", async () => {
  const structured = fakeConnection("s", [], { call: async () => ({ content: [], structuredContent: { answer: 42 } }) });
  const built = buildMcpTool(stdioServer("s"), structured, tool("t"), "mcp__s__t");
  const result = await run(built, {});
  assert.equal(result.output?.length, 1);
  assert.match(JSON.stringify(result.output), /answer/);

  const empty = fakeConnection("s", [], { call: async () => ({ content: [] }) });
  const emptyResult = await run(buildMcpTool(stdioServer("s"), empty, tool("t"), "mcp__s__t"), {});
  assert.deepEqual(emptyResult.output, []);
  assert.equal(emptyResult.isError, false);
});

test("a server-reported tool error is a result, not a thrown failure", async () => {
  const connection = fakeConnection("s", [], { call: async () => ({ content: [{ type: "text", text: "denied" }], isError: true }) });
  const result = await run(buildMcpTool(stdioServer("s"), connection, tool("t"), "mcp__s__t"), {});
  assert.equal(result.isError, true);
  assert.deepEqual(result.output, [{ type: "text", text: "denied" }]);
});

test("failures become safe codes without leaking server text", async () => {
  const cases: [Error, RegExp, string][] = [
    [new McpTimeoutError(1_000), /timed out/, "MCP_TIMEOUT"],
    [new McpConnectionClosedError("closed"), /is not connected/, "MCP_CLOSED"],
    [new McpError(-32_601, "internal detail"), /protocol error/, "MCP_PROTOCOL"],
    [new Error("socket leaked secret-token"), /call failed/, "MCP_FAILED"],
    [new McpOAuthAuthorizationRequiredError(), /requires authorization/, "MCP_AUTH_REQUIRED"],
  ];
  for (const [thrown, expected, code] of cases) {
    const connection = fakeConnection("s", [], { call: async () => { throw thrown; } });
    const built = buildMcpTool(stdioServer("s"), connection, tool("t"), "mcp__s__t");
    await assert.rejects(
      run(built, {}),
      (error: Error & { code?: string }) => {
        assert.match(error.message, expected);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /secret-token|internal detail/);
        return true;
      },
    );
  }

  const aborting = fakeConnection("s", [], { call: async () => { throw new McpAbortError(); } });
  await assert.rejects(
    run(buildMcpTool(stdioServer("s"), aborting, tool("t"), "mcp__s__t"), {}),
    (error: unknown) => error instanceof McpAbortError,
    "cancellation is not rewritten as a business failure",
  );
});

test("connected servers install one extension each and defer every tool behind tool_search", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  try {
    const connections = new Map<string, FakeConnection>();
    const host = await connectMcp(config(stdioServer("one"), stdioServer("two")), {
      dataDir: directory,
      reserved: new Set(["read"]),
      log: () => {},
      connect: async (server) => {
        const connection = fakeConnection(server.name, [tool("alpha"), tool("beta")]);
        connections.set(server.name, connection);
        return connection;
      },
    });

    assert.deepEqual(host.extensions.map((extension) => extension.name), ["mcp-server-one", "mcp-server-two", "mcp-servers", "tool-search"]);
    for (const extension of host.extensions.slice(0, 2)) {
      assert.equal(extension.tools?.length, 2);
      for (const built of extension.tools) {
        assert.equal(built.deferred, true, "MCP tools are only offered after tool_search loads them");
        assert.equal(built.replay, "unsafe", "an interrupted MCP call is never replayed");
        assert.deepEqual(built.outputLimits, { maxBytes: 32_768, maxLines: 1_000, retain: "head" });
      }
    }
    assert.deepEqual(host.extensions[0]?.tools?.map((built) => built.name), ["mcp__one__alpha", "mcp__one__beta"]);
    assert.deepEqual(host.extensions[1]?.tools?.map((built) => built.name), ["mcp__two__alpha", "mcp__two__beta"]);

    const section = host.extensions[2]?.sections?.[0];
    const text = await section?.render(undefined as never, BACKGROUND_CONTEXT);
    assert.match(String(text), /one \(2\)/);
    assert.match(String(text), /tool_search/);

    await host.close();
    await host.close();
    assert.equal(connections.get("one")?.closedCount, 1, "closing twice closes each server once");
    assert.equal(connections.get("two")?.closedCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing server is skipped without hiding the working ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  const logs: string[] = [];
  try {
    const closed: string[] = [];
    const host = await connectMcp(config(stdioServer("bad"), stdioServer("empty"), stdioServer("partial"), stdioServer("good")), {
      dataDir: directory,
      reserved: new Set(),
      log: (line) => logs.push(line),
      connect: async (server) => {
        if (server.name === "bad") throw new McpError(-32_000, "secret-token rejected");
        const connection = fakeConnection(server.name, server.name === "empty" ? [] : [tool("only")], {
          list: server.name === "partial" ? async () => { throw new McpTimeoutError(1_000); } : undefined,
        });
        const original = connection.close;
        connection.close = async () => { closed.push(server.name); await original(); };
        return connection;
      },
    });

    assert.deepEqual(host.extensions.map((extension) => extension.name), ["mcp-server-good", "mcp-servers", "tool-search"]);
    assert.deepEqual(logs, [
      "MCP server bad unavailable (MCP_PROTOCOL)",
      "MCP server empty provides no usable tools",
      "MCP server partial unavailable (MCP_TIMEOUT)",
    ]);
    assert.deepEqual(closed.sort(), ["empty", "partial"], "a server that yielded no tools is disconnected");
    assert.ok(logs.every((line) => !line.includes("secret-token")), "logs never carry server text");
    await host.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a server named like the summary extension keeps its tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  try {
    // Installing an extension with an existing name replaces it, so the names must not coincide.
    const host = await connectMcp(config(stdioServer("info"), stdioServer("servers")), {
      dataDir: directory,
      reserved: new Set(),
      log: () => {},
      connect: async (server) => fakeConnection(server.name, [tool("alpha")]),
    });
    assert.deepEqual(host.extensions.map((extension) => extension.name), ["mcp-server-info", "mcp-server-servers", "mcp-servers", "tool-search"]);
    const tools = host.extensions
      .filter((extension) => extension.name.startsWith("mcp-server-"))
      .flatMap((extension) => extension.tools?.map((built) => built.name) ?? []);
    assert.deepEqual(tools, ["mcp__info__alpha", "mcp__servers__alpha"], "both servers' tools survive installation");
    await host.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("colliding raw names are resolved by identity, not listing order or bare-name config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  try {
    const connectIn = (order: string[]) => connectMcp({
      ...config(stdioServer("s")),
      tools: { mcp__s__a_b: { authz: "read" } },
    }, {
      dataDir: directory,
      reserved: new Set(),
      log: () => {},
      connect: async (server) => fakeConnection(server.name, order.map((name) => tool(name))),
    });
    const toolsFor = async (order: string[]) => {
      const host = await connectIn(order);
      const tools = host.extensions[0]!.tools! as GovernedTool[];
      await host.close();
      return tools;
    };
    const first = await toolsFor(["a.b", "a_b"]);
    const second = await toolsFor(["a_b", "a.b"]);
    assert.deepEqual(first.map(({ name }) => name), second.map(({ name }) => name),
      "a restart that reorders tools/list yields the same names");
    assert.equal(first.length, 2, "both tools get a name");
    assert.ok(first.every(({ name }) => name !== "mcp__s__a_b"), "the collision group does not expose an unstable bare name");
    assert.ok(first.every(({ governance }) => governance?.authz === "write"),
      "configuration for a former bare name cannot transfer to a newly colliding identity");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a name that cannot be made unique is skipped and reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  const logs: string[] = [];
  try {
    const host = await connectMcp(config(stdioServer("s")), {
      dataDir: directory,
      reserved: new Set(["mcp__s__t", mcpToolName("s", "t", new Set(["mcp__s__t"]))!]),
      log: (line) => logs.push(line),
      connect: async (server) => fakeConnection(server.name, [tool("t"), tool("keep")]),
    });
    assert.deepEqual(host.extensions[0]?.tools?.map((built) => built.name), ["mcp__s__keep"]);
    assert.match(logs.join("\n"), /tool skipped \(name collision\)/);
    await host.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tool with an unusable schema is skipped while its siblings stay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  const logs: string[] = [];
  try {
    const host = await connectMcp(config(stdioServer("s")), {
      dataDir: directory,
      reserved: new Set(),
      log: (line) => logs.push(line),
      connect: async (server) => fakeConnection(server.name, [tool("bad", { type: "array" }), tool("good")]),
    });
    assert.deepEqual(host.extensions[0]?.tools?.map((built) => built.name), ["mcp__s__good"]);
    assert.match(logs.join("\n"), /tool skipped \(unsupported schema\)/);
    await host.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no configured servers means no extensions and a harmless shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  try {
    for (const configuration of [undefined, config()]) {
      const host = await connectMcp(configuration, { dataDir: directory, reserved: new Set(), log: () => {} });
      assert.deepEqual(host.extensions, []);
      await host.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a server that drops after connecting keeps its tools and says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  const logs: string[] = [];
  try {
    const connection = fakeConnection("s", [tool("t")]);
    const host = await connectMcp(config(stdioServer("s")), {
      dataDir: directory,
      reserved: new Set(),
      log: (line) => logs.push(line),
      connect: async () => connection,
    });
    await connection.close();
    assert.match(logs.join("\n"), /MCP server s disconnected/);
    await host.close();
    assert.deepEqual(logs.filter((line) => line.includes("disconnected")).length, 1, "closing the host does not report a drop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a close during discovery is replayed to late health subscribers and shutdown detaches listeners", async () => {
  const connection = fakeConnection("s", [tool("t")], {
    list: async () => { connection.setAvailability("unavailable"); return [tool("t")]; },
  });
  const host = await connectMcp(config(stdioServer("s")), {
    dataDir: tmpdir(), reserved: new Set(), log: () => {}, connect: async () => connection,
  });
  const changes: string[] = [];
  host.subscribeAvailability((server, state) => changes.push(`${server}:${state}`));
  assert.deepEqual(changes, ["s:unavailable"]);
  connection.setAvailability("available");
  connection.setAvailability("available");
  assert.deepEqual(changes, ["s:unavailable", "s:available"]);
  await host.close();
  assert.deepEqual(changes, ["s:unavailable", "s:available", "s:unavailable"]);
  connection.setAvailability("available");
  assert.equal(changes.length, 3, "late connection events cannot revive a closed host");
});

test("a real stdio server connects, lists, calls, and withholds the host environment", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-"));
  const server: McpServerConfig = {
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
    args: [join(import.meta.dirname, "fixtures", "mcp-server.mjs")],
    env: { SHARED: "yes" },
    inheritEnv: false,
    timeoutMs: 5_000,
    connectTimeoutMs: 5_000,
  };
  const connection = await openMcpConnection(server, {
    dataDir: directory,
    env: { ...process.env, SECRET_TOKEN: "leak-me" },
  });
  const states: string[] = [];
  const unsubscribe = connection.subscribeAvailability((state) => states.push(state));
  try {
    assert.deepEqual(states, ["available"]);
    assert.deepEqual((await connection.listTools()).map((entry) => entry.name), ["echo", "env", "bad_schema"]);
    assert.deepEqual((await connection.callTool("echo", { text: "hello" }, { timeoutMs: 5_000 })).content, [{ type: "text", text: "hello" }]);

    const leaked = await connection.callTool("env", { key: "SECRET_TOKEN" }, { timeoutMs: 5_000 });
    assert.deepEqual(leaked.content, [{ type: "text", text: "" }], "the bot's environment does not reach MCP children");
    const shared = await connection.callTool("env", { key: "SHARED" }, { timeoutMs: 5_000 });
    assert.deepEqual(shared.content, [{ type: "text", text: "yes" }], "the configured environment does reach the child");
    await assert.rejects(connection.callTool("exit", {}, { timeoutMs: 5_000 }), McpConnectionClosedError);
    assert.deepEqual(states, ["available", "unavailable"], "unexpected process exit reports unavailability");
  } finally {
    await connection.close();
  }
  await connection.close();
  assert.deepEqual(states, ["available", "unavailable"]);
  const late: string[] = [];
  connection.subscribeAvailability((state) => late.push(state))();
  assert.deepEqual(late, ["unavailable"], "SDK close events are replayed by the adapter snapshot");
  unsubscribe();
  await rm(directory, { recursive: true, force: true });
});

test("an MCP tool is hidden until tool_search loads it, then callable", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-agent-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const connection = fakeConnection("echo", [tool("echo", {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    }, "Echo the given text.")], {
      call: async (_name, args) => ({ content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] }),
    });
    const host = await connectMcp(config(stdioServer("echo")), {
      dataDir: directory,
      reserved: new Set(),
      log: () => {},
      connect: async () => connection,
    });

    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("tool_search", { query: "echo" }), { stopReason: "toolUse" }),
      (transcript) => {
        const loaded = transcript.messages.find((message) => message.role === "toolResult" && message.toolName === "tool_search");
        assert.ok(loaded?.role === "toolResult" && !loaded.isError);
        return fauxAssistantMessage(fauxToolCall("mcp__echo__echo", { text: "via mcp" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult" && message.toolName === "mcp__echo__echo");
        // A deferred tool that tool_search had not loaded is rejected by the harness as unavailable.
        assert.ok(result?.role === "toolResult" && !result.isError);
        assert.ok(result.content.some((part) => part.type === "text" && part.text === "echo: via mcp"));
        return fauxAssistantMessage("done");
      },
    ]);

    const appConfig = readConfig({
      TELEGRAM_BOT_TOKEN: "offline-test",
      TELEGRAM_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "offline-test",
      DATA_DIR: directory,
    });
    app = await openAgent(appConfig, models, undefined, { mcp: host });
    const request: TextRequest = { requestId: "telegram:test:1", conversationId: "telegram:test", senderId: "1", text: "Echo something." };
    assert.equal(await app.reply(request, new AbortController().signal), "done");
    assert.equal(connection.calls.length, 1, "the MCP server was called once");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP health filters native search and blocks loaded calls without changing declarations or load epochs", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-health-"));
  const storage = new MemoryStorage();
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const connection = fakeConnection("s", [tool("alpha", {
      type: "object", properties: { value: { type: "string" } }, required: ["value"],
    }), tool("beta")]);
    const host = await connectMcp(config(stdioServer("s")), {
      dataDir: directory, reserved: new Set(), log: () => {}, connect: async () => connection,
    });
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    const declarations = (messages: readonly Message[]) => JSON.stringify(messages.flatMap((message) =>
      message.role === "system" && (message.toolsAdded?.length || message.toolsRemoved?.length)
        ? [{ added: message.toolsAdded, removed: message.toolsRemoved }] : []
    ));
    const lastResult = (messages: readonly Message[]) => messages.findLast((message) => message.role === "toolResult");
    let stable: string;
    let baseline: Awaited<ReturnType<typeof readToolLedger>>;
    const ledger = async () => {
      const conversations = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
      return readToolLedger(storage, conversations.items[0]!.id, BACKGROUND_CONTEXT);
    };
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("tool_search", { query: "alpha", limit: 1 }), { stopReason: "toolUse" }),
      async (transcript) => {
        stable = declarations(transcript.messages);
        baseline = await ledger();
        assert.equal(baseline?.sequence, 1);
        connection.setAvailability("unavailable");
        return fauxAssistantMessage(fauxToolCall("mcp__s__alpha", {}), { stopReason: "toolUse" });
      },
      (transcript) => {
        const result = lastResult(transcript.messages);
        assert.ok(result?.isError);
        assert.match(JSON.stringify(result.content), /value/);
        assert.equal(result.details, undefined, "native schema validation precedes the availability guard");
        assert.equal(connection.calls.length, 0);
        return fauxAssistantMessage(fauxToolCall("mcp__s__alpha", { value: "blocked" }), { stopReason: "toolUse" });
      },
      async (transcript) => {
        assert.equal(declarations(transcript.messages), stable);
        const result = lastResult(transcript.messages);
        assert.ok(result?.role === "toolResult" && result.isError);
        assert.deepEqual(result.details, { code: "TOOL_UNAVAILABLE", server: "s", tool: "mcp__s__alpha" });
        assert.match(JSON.stringify(result.content), /unavailable; this call was not sent/);
        assert.equal(connection.calls.length, 0, "unavailable calls never reach the connection");
        assert.deepEqual(await ledger(), baseline);
        const catalog = await readToolCatalog(storage, BACKGROUND_CONTEXT);
        assert.equal(catalog.find(({ name }) => name === "mcp__s__alpha")?.state, "unavailable");
        assert.equal(catalog.find(({ name }) => name === "mcp__s__beta")?.state, "unavailable");
        return fauxAssistantMessage(fauxToolCall("tool_search", { query: "beta" }), { stopReason: "toolUse" });
      },
      async (transcript) => {
        assert.equal(declarations(transcript.messages), stable);
        assert.deepEqual(lastResult(transcript.messages)?.details, { loaded: [] });
        assert.deepEqual(await ledger(), baseline);
        connection.setAvailability("available");
        return fauxAssistantMessage(fauxToolCall("tool_search", { query: "alpha" }), { stopReason: "toolUse" });
      },
      async (transcript) => {
        assert.equal(declarations(transcript.messages), stable, "restoration does not redeclare loaded tools");
        assert.deepEqual(await ledger(), baseline);
        return fauxAssistantMessage(fauxToolCall("tool_search", { query: "beta", limit: 1 }), { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.deepEqual(lastResult(transcript.messages)?.details, { loaded: ["mcp__s__beta"] }, "restored tools return to native search");
        return fauxAssistantMessage(fauxToolCall("mcp__s__alpha", { value: "recovered" }), { stopReason: "toolUse" });
      },
      async (transcript) => {
        assert.equal(lastResult(transcript.messages)?.isError, false);
        assert.equal(connection.calls.length, 1);
        assert.equal((await ledger())?.epoch, 2, "only loading beta advances the epoch");
        assert.equal((await readToolCatalog(storage, BACKGROUND_CONTEXT)).find(({ name }) => name === "mcp__s__alpha")?.state, "available");
        return fauxAssistantMessage("recovered");
      },
    ]);
    const appConfig = { ...readConfig({
      TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai", MODEL_ID: "faux-1",
      OPENAI_API_KEY: "test", DATA_DIR: directory,
    }), memory: readMemoryConfig({ MEMORY_ENABLED: "0" }) };
    app = await openAgent(appConfig, models, storage, { mcp: host });
    assert.equal(await app.reply({ requestId: "telegram:health:1", conversationId: "test", senderId: "1", text: "use alpha" }, new AbortController().signal), "recovered");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly configured MCP file that cannot be read fails startup", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-missing-"));
  try {
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    const appConfig = readConfig({
      TELEGRAM_BOT_TOKEN: "offline-test",
      TELEGRAM_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "offline-test",
      DATA_DIR: directory,
    });
    await assert.rejects(
      openAgent({ ...appConfig, mcpConfigPath: join(directory, "missing-mcp.json"), mcpConfigExplicit: true }, models),
      /MCP config file cannot be read/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
