import { randomUUID } from "node:crypto";
import {
  RPC_MAX_DEADLINE_MS,
  RPC_MIN_DEADLINE_MS,
  parseBashExecuteResult,
  parseFileResult,
  type RpcBashExecutePayload,
  type RpcBashExecuteResult,
  type RpcFileMethod,
  type RpcErrorCode,
  type RpcEventFrame,
  type RpcFrame,
  type RpcOutcome,
  type RpcOutputEvent,
  type RpcRequestFrame,
  type RpcTestExecutePayload,
} from "./rpc-protocol.js";
import type { RpcClientTransport, RpcConnection } from "./rpc-transport.js";
import type { TestExecutionResult } from "./rpc-test-executor.js";
import { currentSpan, stringBytes, type TraceFields } from "../trace.js";

export class RpcClientError extends Error {
  override name = "RpcClientError";

  constructor(
    readonly code: RpcErrorCode | "unavailable",
    message: string,
    readonly options: {
      readonly outcome?: RpcOutcome;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export type RpcClientOptions = {
  readonly transport: RpcClientTransport;
  readonly requestTimeoutMs?: number;
  readonly idFactory?: () => string;
};

export type RpcRequestOptions = {
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: RpcOutputEvent) => void;
  /**
   * Error codes that describe an expected state for this call rather than a failed execution: an
   * idempotent cancel of an already-settled target, or a canonical lookup of a not-yet-created
   * file. The RPC result and error are unchanged; only the trace span ends as ok with these fields.
   */
  readonly expectedErrors?: Readonly<Record<string, TraceFields>>;
};

function truncateUtf8(value: string, maxBytes: number): string {
  let truncated = value;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

export type RpcHandle<TResult> = {
  readonly id: string;
  readonly result: Promise<TResult>;
  cancel(reason?: string): Promise<void>;
};

export type RpcExecuteHandle = RpcHandle<TestExecutionResult>;
export type RpcBashExecuteHandle = RpcHandle<RpcBashExecuteResult>;

type Pending = {
  readonly id: string;
  readonly method: RpcRequestFrame["method"];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly onOutput?: (event: RpcOutputEvent) => void;
};


export type RpcHealthResult = {
  readonly executionId: string;
  readonly protocol: 1;
  readonly agentVersion: string;
  readonly phase: number;
  readonly transport: "unix" | "tls";
  readonly peer: string | null;
  readonly methods: readonly string[];
  readonly testExecutor: boolean;
  /** Retired PTC: the server always reports false; kept for existing health probes. */
  readonly ptc?: boolean;
  readonly directBash?: boolean;
  readonly fileTools?: boolean;
  readonly sharedMode?: "none" | "ro" | "rw";
};

export type RpcPreflightResult = {
  readonly ok: boolean;
  readonly executionId: string;
  readonly agentVersion: string;
  readonly checks: Record<string, boolean | null>;
};

export type RpcSessionResult = {
  readonly sessionId: string;
  readonly executionId: string;
  /** Retired PTC: still accepted on the wire, but no execution host is attached to it. */
  readonly jobId?: string;
  /** Present when the session is a shared-host session over its workspace and a private `/tmp`. */
  readonly direct?: {
    readonly sharedMode: "ro" | "rw";
    readonly workspace: string;
    readonly tmp: string;
  };
  readonly limits: {
    readonly maxSessions: number;
    readonly maxConcurrent: number;
    readonly sessionTtlMs: number;
  };
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** A dropped connection or a cancelled request leaves these in an unknown state, not "not started". */
const SIDE_EFFECTING_METHODS: ReadonlySet<RpcRequestFrame["method"]> = new Set([
  "execute", "tool.call", "vm.start", "file.write",
]);

function clampDeadline(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate)) return fallback;
  return Math.min(RPC_MAX_DEADLINE_MS, Math.max(RPC_MIN_DEADLINE_MS, candidate));
}

/**
 * Gateway-side RPC client. It owns pending requests, deadlines, and cancellation, but it does not
 * authorize tools or write durable records. A dropped connection fails pending requests; it never
 * reconnects and replays an execution on its own.
 */
export class RpcExecutionClient {
  private readonly pending = new Map<string, Pending>();
  private readonly defaultTimeoutMs: number;
  private readonly idFactory: () => string;
  private connection: RpcConnection | undefined;
  private closing = false;

  constructor(private readonly options: RpcClientOptions) {
    this.defaultTimeoutMs = clampDeadline(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  get connected(): boolean {
    return this.connection !== undefined && !this.connection.closed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closing) throw new RpcClientError("unavailable", "RPC client is closed");
    const connection = await this.options.transport.connect();
    this.connection = connection;
    connection.onFrame((frame) => this.handleFrame(frame));
    connection.onClose((error) => this.handleClose(error));
  }

  async close(): Promise<void> {
    this.closing = true;
    const connection = this.connection;
    this.connection = undefined;
    this.failPending(new RpcClientError("unavailable", "RPC client closed", { outcome: "unknown" }));
    connection?.close();
  }

  async health(options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {}): Promise<RpcHealthResult> {
    const result = await this.request("health.check", {}, options);
    return result as RpcHealthResult;
  }

  async preflight(options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {}): Promise<RpcPreflightResult> {
    const result = await this.request("preflight", {}, options);
    return result as RpcPreflightResult;
  }

  async openSession(
    sessionId: string,
    options: {
      readonly jobId?: string;
      /** Virtual workspace the session is rooted in; omitting it keeps the agent's default. */
      readonly cwd?: string;
      readonly deadlineMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RpcSessionResult> {
    const result = await this.request("session.open", {
      sessionId,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }, {
      sessionId,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return result as RpcSessionResult;
  }

  async closeSession(
    sessionId: string,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request("session.close", { sessionId }, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  startTestExecute(
    sessionId: string,
    payload: RpcTestExecutePayload,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly onOutput?: (event: RpcOutputEvent) => void } = {},
  ): RpcExecuteHandle {
    const request = this.beginRequest("execute", payload, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    });
    return {
      id: request.id,
      result: request.promise as Promise<TestExecutionResult>,
      cancel: (reason?: string) => this.cancel(sessionId, request.id, reason),
    };
  }

  /**
   * Run one command directly in the sandbox of a direct session. The result carries only the exit
   * code and duration; output arrives through `onOutput` and is bounded by the payload's window.
   */
  startBashExecute(
    sessionId: string,
    payload: RpcBashExecutePayload,
    options: {
      readonly deadlineMs?: number;
      readonly signal?: AbortSignal;
      readonly onOutput?: (event: RpcOutputEvent) => void;
    } = {},
  ): RpcBashExecuteHandle {
    const request = this.beginRequest("execute", payload as unknown as Record<string, unknown>, {
      sessionId,
      deadlineMs: options.deadlineMs ?? Math.min(RPC_MAX_DEADLINE_MS, payload.timeoutMs + 60_000),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    });
    return {
      id: request.id,
      result: request.promise.then((value) => {
        const parsed = parseBashExecuteResult(value);
        if (!parsed.ok) {
          // The command ran; an unreadable result is an unknown outcome, never a success.
          throw new RpcClientError("protocol_error", `execute result is invalid: ${parsed.message}`, { outcome: "unknown" });
        }
        return parsed.value;
      }),
      cancel: (reason?: string) => this.cancel(sessionId, request.id, reason),
    };
  }

  /** One bounded file primitive; the response is validated against the method that produced it. */
  async fileRequest(
    sessionId: string,
    method: RpcFileMethod,
    payload: Record<string, unknown>,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly jobId?: string } = {},
  ): Promise<unknown> {
    const value = await this.request(method, payload, {
      sessionId,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // A canonical lookup of a path that does not exist yet is the normal probe before creating
      // it. Other canonical failures (permission, unavailable transport) still end the span error.
      ...(method === "file.canonical" ? { expectedErrors: { not_found: { probe: "missing" } } } : {}),
    });
    const parsed = parseFileResult(method, value);
    if (!parsed.ok) {
      throw new RpcClientError("protocol_error", `${method} result is invalid: ${parsed.message}`, {
        outcome: method === "file.write" ? "unknown" : "failed",
      });
    }
    return parsed.value;
  }

  async cancel(
    sessionId: string,
    targetId: string,
    reason?: string,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (targetId.length === 0) {
      throw new RpcClientError("invalid_request", "targetId is required");
    }
    await this.request("cancel", {
      targetId,
      ...(reason === undefined ? {} : { reason: truncateUtf8(reason, 512) }),
    }, {
      sessionId,
      deadlineMs: options.deadlineMs ?? 5_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // A target that already settled has nothing left to cancel. The server still answers
      // not_found, but that is a no-op here, not a failed execution.
      expectedErrors: { not_found: { cancelOutcome: "not_active" } },
    });
  }

  /** Send one raw protocol request. Retired methods remain valid frames and are refused by the agent. */
  async request(
    method: RpcRequestFrame["method"],
    payload: Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): Promise<unknown> {
    return this.beginRequest(method, payload, options).promise;
  }

  private beginRequest(
    method: RpcRequestFrame["method"],
    payload: Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): { readonly id: string; readonly promise: Promise<unknown> } {
    const connection = this.connection;
    if (connection === undefined || connection.closed) {
      return {
        id: "",
        promise: Promise.reject(new RpcClientError("unavailable", "RPC client is not connected")),
      };
    }
    if (options.signal?.aborted) {
      return {
        id: "",
        promise: Promise.reject(new RpcClientError("aborted", "request aborted", { outcome: "unknown" })),
      };
    }
    const id = this.idFactory();
    if (this.pending.has(id)) {
      return { id, promise: Promise.reject(new RpcClientError("invalid_request", "duplicate request id")) };
    }
    const deadlineMs = clampDeadline(options.deadlineMs, this.defaultTimeoutMs);
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.settleError(id, new RpcClientError("timeout", "RPC request deadline exceeded", { outcome: "unknown" }));
      if (SIDE_EFFECTING_METHODS.has(method) && options.sessionId !== undefined) {
        void this.cancel(options.sessionId, id, "deadline exceeded").catch(() => undefined);
      }
    }, deadlineMs);
    timer.unref();
    const onAbort = options.signal === undefined ? undefined : () => {
      this.settleError(id, new RpcClientError("aborted", "RPC request aborted", { outcome: "unknown" }));
      if (SIDE_EFFECTING_METHODS.has(method) && options.sessionId !== undefined) {
        void this.cancel(options.sessionId, id, "aborted").catch(() => undefined);
      }
    };
    options.signal?.addEventListener("abort", onAbort!, { once: true });
    this.pending.set(id, {
      id,
      method,
      resolve,
      reject,
      timer,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(onAbort === undefined ? {} : { onAbort }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    });
    // Tracing observes every request that actually leaves the client. A request refused before
    // this point (disconnected, aborted, duplicate id) never crosses a boundary, so it has no span.
    const span = currentSpan()?.child(`rpc.${method}`, {
      rpcId: id,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...rpcSpanFields(method, payload),
    });
    const frame: RpcRequestFrame = {
      v: 1,
      kind: "request",
      id,
      method,
      deadlineMs,
      payload,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(span === undefined ? {} : { correlationId: span.correlationId }),
    };
    if (span !== undefined) {
      void promise.then(
        () => span.end("ok"),
        (error: unknown) => {
          const code = rpcErrorCode(error);
          const expected = options.expectedErrors?.[code];
          span.end(expected === undefined ? rpcSpanOutcome(error) : "ok", {
            ...(expected ?? {}),
            errorCode: code,
            ...(rpcOutcome(error) === undefined ? {} : { rpcOutcome: rpcOutcome(error) }),
          });
        },
      ).catch(() => undefined);
    }
    try {
      connection.send(frame);
    } catch (error) {
      this.settleError(id, new RpcClientError("unavailable", "failed to send RPC request", { cause: error }));
    }
    return { id, promise };
  }

  private handleFrame(frame: RpcFrame): void {
    if (frame.kind === "event") {
      this.handleEvent(frame);
      return;
    }
    if (frame.kind !== "response") return;
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    if (frame.status === "ok") {
      this.settleOk(frame.id, frame.result);
      return;
    }
    this.settleError(frame.id, new RpcClientError(
      frame.error.code,
      frame.error.message,
      {
        ...(frame.error.outcome === undefined ? {} : { outcome: frame.error.outcome }),
        ...(frame.error.retryable === undefined ? {} : { retryable: frame.error.retryable }),
      },
    ));
  }

  private handleEvent(frame: RpcEventFrame): void {
    if (frame.event !== "output") return;
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    try {
      pending.onOutput?.(frame);
    } catch (error) {
      this.settleError(pending.id, new RpcClientError("internal", "event handler failed", { cause: error }));
      if (SIDE_EFFECTING_METHODS.has(pending.method)) {
        void this.cancel(frame.sessionId, pending.id, "event handler failed").catch(() => undefined);
      }
    }
  }

  private settleOk(id: string, value: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.cleanup(pending);
    pending.resolve(value);
  }

  private settleError(id: string, error: RpcClientError): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.cleanup(pending);
    pending.reject(error);
  }

  private cleanup(pending: Pending): void {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending.delete(pending.id);
  }

  private handleClose(error?: Error): void {
    this.connection = undefined;
    this.failPending(new RpcClientError(
      "unavailable",
      "RPC connection closed",
      { outcome: "unknown", ...(error === undefined ? {} : { cause: error }) },
    ));
  }

  private failPending(error: RpcClientError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }
      entry.reject(SIDE_EFFECTING_METHODS.has(entry.method)
        ? error
        : new RpcClientError(error.code, error.message, { ...error.options, outcome: "failed" }));
    }
  }
}

/** Boundary metadata only. Commands, script source, paths and file contents stay out of the trace. */
function rpcSpanFields(
  method: RpcRequestFrame["method"],
  payload: Record<string, unknown>,
): Record<string, string | number | boolean | undefined> {
  if (method === "file.write") {
    const content = payload.content;
    return {
      pathBytes: stringBytes(payload.path),
      contentBytes: typeof content === "string" ? Math.ceil((content.length * 3) / 4) : undefined,
    };
  }
  if (method.startsWith("file.")) {
    return {
      pathBytes: stringBytes(payload.path),
      ...(typeof payload.offset === "number" ? { offset: payload.offset } : {}),
      ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
      ...(typeof payload.length === "number" ? { length: payload.length } : {}),
    };
  }
  return {};
}

function rpcSpanOutcome(error: unknown): "ok" | "error" | "aborted" | "unknown" {
  if (!(error instanceof RpcClientError)) return "error";
  if (error.code === "aborted") return "aborted";
  return error.options.outcome === "unknown" ? "unknown" : "error";
}

function rpcErrorCode(error: unknown): string {
  return error instanceof RpcClientError ? error.code : "internal";
}

function rpcOutcome(error: unknown): string | undefined {
  return error instanceof RpcClientError ? error.options.outcome : undefined;
}
