// Langfuse Cloud tracing for one agent request and everything it executes.
//
// Interface
//   startTrace(config)                    install the process-wide runtime; undefined when disabled
//   beginRequest(meta)                    start the root observation for one user request
//   beginTrace(meta)                      start a tool span below that request
//   currentSpan() / traceChild(...)       attach child observations to the ambient tool span
//   recordGeneration(...)                 one LLM generation, from the existing response hook
//   recordRegistryDecision(...)           one authorization decision, allow or deny
//   recordLoopGuard(...)                  warning/halt evidence, correlated to its request or tool span
//   TraceRuntime.close()                  end abandoned observations, flush, release Langfuse
//
// Inputs: host-observed identifiers (conversation, request, task, call, session, job) and lengths,
// counts and error codes. With LANGFUSE_CAPTURE_CONTENT enabled, tool span inputs, tool
// arguments and tool results are also attached as observation input/output after credential
// redaction and size limits. Credentials, authorization headers and provider error messages never
// enter the trace.
//
// Errors: tracing is diagnostics. A construction or export failure disables tracing and is logged
// once; it never propagates into a tool call, RPC request, hook or shutdown path.
//
// Side effects: OpenTelemetry spans exported to Langfuse over OTLP. Nothing is written to disk.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanContext, TracerProvider } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseSpan,
} from "@langfuse/tracing";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  Extension,
  HookApi,
  NestedToolExecutionResult,
  TaskId,
  ToolExecutionResult,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { hasProxyEnv, type TraceConfig } from "./config.js";

/** Active requests and active root tool runs are bounded; the oldest is ended as unknown. */
const ACTIVE_LIMIT = 256;
/** One trace may not grow without bound through nested events. */
const MAX_EVENTS_PER_SPAN = 256;
const FLUSH_TIMEOUT_MS = 5_000;
/** One captured string field may not exceed this; longer values are cut with a marker. */
const MAX_CONTENT_STRING_BYTES = 32 * 1024;
/** One observation's serialized input or output is capped as a whole. */
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_CONTENT_DEPTH = 6;
const MAX_CONTENT_ITEMS = 100;
const REDACTED = "[REDACTED]";

/** Host-side keys whose values are credentials, never captured even in content mode. */
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;

/** Credential shapes that survive inside otherwise ordinary text (commands, files, outputs). */
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replace: string }[] = [
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  { pattern: /\b(Basic)\s+[A-Za-z0-9+/=]{8,}/gi, replace: `$1 ${REDACTED}` },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  {
    pattern: /\b(api[_-]?key|access[_-]?key|secret|token|password|passwd)\s*[:=]\s*(["']?)([^\s"',;]{6,})\2/gi,
    replace: `$1=$2${REDACTED}$2`,
  },
];

export type TraceFields = Readonly<Record<string, string | number | boolean | undefined>>;
export type TraceOutcome = "ok" | "error" | "aborted" | "unknown" | "halted";
export type TraceSpanKind = "span" | "tool" | "agent";

type Identity = {
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly callId?: string;
};

type CompactFields = Record<string, string | number | boolean>;

function compact(fields: TraceFields): CompactFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as CompactFields;
}

/** UTF-8 length of a string, or undefined for anything else. Content is never retained. */
export function stringBytes(value: unknown): number | undefined {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : undefined;
}

/** Approximate argument size without serializing or retaining nested values. */
export function argumentBytes(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  let total = 0;
  let found = false;
  for (const entry of Object.values(value)) {
    if (typeof entry === "string") {
      total += Buffer.byteLength(entry, "utf8");
      found = true;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      total += 8;
      found = true;
    }
  }
  return found ? total : undefined;
}

/** Keep whole UTF-8 characters while cutting a string to its byte budget. */
function truncateContentText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  let kept = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    kept += character;
    used += size;
  }
  return `${kept}\n…[truncated ${bytes - used} bytes]`;
}

function redactContentText(value: string): string {
  let text = value;
  for (const { pattern, replace } of SECRET_PATTERNS) text = text.replace(pattern, replace);
  return truncateContentText(text, MAX_CONTENT_STRING_BYTES);
}

function sanitizeContent(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactContentText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_CONTENT_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_CONTENT_ITEMS).map((item) => sanitizeContent(item, depth + 1));
    if (value.length > MAX_CONTENT_ITEMS) kept.push(`[${value.length - MAX_CONTENT_ITEMS} more items]`);
    return kept;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_CONTENT_ITEMS)) {
    result[truncateContentText(key, 128)] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeContent(item, depth + 1);
  }
  if (entries.length > MAX_CONTENT_ITEMS) {
    result["…"] = `[${entries.length - MAX_CONTENT_ITEMS} more keys]`;
  }
  return result;
}

/**
 * Content capture is opt-in. Redact credential-shaped keys and values first, then bound each string
 * and the whole payload; a value over the total cap keeps a JSON preview plus its original size.
 * The caller's object is never modified.
 */
export function traceContent(value: unknown): unknown {
  const sanitized = sanitizeContent(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitized) ?? "null";
  } catch {
    return "[unserializable]";
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_CONTENT_BYTES) return sanitized;
  return {
    truncated: true,
    originalBytes: bytes,
    preview: truncateContentText(serialized, MAX_CONTENT_BYTES),
  };
}

/** The model-visible part of a tool result; image bytes never leave the process. */
export function toolResultContent(result: ToolExecutionResult): unknown {
  return {
    isError: result.isError === true,
    output: (result.output ?? []).map((item) =>
      item.type === "text" ? { type: "text", text: item.text } : { type: item.type }),
  };
}

/**
 * A nested call returns its program-visible value (text/content for tools without a structured
 * schema, the validated value with one), not the model tool message. Capture that value only.
 */
export function nestedToolResultContent(result: NestedToolExecutionResult): unknown {
  return {
    isError: result.isError,
    ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
  };
}

function levelFor(outcome: TraceOutcome): "DEFAULT" | "WARNING" | "ERROR" {
  if (outcome === "ok") return "DEFAULT";
  if (outcome === "aborted" || outcome === "halted") return "WARNING";
  return "ERROR";
}

/** Fixed text only: an SDK error may quote a URL or payload. */
function errorLabel(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "unknown";
}

export class TraceSpan {
  readonly #observation: LangfuseSpan;
  readonly #log: (line: string) => void;
  readonly #captureContent: boolean;
  readonly traceId: string;
  readonly spanId: string;
  readonly spanContext: SpanContext;
  readonly #startedAt = performance.now();
  #ended = false;
  #haltCode: string | undefined;
  #events = 0;
  #truncated = false;

  private constructor(observation: LangfuseSpan, log: (line: string) => void, captureContent: boolean) {
    this.#observation = observation;
    this.#log = log;
    this.#captureContent = captureContent;
    this.spanContext = observation.otelSpan.spanContext();
    this.traceId = this.spanContext.traceId;
    this.spanId = this.spanContext.spanId;
  }

  static start(options: {
    readonly name: string;
    readonly kind?: TraceSpanKind;
    readonly fields?: TraceFields;
    readonly input?: unknown;
    readonly captureContent?: boolean;
    readonly parent?: SpanContext;
    readonly sessionId?: string;
    readonly log?: (line: string) => void;
  }): TraceSpan {
    const name = options.name.slice(0, 128);
    const captureContent = options.captureContent === true;
    const attributes = {
      metadata: compact(options.fields ?? {}),
      ...(captureContent && options.input !== undefined ? { input: traceContent(options.input) } : {}),
    };
    const parent = options.parent === undefined ? {} : { parentSpanContext: options.parent };
    let observation: LangfuseSpan;
    switch (options.kind ?? "span") {
      case "tool":
        observation = startObservation(name, attributes, { asType: "tool", ...parent });
        break;
      case "agent":
        observation = startObservation(name, attributes, { asType: "agent", ...parent });
        break;
      default:
        observation = startObservation(name, attributes, parent);
    }
    if (options.sessionId !== undefined) {
      observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, options.sessionId.slice(0, 200));
    }
    if (options.parent === undefined) {
      observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, name);
    }
    return new TraceSpan(observation, options.log ?? console.error, captureContent);
  }

  get haltedCode(): string | undefined {
    return this.#haltCode;
  }

  markHalted(code: string): void {
    this.#haltCode = code;
  }

  /** Compact wire correlation: `<traceId>.<spanId>` is 49 bytes, well under the 128-byte frame bound. */
  get correlationId(): string {
    return `${this.traceId}.${this.spanId}`;
  }

  event(name: string, fields: TraceFields = {}): void {
    if (this.#ended) return;
    if (this.#events >= MAX_EVENTS_PER_SPAN) {
      if (this.#truncated) return;
      this.#truncated = true;
      this.#emit("events.truncated", { droppedAfter: MAX_EVENTS_PER_SPAN });
      return;
    }
    this.#events += 1;
    this.#emit(name, fields);
  }

  child(
    name: string,
    fields: TraceFields = {},
    kind: TraceSpanKind = "span",
    input?: unknown,
  ): TraceSpan | undefined {
    return startSpan({
      name,
      kind,
      fields,
      captureContent: this.#captureContent,
      ...(input === undefined ? {} : { input }),
      parent: this.spanContext,
      log: this.#log,
    });
  }

  run<T>(fn: () => T): T {
    return spanStorage.run(this, fn);
  }

  end(outcome: TraceOutcome, fields: TraceFields = {}, output?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    const finalOutcome = this.#haltCode !== undefined && outcome !== "unknown" && outcome !== "aborted"
      ? "halted"
      : outcome;
    const errorCode = typeof fields.errorCode === "string" ? fields.errorCode : undefined;
    // A halt is a business outcome the host may surface as success; its code still belongs in the trace.
    const statusCode = errorCode ?? (finalOutcome === "halted" ? this.#haltCode : undefined);
    try {
      this.#observation.update({
        level: levelFor(finalOutcome),
        ...(statusCode === undefined ? {} : { statusMessage: statusCode.slice(0, 128) }),
        ...(this.#captureContent && output !== undefined ? { output: traceContent(output) } : {}),
        metadata: {
          ...compact(fields),
          ...(errorCode === undefined ? {} : { errorCode: errorCode.slice(0, 128) }),
          outcome: finalOutcome,
          durationMs: Math.max(0, Math.round(performance.now() - this.#startedAt)),
        },
      });
      this.#observation.end();
    } catch (error) {
      this.#report(error);
    }
  }

  #emit(name: string, fields: TraceFields): void {
    try {
      startObservation(name.slice(0, 128), { metadata: compact(fields) }, {
        asType: "event",
        parentSpanContext: this.spanContext,
      });
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    this.#log(`Langfuse trace span failed: ${errorLabel(error)}`);
  }
}

const spanStorage = new AsyncLocalStorage<TraceSpan>();

/** Span creation is diagnostics too: an SDK failure must not break the operation it observes. */
function startSpan(options: Parameters<typeof TraceSpan.start>[0]): TraceSpan | undefined {
  try {
    return TraceSpan.start(options);
  } catch (error) {
    (options.log ?? console.error)(`Langfuse trace span failed: ${errorLabel(error)}`);
    return undefined;
  }
}

export function currentSpan(): TraceSpan | undefined {
  return spanStorage.getStore();
}

export function traceChild(
  name: string,
  fields: TraceFields = {},
  kind: TraceSpanKind = "span",
  input?: unknown,
): TraceSpan | undefined {
  return currentSpan()?.child(name, fields, kind, input);
}

export type BeginTraceOptions = Identity & {
  readonly name: string;
  readonly kind?: TraceSpanKind;
  readonly fields?: TraceFields;
  /** Captured as the observation input when content capture is enabled. */
  readonly input?: unknown;
};

export type TraceDependencies = {
  /** Test seam: export into another provider instead of a Langfuse processor. */
  readonly tracerProvider?: TracerProvider;
};

export class TraceRuntime {
  readonly extension: Extension;
  readonly #provider: TracerProvider;
  readonly #ownsProvider: boolean;
  readonly #captureContent: boolean;
  readonly #log: (line: string) => void;
  readonly #requests = new Map<string, TraceSpan>();
  readonly #toolSpans = new Map<string, TraceSpan>();
  #closing = false;

  constructor(provider: TracerProvider, log: (line: string) => void, ownsProvider: boolean, captureContent = false) {
    this.#provider = provider;
    this.#log = log;
    this.#ownsProvider = ownsProvider;
    this.#captureContent = captureContent;
    this.extension = defineExtension({
      name: "langfuse-trace",
      hooks: [hook(ToolTask, { afterTool: (call, result, api) => this.#afterTool(call, result, api) })],
    });
  }

  beginRequest(options: {
    readonly conversationId: string | number;
    readonly requestId?: string;
    readonly fields?: TraceFields;
  }): TraceSpan | undefined {
    if (this.#closing) return undefined;
    const key = String(options.conversationId);
    const previous = this.#requests.get(key);
    if (previous !== undefined) {
      this.#requests.delete(key);
      previous.end("unknown", { abandoned: true, reason: "superseded" });
    }
    evict(this.#requests);
    const span = startSpan({
      name: "agent.request",
      kind: "agent",
      sessionId: key,
      captureContent: this.#captureContent,
      fields: {
        conversationId: key,
        ...(options.requestId === undefined ? {} : { requestId: options.requestId.slice(0, 200) }),
        ...options.fields,
      },
      log: this.#log,
    });
    if (span === undefined) return undefined;
    this.#requests.set(key, span);
    return span;
  }

  requestFor(conversationId: ConversationId): TraceSpan | undefined {
    return this.#requests.get(String(conversationId));
  }

  begin(options: BeginTraceOptions): TraceSpan | undefined {
    if (this.#closing) return undefined;
    const parent = this.requestFor(options.conversationId);
    evict(this.#toolSpans);
    const span = startSpan({
      name: options.name,
      kind: options.kind ?? "tool",
      captureContent: this.#captureContent,
      ...(options.input === undefined ? {} : { input: options.input }),
      fields: options.fields ?? {},
      ...(parent === undefined ? {} : { parent: parent.spanContext }),
      log: this.#log,
    });
    if (span === undefined) return undefined;
    this.#toolSpans.set(`${String(options.conversationId)}\u0000${options.callId ?? ""}`, span);
    return span;
  }

  rootFor(conversationId: ConversationId, callId: string): TraceSpan | undefined {
    return this.#toolSpans.get(`${String(conversationId)}\u0000${callId}`);
  }

  recordGeneration(message: AssistantMessage, api: Pick<HookApi, "conversationId" | "taskId">): void {
    if (this.#closing) return;
    const parent = this.requestFor(api.conversationId);
    if (parent === undefined) return;
    try {
      const usage = message.usage;
      const observation = startObservation("llm.generation", {
        model: (message.responseModel ?? message.model).slice(0, 128),
        modelParameters: {
          provider: message.provider.slice(0, 128),
          api: message.api,
          ...(message.thinkingLevel === undefined ? {} : { thinkingLevel: message.thinkingLevel }),
        },
        usageDetails: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
        },
        ...(usage.cost.total > 0 ? { costDetails: { totalCost: usage.cost.total } } : {}),
        metadata: generationMetadata(message),
        ...(message.stopReason === "error"
          ? { level: "ERROR" as const, statusMessage: "MODEL_ERROR" }
          : {}),
      }, {
        asType: "generation",
        parentSpanContext: parent.spanContext,
        startTime: new Date(message.timestamp),
      });
      observation.end(message.durationMs === undefined
        ? undefined
        : new Date(message.timestamp + Math.max(0, message.durationMs)));
    } catch (error) {
      this.#report(error);
    }
  }

  recordLoopGuard(
    call: Identity & { tool: string; count: number; reason?: string },
    code: "LOOP_GUARD_WARNING" | "LOOP_GUARD_HALT",
  ): void {
    const span = this.rootFor(call.conversationId, call.callId ?? "")
      ?? this.requestFor(call.conversationId);
    if (span === undefined) return;
    span.event(code === "LOOP_GUARD_HALT" ? "loop_guard.halt" : "loop_guard.warning", {
      tool: call.tool.slice(0, 128),
      count: call.count,
      ...(call.reason === undefined ? {} : { reason: call.reason }),
    });
    if (code === "LOOP_GUARD_HALT") span.markHalted("AGENT_LOOP_DETECTED");
  }

  #afterTool(
    call: ToolHookCall,
    result: ToolExecutionResult,
    api: Pick<HookApi, "conversationId" | "taskId">,
  ): undefined {
    // A nested call belongs to its parent; the result belongs to the one root tool call.
    if (call.parent !== undefined) return undefined;
    const span = this.rootFor(api.conversationId, call.id);
    if (span === undefined) return undefined;
    const output = result.output ?? [];
    let textItems = 0;
    let imageItems = 0;
    let textBytes = 0;
    for (const item of output) {
      if (item.type === "text") {
        textItems += 1;
        textBytes += Buffer.byteLength(item.text, "utf8");
      } else if (item.type === "image") {
        imageItems += 1;
      }
    }
    const errorCode = resultErrorCode(result);
    span.end(result.isError === true ? "error" : "ok", {
      isError: result.isError === true,
      outputItems: output.length,
      textItems,
      imageItems,
      textBytes,
      ...(errorCode === undefined ? {} : { errorCode }),
    }, toolResultContent(result));
    return undefined;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const span of [...this.#toolSpans.values()]) span.end("unknown", { abandoned: true, reason: "closed" });
    this.#toolSpans.clear();
    for (const span of [...this.#requests.values()]) span.end("unknown", { abandoned: true, reason: "closed" });
    this.#requests.clear();
    setLangfuseTracerProvider(null);
    if (!this.#ownsProvider) return;
    const shutdown = (this.#provider as { shutdown?: () => Promise<void> }).shutdown;
    if (typeof shutdown !== "function") return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        shutdown.call(this.#provider),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (error) {
      this.#report(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #report(error: unknown): void {
    this.#log(`Langfuse tracing failed: ${errorLabel(error)}`);
  }
}

function evict(map: Map<string, TraceSpan>): void {
  while (map.size >= ACTIVE_LIMIT) {
    const oldest = map.entries().next();
    if (oldest.done) return;
    const [key, span] = oldest.value;
    map.delete(key);
    span.end("unknown", { abandoned: true, reason: "evicted" });
  }
}

/** Boundary metadata only. Prompt text, commands, paths and outputs stay out of the trace. */
function generationMetadata(message: AssistantMessage): CompactFields {
  let textItems = 0;
  let thinkingItems = 0;
  let toolCalls = 0;
  let textBytes = 0;
  let thinkingBytes = 0;
  for (const item of message.content) {
    if (item.type === "text") {
      textItems += 1;
      textBytes += Buffer.byteLength(item.text, "utf8");
    } else if (item.type === "thinking") {
      thinkingItems += 1;
      thinkingBytes += Buffer.byteLength(item.thinking, "utf8");
    } else if (item.type === "toolCall") {
      toolCalls += 1;
    }
  }
  return {
    provider: message.provider.slice(0, 128),
    api: message.api,
    model: message.model.slice(0, 128),
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel.slice(0, 128) }),
    stopReason: message.stopReason,
    outputItems: message.content.length,
    textItems,
    thinkingItems,
    toolCalls,
    textBytes,
    thinkingBytes,
  };
}

function resultErrorCode(result: ToolExecutionResult): string | undefined {
  const details = result.details;
  if (details !== null && typeof details === "object") {
    const code = (details as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const diagnostics = result.diagnostics;
  if (Array.isArray(diagnostics)) {
    for (const diagnostic of diagnostics) {
      if (diagnostic !== null && typeof diagnostic === "object") {
        const code = (diagnostic as { code?: unknown }).code;
        if (typeof code === "string") return code;
      }
    }
  }
  return result.isError === true ? "TOOL_ERROR" : undefined;
}

let activeRuntime: TraceRuntime | undefined;

/**
 * The Langfuse SDK's default exporter builds its own keep-alive agent, which bypasses Node's global
 * proxy configuration. In MITM deployments that means OTLP traffic never reaches the proxy and the
 * vault placeholders inside Authorization are never substituted. Build the same OTLP request with a
 * proxy-aware agent instead. Authentication headers match the SDK's request; configureEnvProxy() has
 * already put the proxy credentials into process.env.
 */
function proxyAwareExporter(keys: {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl?: string;
}): OTLPTraceExporter {
  const baseUrl = (keys.baseUrl ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
  return new OTLPTraceExporter({
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`, "utf8").toString("base64")}`,
      "x-langfuse-public-key": keys.publicKey,
      "x-langfuse-ingestion-version": "4",
    },
    // Same env parsing as the Langfuse SDK's default exporter.
    timeoutMillis: Number(process.env.LANGFUSE_TIMEOUT || 5) * 1_000,
    httpAgentOptions: { keepAlive: true, proxyEnv: process.env },
  });
}

/**
 * Replace the process-wide runtime. Disabled or incomplete configuration closes the previous one
 * and leaves every tracing call a no-op.
 */
export function startTrace(
  config: TraceConfig,
  log: (line: string) => void = console.error,
  dependencies: TraceDependencies = {},
): TraceRuntime | undefined {
  const previous = activeRuntime;
  activeRuntime = undefined;
  if (previous !== undefined) void previous.close();
  if (!config.enabled) return undefined;
  let provider = dependencies.tracerProvider;
  let ownsProvider = false;
  if (provider === undefined) {
    if (config.publicKey === undefined || config.secretKey === undefined) {
      log("Langfuse tracing disabled: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both required");
      return undefined;
    }
    const publicKey = config.publicKey;
    const secretKey = config.secretKey;
    try {
      const processor = new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        // The trace never carries media; disabling upload avoids any attempt to fetch it.
        mediaUploadEnabled: false,
        ...(hasProxyEnv(process.env)
          ? { exporter: proxyAwareExporter({ publicKey, secretKey, baseUrl: config.baseUrl }) }
          : {}),
      });
      provider = new NodeTracerProvider({ spanProcessors: [processor] });
      ownsProvider = true;
    } catch (error) {
      log(`Langfuse tracing disabled: ${errorLabel(error)}`);
      return undefined;
    }
  }
  setLangfuseTracerProvider(provider);
  const runtime = new TraceRuntime(provider, log, ownsProvider, config.captureContent === true);
  activeRuntime = runtime;
  return runtime;
}

export function beginRequest(options: {
  readonly conversationId: string | number;
  readonly requestId?: string;
  readonly fields?: TraceFields;
}): TraceSpan | undefined {
  return activeRuntime?.beginRequest(options);
}

/**
 * The active runtime's hook extension. The composition root installs it in the tool registry, so a
 * root tool span closes with its tool result instead of waiting for process shutdown.
 */
export function traceExtension(): Extension | undefined {
  return activeRuntime?.extension;
}

/** Start a root tool observation when tracing is enabled; a no-op (undefined) otherwise. */
export function beginTrace(options: BeginTraceOptions): TraceSpan | undefined {
  return activeRuntime?.begin(options);
}

export function recordGeneration(
  message: AssistantMessage,
  api: Pick<HookApi, "conversationId" | "taskId">,
): void {
  activeRuntime?.recordGeneration(message, api);
}

export function recordRegistryDecision(
  fields: {
    tool: string;
    decision: "allow" | "deny";
    code: string;
    authz?: string;
    state?: string;
    authority: string;
    conversationId: ConversationId;
    taskId: TaskId;
  },
): void {
  const span = currentSpan() ?? activeRuntime?.requestFor(fields.conversationId);
  if (span === undefined) return;
  span.event("registry.decision", {
    tool: fields.tool.slice(0, 128),
    decision: fields.decision,
    code: fields.code,
    authz: fields.authz,
    state: fields.state,
    authority: fields.authority,
  });
}

export function recordLoopGuard(
  call: Identity & { tool: string; count: number; reason?: string },
  code: "LOOP_GUARD_WARNING" | "LOOP_GUARD_HALT",
): void {
  activeRuntime?.recordLoopGuard(call, code);
}
