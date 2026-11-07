import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { ConversationId, TaskId, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ConfigurationError, readTraceConfig } from "../src/config.js";
import {
  beginRequest,
  beginTrace,
  currentSpan,
  recordGeneration,
  recordLoopGuard,
  recordRegistryDecision,
  startTrace,
  traceChild,
  traceExtension,
  type TraceRuntime,
} from "../src/trace.js";

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, provider };
}

function spanByName(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  assert.ok(span, `missing span ${name}; got ${spans.map(({ name }) => name).join(", ")}`);
  return span;
}

function afterToolHook(runtime: TraceRuntime) {
  const registration = runtime.extension.hooks?.[0];
  assert.ok(registration, "trace extension registers one hook");
  return (registration.handlers as {
    afterTool(
      call: ToolHookCall,
      result: ToolExecutionResult,
      api: { conversationId: ConversationId; taskId: TaskId },
    ): unknown;
  }).afterTool;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "PROMPT_SECRET final answer" }],
    api: "chat",
    provider: "openai",
    model: "faux-1",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now() - 50,
    durationMs: 50,
    ...overrides,
  };
}

test("trace config reads Langfuse keys and keeps tracing optional", () => {
  assert.deepEqual(readTraceConfig({}), { enabled: false });
  assert.equal(readTraceConfig({}).captureContent, undefined, "content capture is off by default");
  assert.equal(readTraceConfig({ LANGFUSE_CAPTURE_CONTENT: "1" }).captureContent, true);
  assert.equal(readTraceConfig({ LANGFUSE_CAPTURE_CONTENT: "true" }).captureContent, true);
  assert.equal(readTraceConfig({ LANGFUSE_CAPTURE_CONTENT: "0" }).captureContent, undefined);
  assert.throws(
    () => readTraceConfig({ LANGFUSE_CAPTURE_CONTENT: "yes" }),
    (error: unknown) => error instanceof ConfigurationError,
  );

  const configured = readTraceConfig({
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
    LANGFUSE_HOST: "https://langfuse.example",
  });
  assert.deepEqual(configured, {
    enabled: true,
    publicKey: "pk-test",
    secretKey: "sk-test",
    baseUrl: "https://langfuse.example",
  });

  assert.equal(readTraceConfig({
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
    LANGFUSE_TRACING_ENABLED: "0",
  }).enabled, false);

  // An explicit request without keys stays enabled so startTrace can explain why it is a no-op.
  assert.deepEqual(readTraceConfig({ LANGFUSE_TRACING_ENABLED: "1" }), { enabled: true });

  assert.throws(
    () => readTraceConfig({ LANGFUSE_TRACING_ENABLED: "yes" }),
    (error: unknown) => error instanceof ConfigurationError,
  );
});

test("request, root tool, nested tool and RPC spans share one trace and nest", () => {
  const { exporter, provider } = setup();
  let logs = 0;
  const runtime = startTrace({ enabled: true }, () => { logs += 1; }, { tracerProvider: provider });
  assert.ok(runtime);
  assert.equal(traceExtension(), runtime.extension, "the composition root installs this hook carrier");

  const request = beginRequest({
    conversationId: 1,
    requestId: "console:bot-one:req-00000001",
    fields: { textBytes: 123 },
  });
  assert.ok(request);
  const rootTool = beginTrace({
    conversationId: 1 as ConversationId,
    taskId: 1 as TaskId,
    callId: "call-1",
    name: "tool-root",
    fields: { scriptBytes: 42 },
  });
  assert.ok(rootTool);

  const nested = rootTool.run(() => {
    recordRegistryDecision({
      tool: "read",
      decision: "allow",
      code: "TOOL_ALLOWED",
      authority: "owner",
      conversationId: 1 as ConversationId,
      taskId: 1 as TaskId,
    });
    return traceChild("tool.read", { tool: "read", argsBytes: 9 }, "tool");
  });
  assert.ok(nested);
  const rpc = nested.run(() => currentSpan()?.child("rpc.file.readText", { pathBytes: 8 }));
  assert.ok(rpc);
  rpc.end("ok");
  nested.end("ok", { isError: false, outputItems: 1 });
  afterToolHook(runtime)(
    { type: "toolCall", id: "call-1", name: "tool-root", arguments: {} },
    { isError: false, output: [{ type: "text", text: "ok" }], diagnostics: [] },
    { conversationId: 1 as ConversationId, taskId: 1 as TaskId },
  );
  request.end("ok", { replyBytes: 2 });

  const spans = exporter.getFinishedSpans();
  const requestSpan = spanByName(spans, "agent.request");
  const rootToolSpan = spanByName(spans, "tool-root");
  const nestedSpan = spanByName(spans, "tool.read");
  const rpcSpan = spanByName(spans, "rpc.file.readText");
  const decision = spanByName(spans, "registry.decision");

  for (const span of [requestSpan, rootToolSpan, nestedSpan, rpcSpan, decision]) {
    assert.equal(span.spanContext().traceId, request.traceId, `${span.name} joins the request trace`);
  }
  assert.equal(rootToolSpan.parentSpanContext?.spanId, request.spanId);
  assert.equal(nestedSpan.parentSpanContext?.spanId, rootTool.spanId);
  assert.equal(rpcSpan.parentSpanContext?.spanId, nested.spanId);
  assert.equal(decision.parentSpanContext?.spanId, rootTool.spanId);
  assert.equal(requestSpan.attributes["langfuse.observation.metadata.scriptBytes"], undefined);
  assert.equal(rootToolSpan.attributes["langfuse.observation.metadata.scriptBytes"], "42");
  assert.equal(rootToolSpan.attributes["langfuse.observation.metadata.outcome"], "\"ok\"");
  assert.equal(decision.attributes["langfuse.observation.metadata.decision"], "\"allow\"");
  assert.equal(logs, 0, "no tracing warnings during a healthy export");

  return runtime.close();
});

test("an LLM generation joins the request trace without uploading prompt or output text", () => {
  const { exporter, provider } = setup();
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);
  const request = beginRequest({ conversationId: 2, requestId: "console:bot-two:req-00000002" });
  assert.ok(request);

  recordGeneration(assistantMessage({
    content: [
      { type: "thinking", thinking: "THINKING_SECRET" },
      { type: "text", text: "PROMPT_SECRET body" },
      { type: "toolCall", id: "tool-1", name: "tool-root", arguments: {} },
    ],
    errorMessage: "PROVIDER_SECRET error text",
  }), { conversationId: 2 as ConversationId, taskId: 2 as TaskId });
  request.end("ok", { replyBytes: 4 });

  const generation = spanByName(exporter.getFinishedSpans(), "llm.generation");
  assert.equal(generation.spanContext().traceId, request.traceId);
  assert.equal(generation.parentSpanContext?.spanId, request.spanId);
  assert.equal(generation.attributes["langfuse.observation.type"], "generation");
  assert.equal(generation.attributes["langfuse.observation.model.name"], "faux-1");
  assert.match(String(generation.attributes["langfuse.observation.usage_details"]), /"total":30/);
  assert.equal(generation.attributes["langfuse.observation.metadata.stopReason"], "\"stop\"");
  assert.equal(generation.attributes["langfuse.observation.metadata.toolCalls"], "1");

  const exported = JSON.stringify(generation.attributes);
  for (const secret of ["PROMPT_SECRET", "THINKING_SECRET", "PROVIDER_SECRET"]) {
    assert.equal(exported.includes(secret), false, `${secret} must not be exported`);
  }

  return runtime.close();
});

test("loop guard halt ends the request as halted without exporting tool arguments", () => {
  const { exporter, provider } = setup();
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);
  const request = beginRequest({ conversationId: 3 });
  assert.ok(request);

  recordLoopGuard({
    conversationId: 3 as ConversationId,
    taskId: 3 as TaskId,
    callId: "call-3",
    tool: "bash",
    count: 6,
  }, "LOOP_GUARD_HALT");
  request.end("ok", { replyBytes: 1 });

  const halt = spanByName(exporter.getFinishedSpans(), "loop_guard.halt");
  assert.equal(halt.parentSpanContext?.spanId, request.spanId);
  assert.equal(halt.attributes["langfuse.observation.metadata.count"], "6");
  const requestSpan = spanByName(exporter.getFinishedSpans(), "agent.request");
  assert.equal(requestSpan.attributes["langfuse.observation.metadata.outcome"], "\"halted\"");
  assert.equal(requestSpan.attributes["langfuse.observation.status_message"], "AGENT_LOOP_DETECTED");

  return runtime.close();
});

test("the real Langfuse processor exports only the observations we create", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk-test",
    secretKey: "sk-test",
    exporter,
    exportMode: "immediate",
    mediaUploadEnabled: false,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);

  const request = beginRequest({ conversationId: 4, fields: { textBytes: 7 } });
  assert.ok(request);
  request.end("ok", { replyBytes: 2 });
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.name, "agent.request");
  assert.equal(spans[0]!.attributes["langfuse.observation.type"], "agent");

  await runtime.close();
});

test("Langfuse export crosses the configured proxy so MITM can substitute credentials", async () => {
  const seen: { url?: string; authorization?: string; publicKey?: string } = {};
  const proxy = createServer((request, response) => {
    seen.url = request.url;
    const authorization = request.headers.authorization;
    seen.authorization = Array.isArray(authorization) ? authorization[0] : authorization;
    const publicKey = request.headers["x-langfuse-public-key"];
    seen.publicKey = Array.isArray(publicKey) ? publicKey[0] : publicKey;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  const proxyKeys = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;
  const saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
  // Windows environment names are case-insensitive, so clear both spellings before assigning.
  for (const key of proxyKeys) delete process.env[key];
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  try {
    const runtime = startTrace({
      enabled: true,
      publicKey: "__vault_LANGFUSE_PUBLIC_KEY__",
      secretKey: "__vault_LANGFUSE_SECRET_KEY__",
      baseUrl: "http://langfuse.invalid",
    });
    assert.ok(runtime);
    const request = beginRequest({ conversationId: 8 });
    assert.ok(request);
    request.end("ok", { replyBytes: 1 });
    await runtime.close();
  } finally {
    for (const key of proxyKeys) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }

  assert.equal(seen.url, "http://langfuse.invalid/api/public/otel/v1/traces");
  assert.equal(
    seen.authorization,
    `Basic ${Buffer.from("__vault_LANGFUSE_PUBLIC_KEY__:__vault_LANGFUSE_SECRET_KEY__", "utf8").toString("base64")}`,
    "credentials stay encoded so the MITM proxy can decode and substitute them",
  );
  assert.equal(seen.publicKey, "__vault_LANGFUSE_PUBLIC_KEY__");
});

test("an exporter failure never escapes the tracing boundary", async () => {
  const logs: string[] = [];
  const exporter: SpanExporter = {
    export() {
      throw new Error("offline");
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk-test",
    secretKey: "sk-test",
    exporter,
    exportMode: "immediate",
    mediaUploadEnabled: false,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const runtime = startTrace({ enabled: true }, (line) => logs.push(line), { tracerProvider: provider });
  assert.ok(runtime);

  const request = beginRequest({ conversationId: 6 });
  assert.ok(request);
  assert.doesNotThrow(() => {
    request.end("ok", { replyBytes: 1 });
    recordGeneration(assistantMessage(), { conversationId: 6 as ConversationId, taskId: 6 as TaskId });
    recordLoopGuard({
      conversationId: 6 as ConversationId,
      taskId: 6 as TaskId,
      callId: "call-6",
      tool: "bash",
      count: 6,
    }, "LOOP_GUARD_WARNING");
  });
  await assert.doesNotReject(runtime.close());
});

test("disabled tracing is a no-op and a requested but keyless runtime logs once", async () => {
  assert.equal(startTrace({ enabled: false }), undefined);
  assert.equal(traceExtension(), undefined);
  assert.equal(beginRequest({ conversationId: 5 }), undefined);
  assert.doesNotThrow(() => recordGeneration(assistantMessage(), {
    conversationId: 5 as ConversationId,
    taskId: 5 as TaskId,
  }));

  const logs: string[] = [];
  assert.equal(startTrace({ enabled: true }, (line) => logs.push(line)), undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY/);
});
