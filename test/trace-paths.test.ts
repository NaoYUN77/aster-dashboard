// Trace assertions through the real execution paths: code mode's nested tool serializer, the
// governed registry, and the remote RPC client. No test here constructs a tool observation by hand.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { openAgent } from "../src/agent.js";
import { prepareCodemodeScript, serializeNestedCalls } from "../src/codemode.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import type { DirectHost } from "../src/execution/ptc-host.js";
import type { RpcClientTransport, RpcConnection } from "../src/execution/rpc-transport.js";
import { RpcClientError, RpcExecutionClient } from "../src/execution/rpc-client.js";
import type { RpcFrame, RpcRequestFrame } from "../src/execution/rpc-protocol.js";
import { startRpcAgent } from "../src/execution/rpc-server.js";
import { listenTlsRpc } from "../src/execution/rpc-transport.js";
import type { TextRequest } from "../src/messages.js";
import { beginTrace, startTrace, type TraceRuntime } from "../src/trace.js";
import { TestPtcHost } from "./ptc-test-host.js";

const request: TextRequest = {
  requestId: "trace-paths:test",
  conversationId: "trace-paths",
  senderId: "1",
  text: "Run the trace path.",
};
const running = new AbortController().signal;
const fixtureDirectory = fileURLToPath(new URL("./fixtures/rpc-tls", import.meta.url));

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

function traceSetup(options: { readonly captureContent?: boolean } = {}): {
  readonly exporter: InMemorySpanExporter;
  readonly runtime: TraceRuntime;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const runtime = startTrace(
    { enabled: true, ...(options.captureContent === true ? { captureContent: true } : {}) },
    () => {},
    { tracerProvider: provider },
  );
  assert.ok(runtime);
  return { exporter, runtime };
}

function spanByName(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  assert.ok(span, `missing span ${name}; got ${spans.map(({ name }) => name).join(", ")}`);
  return span;
}

function metadata(span: ReadableSpan, key: string): unknown {
  const raw = span.attributes[`langfuse.observation.metadata.${key}`];
  return raw === undefined ? undefined : JSON.parse(String(raw));
}

function captured(span: ReadableSpan, field: "input" | "output"): unknown {
  const raw = span.attributes[`langfuse.observation.${field}`];
  return raw === undefined ? undefined : JSON.parse(String(raw));
}

function capturedText(value: unknown): string {
  const output = (value as { output?: readonly { type?: string; text?: string }[] } | undefined)?.output ?? [];
  return output.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("");
}

function observationType(span: ReadableSpan): string | undefined {
  return span.attributes["langfuse.observation.type"] as string | undefined;
}

function toolResultText(transcript: { messages: readonly Message[] }, id: string): string {
  const result = transcript.messages.find((message) =>
    message.role === "toolResult" && message.toolCallId === id);
  assert.ok(result?.role === "toolResult", `missing tool result ${id}`);
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

/** A direct host that only satisfies openAgent's health gate; nested calls must use PTC. */
class AuditDirectHost implements DirectHost {
  readonly enabled = true;
  readonly sharedMode = "rw" as const;
  async preflight(): Promise<Record<string, boolean | null>> {
    return { direct: true, sharedWorkspace: true, directTmpRoot: true };
  }
  async openSession(): Promise<{ sharedMode: "ro" | "rw"; tmpPath: string }> {
    return { sharedMode: "rw", tmpPath: "/tmp/aster-direct" };
  }
  async closeSession(): Promise<void> {}
  async execute(): Promise<{ exitCode: number; durationMs: number }> {
    throw new Error("nested calls must not use the direct host");
  }
  async fileRequest(): Promise<unknown> {
    throw new Error("nested files must not use the direct host");
  }
}

/** A transport that answers each request with one synthetic frame, for error classification tests. */
function scriptedTransport(
  respond: (frame: RpcRequestFrame) => RpcFrame,
): RpcClientTransport {
  return {
    async connect(): Promise<RpcConnection> {
      let onFrame: (frame: RpcFrame) => void = () => {};
      return {
        closed: false,
        send(frame: RpcFrame): void {
          if (frame.kind !== "request") return;
          setImmediate(() => onFrame(respond(frame)));
        },
        close(): void {},
        onFrame(handler: (frame: RpcFrame) => void): () => void {
          onFrame = handler;
          return () => { onFrame = () => {}; };
        },
        onClose(): () => void {
          return () => {};
        },
      };
    },
  };
}

test("real codemode write and read produce tool.write and tool.read observations", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-trace-local-"));
  const { exporter, runtime } = traceSetup();
  const fixture = modelFixture();
  let transcript: { messages: readonly Message[] } | undefined;
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", {
      code: [
        "const w = await tools.write({ path: 'trace.txt', content: 'trace-body' });",
        "const r = await tools.read({ path: 'trace.txt' });",
        "text(r);",
      ].join("\n"),
    }, { id: "script" }), { stopReason: "toolUse" }),
    (seen) => {
      transcript = seen;
      return fauxAssistantMessage("done");
    },
  ]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
  } finally {
    await app?.close();
    await runtime.close();
  }
  const spans = exporter.getFinishedSpans();
  const codemode = spanByName(spans, "codemode");
  assert.equal(observationType(codemode), "tool");
  const write = spanByName(spans, "tool.write");
  const read = spanByName(spans, "tool.read");
  assert.equal(captured(codemode, "input"), undefined, "content capture is off by default");
  assert.equal(captured(codemode, "output"), undefined, "content capture is off by default");
  assert.equal(captured(write, "input"), undefined, "tool arguments stay out by default");
  assert.equal(captured(read, "output"), undefined, "tool results stay out by default");
  for (const [span, tool] of [[write, "write"], [read, "read"]] as const) {
    assert.equal(observationType(span), "tool", `${tool} is a tool observation`);
    assert.equal(span.parentSpanContext?.spanId, codemode.spanContext().spanId);
    assert.equal(metadata(span, "tool"), tool);
    assert.equal(metadata(span, "outcome"), "ok");
    assert.ok(Number(metadata(span, "durationMs")) >= 0, `${tool} has a duration`);
  }
  assert.equal(spans.some((span) => span.name === "nested.tool"), false, "the old generic name is gone");
  const results = transcript?.messages.filter((message) => message.role === "toolResult") ?? [];
  assert.equal(results.length, 1, "only the codemode result enters the transcript");
  assert.match(toolResultText(transcript!, "script"), /trace-body/);
  await rm(directory, { recursive: true, force: true });
});

test("content capture records the raw script, the executed script, and nested tool calls", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-trace-capture-"));
  const { exporter, runtime } = traceSetup({ captureContent: true });
  const fixture = modelFixture();
  const code = [
    "const w = await tools.write({ path: 'capture.txt', content: 'capture-body' });",
    "const r = await tools.read({ path: 'capture.txt' });",
    "text(r);",
  ].join("\n");
  let transcript: { messages: readonly Message[] } | undefined;
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: "script" }), { stopReason: "toolUse" }),
    (seen) => {
      transcript = seen;
      return fauxAssistantMessage("done");
    },
  ]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
  } finally {
    await app?.close();
    await runtime.close();
  }
  const spans = exporter.getFinishedSpans();
  const codemode = spanByName(spans, "codemode");
  assert.deepEqual(captured(codemode, "input"), { code }, "the model's raw code is the codemode input");
  const output = capturedText(captured(codemode, "output"));
  assert.equal(output, toolResultText(transcript!, "script"), "the codemode output is the model-visible tool result");

  const prepared = spanByName(spans, "codemode.prepared");
  assert.equal(prepared.parentSpanContext?.spanId, codemode.spanContext().spanId);
  assert.deepEqual(
    captured(prepared, "input"),
    { code: prepareCodemodeScript(code, true) },
    "the prepared observation holds the script QuickJS actually received",
  );
  assert.equal(metadata(prepared, "scriptChanged"), true);

  const write = spanByName(spans, "tool.write");
  const read = spanByName(spans, "tool.read");
  assert.deepEqual(captured(write, "input"), {
    tool: "write",
    arguments: { path: "capture.txt", content: "capture-body" },
  });
  assert.deepEqual(captured(read, "input"), {
    tool: "read",
    arguments: { path: "capture.txt" },
  });
  assert.match(JSON.stringify(captured(read, "output")), /capture-body/);
  assert.equal((captured(write, "output") as { isError?: boolean }).isError, false);
  assert.equal(
    transcript?.messages.filter((message) => message.role === "toolResult").length,
    1,
    "captured content never becomes an extra tool result",
  );
  await rm(directory, { recursive: true, force: true });
});

test("captured content redacts credentials and bounds oversized values", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-trace-capture-redact-"));
  const { exporter, runtime } = traceSetup({ captureContent: true });
  const fixture = modelFixture();
  const secret = "SUPERSECRETTOKEN1234567890";
  const apiKey = "sk-abcdefgh12345678";
  const code = [
    `const body = "Authorization: Bearer ${secret}\\napi_key=${apiKey}\\n" + "x".repeat(70000);`,
    "await tools.write({ path: 'large.txt', content: body });",
    "const r = await tools.read({ path: 'large.txt' });",
    "text(r);",
  ].join("\n");
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: "script" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
  } finally {
    await app?.close();
    await runtime.close();
  }
  const spans = exporter.getFinishedSpans();
  const write = spanByName(spans, "tool.write");
  const input = captured(write, "input") as { arguments: { content: string } };
  assert.match(input.arguments.content, /\[REDACTED\]/);
  assert.equal(input.arguments.content.includes(secret), false);
  assert.equal(input.arguments.content.includes(apiKey), false);
  assert.match(input.arguments.content, /\[truncated \d+ bytes\]/);
  const exported = JSON.stringify(spans.map((span) => span.attributes));
  assert.equal(exported.includes(secret), false, "the bearer token never reaches the trace");
  assert.equal(exported.includes(apiKey), false, "the API key never reaches the trace");
  assert.ok(
    Buffer.byteLength(JSON.stringify(write.attributes), "utf8") < 80 * 1024,
    "one observation's captured content stays bounded",
  );
  await rm(directory, { recursive: true, force: true });
});

test("real codemode bash produces a tool.bash observation", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-trace-bash-"));
  const { exporter, runtime } = traceSetup();
  const fixture = modelFixture();
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", {
      code: "const r = await tools.bash({ command: 'echo trace-bash' });\ntext(r.output);",
    }, { id: "script" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
  } finally {
    await app?.close();
    await runtime.close();
  }
  const spans = exporter.getFinishedSpans();
  const codemode = spanByName(spans, "codemode");
  const bash = spanByName(spans, "tool.bash");
  assert.equal(observationType(bash), "tool");
  assert.equal(bash.parentSpanContext?.spanId, codemode.spanContext().spanId);
  assert.equal(metadata(bash, "tool"), "bash");
  assert.equal(metadata(bash, "outcome"), "ok");
  assert.ok(Number(metadata(bash, "durationMs")) >= 0);
  await rm(directory, { recursive: true, force: true });
});

test("nested failures and authorization denials keep their code on tool observations", async () => {
  const { exporter, runtime } = traceSetup();
  const codemode = beginTrace({
    conversationId: "trace-paths" as never,
    taskId: 1 as never,
    name: "codemode",
  });
  assert.ok(codemode);
  const fake = defineTool({
    name: "fake-codemode",
    description: "Calls two nested tools.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      await api.executeTool("read", {}, context);
      await api.executeTool("write", {}, context);
      return { output: [{ type: "text" as const, text: "done" }] };
    },
  });
  const wrapped = serializeNestedCalls(fake);
  const api = {
    executeTool: async (name: string) => name === "read"
      ? {
        taskId: 1,
        isError: true,
        output: [{ type: "text", text: "missing" }],
        details: { code: "FILE_NOT_FOUND" },
        diagnostics: [{ severity: "error", code: "FILE_NOT_FOUND", message: "missing" }],
      }
      : {
        taskId: 2,
        isError: true,
        output: [{ type: "text", text: "denied" }],
        details: { code: "TOOL_AUTHZ_DENIED" },
        diagnostics: [{ severity: "error", code: "TOOL_AUTHZ_DENIED", message: "denied" }],
      },
  } as unknown as ToolExecutionApi;
  await codemode.run(() => wrapped.execute({}, api, BACKGROUND_CONTEXT));
  await runtime.close();

  const spans = exporter.getFinishedSpans();
  const failed = spanByName(spans, "tool.read");
  const denied = spanByName(spans, "tool.write");
  for (const [span, code] of [[failed, "FILE_NOT_FOUND"], [denied, "TOOL_AUTHZ_DENIED"]] as const) {
    assert.equal(observationType(span), "tool");
    assert.equal(span.parentSpanContext?.spanId, codemode.spanContext.spanId);
    assert.equal(metadata(span, "outcome"), "error");
    assert.equal(metadata(span, "errorCode"), code);
    assert.equal(span.attributes["langfuse.observation.level"], "ERROR");
  }
});

test("remote codemode keeps RPC spans under the tool and treats settled cancel as a no-op", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-trace-remote-"));
  const workspace = join(directory, "sandbox-workspace");
  await mkdir(workspace, { recursive: true });
  const [ca, serverCert, serverKey, clientCert, clientKey] = await Promise.all([
    readFile(join(fixtureDirectory, "ca.crt")),
    readFile(join(fixtureDirectory, "server.crt")),
    readFile(join(fixtureDirectory, "server.key")),
    readFile(join(fixtureDirectory, "client.crt")),
    readFile(join(fixtureDirectory, "client.key")),
  ]);
  const ptc = new TestPtcHost({ workspacePath: workspace });
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
  const rpcAgent = startRpcAgent({
    server: rpcServer,
    executionId: "0000000000000009",
    transport: "tls",
    heartbeatMs: 60_000,
    sessionTtlMs: 60_000,
    testExecutorEnabled: true,
    ptc,
    direct: new AuditDirectHost(),
  });
  const { exporter, runtime } = traceSetup();
  const fixture = modelFixture();
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", {
      code: [
        "const w = await tools.write({ path: 'remote.txt', content: 'remote-body' });",
        "const r = await tools.read({ path: 'remote.txt' });",
        "text(r);",
      ].join("\n"),
    }, { id: "script" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
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
    assert.equal(await app.reply(request, running), "done");
  } finally {
    await app?.close();
    await runtime.close();
    await rpcAgent.close();
    await rpcServer.close();
  }
  const spans = exporter.getFinishedSpans();
  const codemode = spanByName(spans, "codemode");
  for (const name of ["tool.write", "tool.read"]) {
    const tool = spanByName(spans, name);
    assert.equal(observationType(tool), "tool");
    assert.equal(tool.parentSpanContext?.spanId, codemode.spanContext().spanId);
    assert.equal(metadata(tool, "outcome"), "ok");
  }
  const write = spanByName(spans, "tool.write");
  const read = spanByName(spans, "tool.read");
  const writeRpc = spanByName(spans, "rpc.file.write");
  const readRpc = spanByName(spans, "rpc.file.read");
  assert.equal(writeRpc.parentSpanContext?.spanId, write.spanContext().spanId);
  assert.equal(readRpc.parentSpanContext?.spanId, read.spanContext().spanId);
  const canonical = spans.filter((span) => span.name === "rpc.file.canonical");
  assert.ok(canonical.length >= 1);
  assert.ok(canonical.some((span) => metadata(span, "probe") === "missing"), "the new-file probe is marked");
  for (const span of canonical) {
    assert.equal(metadata(span, "outcome"), "ok", "a canonical miss is not an execution failure");
  }
  const cancel = spanByName(spans, "rpc.cancel");
  assert.equal(metadata(cancel, "outcome"), "ok");
  assert.equal(metadata(cancel, "cancelOutcome"), "not_active");
  assert.equal(metadata(cancel, "errorCode"), "not_found");
  assert.equal(cancel.attributes["langfuse.observation.level"], "DEFAULT");
  await rm(directory, { recursive: true, force: true });
});

test("a real cancel failure and an unexpected canonical error stay errors", async () => {
  const { exporter, runtime } = traceSetup();
  const codemode = beginTrace({
    conversationId: "trace-paths" as never,
    taskId: 2 as never,
    name: "codemode",
  });
  assert.ok(codemode);
  const client = new RpcExecutionClient({
    transport: scriptedTransport((frame) => {
      const error = frame.method === "cancel"
        ? { code: "internal" as const, message: "cancel failed", outcome: "failed" as const }
        : { code: "permission_denied" as const, message: "outside the workspace", outcome: "failed" as const };
      return { v: 1, kind: "response", id: frame.id, status: "error", error };
    }),
    requestTimeoutMs: 5_000,
  });
  try {
    await client.connect();
    await assert.rejects(
      codemode.run(() => client.cancel("0123456789abcdef", "target-1")),
      (error: unknown) => error instanceof RpcClientError && error.code === "internal",
    );
    await assert.rejects(
      codemode.run(() => client.fileRequest("0123456789abcdef", "file.canonical", { path: "/etc/passwd" })),
      (error: unknown) => error instanceof RpcClientError && error.code === "permission_denied",
    );
  } finally {
    await client.close();
    await runtime.close();
  }
  const spans = exporter.getFinishedSpans();
  const cancel = spanByName(spans, "rpc.cancel");
  assert.equal(metadata(cancel, "outcome"), "error");
  assert.equal(metadata(cancel, "errorCode"), "internal");
  assert.equal(metadata(cancel, "cancelOutcome"), undefined);
  assert.equal(cancel.attributes["langfuse.observation.level"], "ERROR");
  const canonical = spanByName(spans, "rpc.file.canonical");
  assert.equal(metadata(canonical, "outcome"), "error");
  assert.equal(metadata(canonical, "errorCode"), "permission_denied");
  assert.equal(metadata(canonical, "probe"), undefined);
  assert.equal(canonical.attributes["langfuse.observation.level"], "ERROR");
});

test("closing the trace runtime before a request leaves execution unchanged", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-trace-closed-"));
  const { exporter, runtime } = traceSetup();
  await runtime.close();
  const fixture = modelFixture();
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", {
      code: [
        "await tools.write({ path: 'closed.txt', content: 'still-runs' });",
        "text('closed-ok');",
      ].join("\n"),
    }, { id: "script" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
    assert.equal(await readFile(join(directory, "workspace", "closed.txt"), "utf8"), "still-runs");
  } finally {
    await app?.close();
  }
  assert.deepEqual(exporter.getFinishedSpans(), [], "a closed trace runtime exports nothing");
  await rm(directory, { recursive: true, force: true });
});
