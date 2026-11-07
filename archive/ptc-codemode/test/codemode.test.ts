import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openAgent } from "../src/agent.js";
import {
  CODEMODE_OUTPUT_LIMITS,
  createCodemodeHost,
  NO_TEXT_OUTPUT,
  prepareCodemodeScript,
  REMOTE_SCRIPT_TOOLS,
  restrictScriptTools,
  serializeNestedCalls,
  stripCodemodeTypes,
} from "../src/codemode.js";
import { ConfigurationError, readCodemodeConfig, readConfig, readMemoryConfig } from "../src/config.js";
import { PtcHostError, type DirectHost } from "../src/execution/ptc-host.js";
import { startRpcAgent } from "../src/execution/rpc-server.js";
import { listenTlsRpc } from "../src/execution/rpc-transport.js";
import type { RpcBashExecutePayload, RpcSkippedOutput } from "../src/execution/rpc-protocol.js";
import type { TextRequest } from "../src/messages.js";
import { TestPtcHost } from "./ptc-test-host.js";

const request: TextRequest = {
  requestId: "telegram:test:codemode",
  conversationId: "telegram:test",
  senderId: "1",
  text: "Run the code mode task.",
};
const running = new AbortController().signal;

function appConfig(dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const full = {
    TELEGRAM_BOT_TOKEN: "offline-test",
    TELEGRAM_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
    ...env,
  };
  return { ...readConfig(full), memory: readMemoryConfig(full) } as ReturnType<typeof readConfig>;
}

function modelFixture() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function systemSection(messages: readonly Message[], key: string): string | undefined {
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    const value = message.sections[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}


function toolResultText(transcript: { messages: readonly Message[] }, id: string): string {
  const result = transcript.messages.find((message) =>
    message.role === "toolResult" && message.toolCallId === id);
  assert.ok(result?.role === "toolResult", `missing tool result ${id}`);
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

async function runScript(
  directory: string,
  code: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ text: string; isError: boolean }> {
  const fixture = modelFixture();
  let captured: { text: string; isError: boolean } | undefined;
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: "script" }), { stopReason: "toolUse" }),
    (transcript) => {
      const result = transcript.messages.find((message) => message.role === "toolResult");
      assert.ok(result?.role === "toolResult", "the codemode call settles a result");
      captured = {
        text: toolResultText(transcript, "script"),
        isError: result.isError === true,
      };
      return fauxAssistantMessage("done");
    },
  ]);
  const app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1", ...env }), fixture.models);
  try {
    assert.equal(await app.reply(request, running), "done");
  } finally {
    await app.close();
  }
  assert.ok(captured);
  return captured;
}

test("code mode is opt-in and its sandbox bounds are validated before startup", () => {
  assert.deepEqual(readCodemodeConfig({}), {
    enabled: false,
    scriptFirst: false,
    timeoutMs: 240_000,
    memoryLimitBytes: 128 * 1024 * 1024,
  });
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1" }).enabled, true);
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1" }).scriptFirst, true,
    "script-first defaults on with code mode");
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1", CODEMODE_SCRIPT_FIRST: "" }).scriptFirst, true);
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "" }).enabled, false);
  assert.throws(() => readCodemodeConfig({ CODEMODE_ENABLED: "yes" }), (error) =>
    error instanceof ConfigurationError && /CODEMODE_ENABLED/.test(error.message));
  assert.throws(() => readCodemodeConfig({ CODEMODE_ENABLED: "1", CODEMODE_SCRIPT_FIRST: "yes" }), (error) =>
    error instanceof ConfigurationError && /CODEMODE_SCRIPT_FIRST/.test(error.message));
  assert.throws(() => readCodemodeConfig({ CODEMODE_TIMEOUT_MS: "999" }), ConfigurationError);
  assert.throws(() => readCodemodeConfig({ CODEMODE_TIMEOUT_MS: "300001" }), ConfigurationError);
  assert.throws(() => readCodemodeConfig({ CODEMODE_MEMORY_LIMIT_BYTES: "16777215" }), ConfigurationError);
  assert.throws(() => readCodemodeConfig({ CODEMODE_MEMORY_LIMIT_BYTES: "536870913" }), ConfigurationError);
  assert.equal(readConfig({
    TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test",
  }).codemode, undefined, "disabled code mode leaves the config shape unchanged");
});

test("script tools are limited without hiding them from the model", () => {
  const restricted = restrictScriptTools(CodingTools, REMOTE_SCRIPT_TOOLS);
  const tools = new Map((restricted.tools ?? []).map((tool) => [tool.name, tool]));
  // Remote scripts may now call the file tools too: they run inside the execution sandbox.
  for (const name of ["bash", "read", "write", "edit"]) {
    assert.equal(tools.get(name)?.callers, undefined, `${name} stays available to scripts`);
  }

  const modelOnly = defineTool({
    name: "model_only",
    description: "Only the model may call this.",
    parameters: Type.Object({}),
    callers: ["model"],
    execute: async () => ({ output: [] }),
  });
  const ordinary = defineTool({
    name: "ordinary",
    description: "Callable by both by default.",
    parameters: Type.Object({}),
    execute: async () => ({ output: [] }),
  });
  const narrowed = restrictScriptTools(defineExtension({ name: "extra", tools: [modelOnly, ordinary] }), new Set());
  assert.deepEqual(narrowed.tools?.[0]?.callers, ["model"], "a model-only tool keeps its model caller");
  assert.deepEqual(narrowed.tools?.[1]?.callers, ["model"], "a default tool loses its script caller");

  const toolsOnly = defineTool({
    name: "tools_only",
    description: "Only scripts may call this.",
    parameters: Type.Object({}),
    callers: ["tools"],
    execute: async () => ({ output: [] }),
  });
  const closed = restrictScriptTools(defineExtension({ name: "tools-only", tools: [toolsOnly] }), new Set());
  assert.deepEqual(closed.tools?.[0]?.callers, [], "a tools-only tool is not promoted to the model");

  const withoutTools = defineExtension({ name: "sections-only" });
  assert.equal(restrictScriptTools(withoutTools, new Set()), withoutTools);
});

test("nested calls stop when their script call ends", async () => {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const fake = defineTool({
    name: "fake-codemode",
    description: "Fake code mode tool.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      void api.executeTool("first", {}, context).catch(() => undefined);
      void api.executeTool("second", {}, context).catch(() => undefined);
      return { output: [{ type: "text", text: "done" }] };
    },
  });
  const wrapped = serializeNestedCalls(fake);
  const api = {
    executeTool: async (name: string, _args: unknown, nestedContext: Context) => {
      started.push(name);
      signals.set(name, nestedContext.abortSignal);
      await new Promise<void>((resolve) => {
        nestedContext.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { taskId: 1, isError: true, diagnostics: [] };
    },
  } as unknown as ToolExecutionApi;

  assert.deepEqual(await wrapped.execute({}, api, BACKGROUND_CONTEXT), {
    output: [{ type: "text", text: "done" }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"], "the queued call never starts after the script ends");
  assert.equal(signals.get("first")?.aborted, true, "a still-running call is cancelled");
});

test("code mode host caps the model-visible result and closes idempotently", async () => {
  const host = createCodemodeHost(readCodemodeConfig({ CODEMODE_ENABLED: "1" }));
  try {
    const tool = host.extension.tools?.find(({ name }) => name === "codemode");
    assert.ok(tool, "the codemode tool is installed");
    assert.deepEqual(tool.outputLimits, CODEMODE_OUTPUT_LIMITS);
    assert.deepEqual(tool.callers, ["model"], "scripts cannot start scripts");
    assert.equal(host.extension.tools?.some(({ name }) => name.startsWith("models.")), false);
  } finally {
    await host.close();
    await host.close();
  }
});

test("code mode runs one script whose nested calls stay out of the transcript", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      (transcript) => {
        const section = systemSection(transcript.messages, "codemode");
        assert.ok(section, "the codemode prompt section is present");
        assert.match(section, /bash/);
        assert.match(section, /`read`/, "local scripts keep the file tools");
        assert.match(section, /`write`/);
        assert.match(section, /`edit`/);
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `
            const first = await tools.bash({ command: "printf first >> nested.log" });
            const second = await tools.bash({ command: "printf second >> nested.log" });
            text("nested calls done");
          `,
        }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const results = transcript.messages.filter((message) => message.role === "toolResult");
        assert.equal(results.length, 1, "only the codemode result enters the conversation");
        const result = results[0];
        assert.ok(result?.role === "toolResult" && !result.isError);
        const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
        assert.match(text, /nested calls done/);
        return fauxAssistantMessage("done");
      },
    ]);
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
    assert.equal(
      await readFile(join(directory, "workspace", "nested.log"), "utf8"),
      "firstsecond",
      "both nested bash calls ran",
    );
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

/** A direct host that records nothing it should be asked to do; nested calls must take the PTC path. */
class SilentDirectHost implements DirectHost {
  readonly enabled = true;
  readonly sharedMode = "rw" as const;
  readonly executions: RpcBashExecutePayload[] = [];

  async preflight(): Promise<Record<string, boolean | null>> {
    return { direct: true, sharedWorkspace: true, directTmpRoot: true };
  }

  async openSession(): Promise<{ sharedMode: "ro" | "rw"; tmpPath: string }> {
    return { sharedMode: "rw", tmpPath: "/tmp/aster-direct" };
  }

  async closeSession(): Promise<void> {}

  async execute(input: {
    sessionId: string;
    payload: RpcBashExecutePayload;
    signal: AbortSignal;
    emit: (seq: number, stream: "stdout" | "stderr", text: string, skipped?: RpcSkippedOutput) => void;
  }): Promise<{ exitCode: number; durationMs: number }> {
    this.executions.push(input.payload);
    return { exitCode: 0, durationMs: 0 };
  }

  async fileRequest(): Promise<unknown> {
    throw new PtcHostError("not_found", "the direct file host is not used by this test", "not_started");
  }
}

// The direct-session transport keeps the whole path in process, so the test runs on every platform;
// the PTC bridge still crosses real TLS RPC framing, session state and the vm.reply cycle.
test("code mode in remote execution exposes the sandbox tools to scripts", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-remote-"));
  const executionId = "0000000000000002";
  const fixtureDirectory = fileURLToPath(new URL("./fixtures/rpc-tls", import.meta.url));
  const [ca, serverCert, serverKey, clientCert, clientKey] = await Promise.all([
    readFile(join(fixtureDirectory, "ca.crt")),
    readFile(join(fixtureDirectory, "server.crt")),
    readFile(join(fixtureDirectory, "server.key")),
    readFile(join(fixtureDirectory, "client.crt")),
    readFile(join(fixtureDirectory, "client.key")),
  ]);
  const ptc = new TestPtcHost();
  const direct = new SilentDirectHost();
  const rpcServer = await listenTlsRpc({
    host: "127.0.0.1",
    port: 0,
    cert: serverCert,
    key: serverKey,
    ca,
    requireClientCert: true,
    allowedClientNames: ["aster-test-gateway"],
    maxFrameBytes: 4 * 1024 * 1024,
  });
  const address = rpcServer.address();
  assert.ok(!("path" in address));
  const agent = startRpcAgent({
    server: rpcServer,
    executionId,
    transport: "tls",
    heartbeatMs: 60_000,
    sessionTtlMs: 60_000,
    testExecutorEnabled: true,
    ptc,
    direct,
  });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      (transcript) => {
        const section = systemSection(transcript.messages, "codemode");
        assert.ok(section);
        assert.match(section, /bash/);
        assert.match(section, /`read`/);
        assert.match(section, /`write`/);
        assert.match(section, /`edit`/);
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `
            const first = await tools.bash({ command: "printf remote-first" });
            const second = await tools.bash({ command: "printf remote-second" });
            text(first.output + second.output);
          `,
        }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult");
        assert.ok(result?.role === "toolResult", "the codemode call must settle a result");
        const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
        assert.equal(result.isError, false, `the codemode call failed: ${text}`);
        assert.match(text, /out-1out-2/);
        return fauxAssistantMessage("remote done");
      },
    ]);
    app = await openAgent(appConfig(directory, {
      CODEMODE_ENABLED: "1",
      EXECUTION_MODE: "remote",
      EXECUTION_REMOTE_TRANSPORT: "rpc",
      EXECUTION_REMOTE_CWD: "/shared/work",
      EXECUTION_RPC_ADDRESS: `127.0.0.1:${address.port}`,
      EXECUTION_RPC_SERVER_NAME: "localhost",
      EXECUTION_RPC_CA_PATH: join(fixtureDirectory, "ca.crt"),
      EXECUTION_RPC_CERT_PATH: join(fixtureDirectory, "client.crt"),
      EXECUTION_RPC_KEY_PATH: join(fixtureDirectory, "client.key"),
    }), fixture.models);
    assert.equal(await app.reply(request, running), "remote done");
    assert.equal(ptc.calls.length, 2, "two nested calls reached the PTC sandbox");
    assert.deepEqual(
      ptc.calls.map(({ args }) => args.command),
      ["printf remote-first", "printf remote-second"],
    );
    assert.deepEqual(ptc.calls.map(({ callId }) => callId), [1, 2], "call ids come from the VM, not the model");
    assert.equal(direct.executions.length, 0, "nested calls never fall back to the direct session");
  } finally {
    try { await app?.close(); } finally {
      await agent.close();
      await rpcServer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("script preparation strips TypeScript annotations and keeps the options line", () => {
  const code = `// @options: {"timeout_ms": 5000}
interface Item { name: string }
const item: Item = { name: "typed" } as Item;
text(item.name);`;
  const prepared = prepareCodemodeScript(code, true);
  assert.ok(prepared.startsWith('// @options: {"timeout_ms": 5000}' + String.fromCharCode(10)));
  assert.doesNotMatch(prepared, /interface Item/);
  assert.doesNotMatch(prepared, /: string/);
  assert.match(prepared, /text\(item\.name\)/);
  assert.match(prepared, /await \(async \(\) => \{/, "the top-level return is discarded");
  const moduleSyntax = 'import x from "x";' + String.fromCharCode(10) + 'const a: number = 1;';
  assert.equal(
    stripCodemodeTypes(moduleSyntax),
    moduleSyntax,
    "module syntax falls back to QuickJS instead of being rewritten",
  );
});

test("script-first does not leak an implicit return value or console logs", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-notext-"));
  try {
    const result = await runScript(directory, `
      console.log("raw-console-line");
      return { secret: "raw-large-data" };
    `);
    assert.equal(result.isError, false);
    assert.equal(result.text, NO_TEXT_OUTPUT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("script-first sends only explicit text() output", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-text-"));
  try {
    const result = await runScript(directory, `
      console.log("console-noise");
      text("filtered summary");
      return "return-noise";
    `);
    assert.equal(result.isError, false);
    assert.match(result.text, /filtered summary/);
    assert.doesNotMatch(result.text, /console-noise/);
    assert.doesNotMatch(result.text, /return-noise/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing script keeps staged text, console output and its error", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-fail-"));
  try {
    const result = await runScript(directory, `
      text("staged-text");
      console.log("staged-console");
      throw new Error("boom");
    `);
    assert.equal(result.isError, true);
    assert.match(result.text, /staged-text/);
    assert.match(result.text, /staged-console/);
    assert.match(result.text, /Script error:/);
    assert.match(result.text, /boom/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a TypeScript-annotated script runs with its options line intact", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-types-"));
  try {
    const result = await runScript(directory, `// @options: {"timeout_ms": 5000}
interface Item { name: string }
const item: Item = { name: "typed" } as Item;
text(item.name);`);
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /typed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CODEMODE_SCRIPT_FIRST=0 keeps the implicit return value", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-legacy-"));
  try {
    const result = await runScript(directory, 'return "legacy-return";', { CODEMODE_SCRIPT_FIRST: "0" });
    assert.equal(result.isError, false);
    assert.match(result.text, /legacy-return/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
