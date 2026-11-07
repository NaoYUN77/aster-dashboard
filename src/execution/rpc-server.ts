import {
  FILE_METHODS,
  RPC_PROTOCOL_VERSION,
  isRpcFileMethod,
  parseBashExecutePayload,
  parseTestExecutePayload,
  type RpcBashExecutePayload,
  type RpcErrorCode,
  type RpcFrame,
  type RpcOutcome,
  type RpcRequestFrame,
  type RpcTestExecutePayload,
  type RpcFileMethod,
} from "./rpc-protocol.js";
import { DirectHostError, type DirectHost } from "./direct-host.js";
import { RpcAbortError, TestExecutionError, executeTestOperation } from "./rpc-test-executor.js";
import type { RpcConnection, RpcPeerInfo, RpcServer } from "./rpc-transport.js";

export type RpcAgentOptions = {
  readonly server: RpcServer;
  readonly executionId: string;
  readonly transport: "unix" | "tls";
  readonly maxSessions?: number;
  readonly maxConcurrent?: number;
  readonly sessionTtlMs?: number;
  readonly heartbeatMs?: number;
  readonly testExecutorEnabled?: boolean;
  /** The shared Phase 1 execution host (Bash and bounded file primitives). */
  readonly direct?: DirectHost;
  readonly agentVersion?: string;
  readonly now?: () => number;
};

export type RpcAgent = {
  close(): Promise<void>;
};

type Session = {
  readonly sessionId: string;
  /** A retired PTC field: still parsable on the wire, but it no longer selects an execution host. */
  readonly jobId?: string;
  /** A session without a jobId, opened against the shared host's workspace and private `/tmp`. */
  readonly direct: boolean;
  readonly createdAt: number;
  lastActiveAt: number;
  readonly requests: Set<string>;
};

type PendingFileRequest = {
  readonly id: string;
  readonly sessionId: string;
  readonly method: RpcFileMethod;
  readonly controller: AbortController;
  deadline: NodeJS.Timeout | undefined;
  abortReason: "cancel" | "timeout" | "disconnect" | "session_close" | "server_shutdown" | undefined;
  settled: boolean;
};

type PendingExecution = {
  readonly id: string;
  readonly method: RpcRequestFrame["method"];
  readonly sessionId: string;
  readonly controller: AbortController;
  deadline: NodeJS.Timeout | undefined;
  abortReason: "cancel" | "timeout" | "disconnect" | "session_close" | "server_shutdown" | undefined;
  settled: boolean;
  seq: number;
};

type Failure = {
  readonly code: RpcErrorCode;
  readonly message: string;
  readonly outcome: RpcOutcome;
};

/** Methods this agent actually serves. Retired PTC wire values (`vm.*`, `tool.call`) are
 * deliberately absent from the advertised set: they are still parsed and validated by the
 * protocol layer, then refused with `not_implemented` before anything can start. */
const BASE_METHODS = [
  "health.check",
  "preflight",
  "session.open",
  "session.close",
  "execute",
  "cancel",
] as const;

const HOST_METHODS = [
  ...BASE_METHODS,
  ...FILE_METHODS,
] as const;

/** At most this many file requests may be in flight on one connection. */
const MAX_PENDING_FILE_REQUESTS = 64;

function nowMs(): number {
  return Date.now();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * One authenticated RPC connection. Session state is connection-scoped: a reconnect gets a fresh
 * session, and pending execution outcomes are not replayed. Request-id deduplication is therefore
 * only a guard against a duplicate frame on this connection, never durable replay.
 */
class AgentConnection {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, PendingExecution>();
  private readonly fileRequests = new Map<string, PendingFileRequest>();
  private readonly seenRequestIds = new Set<string>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout;
  private active = 0;
  private closed = false;
  private readonly maxSessions: number;
  private readonly maxConcurrent: number;
  private readonly sessionTtlMs: number;
  private readonly testExecutorEnabled: boolean;

  constructor(
    private readonly connection: RpcConnection,
    private readonly peer: RpcPeerInfo,
    private readonly options: RpcAgentOptions,
    private readonly onClosed: () => void,
  ) {
    this.maxSessions = positiveInteger(options.maxSessions, 16);
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 4);
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, 270_000);
    this.testExecutorEnabled = options.testExecutorEnabled !== false;
    const heartbeatMs = positiveInteger(options.heartbeatMs, 15_000);
    this.heartbeat = setInterval(() => {
      this.send({
        v: 1,
        kind: "event",
        event: "heartbeat",
        timestamp: (options.now ?? nowMs)(),
      });
    }, heartbeatMs);
    this.heartbeat.unref();
    this.sweeper = setInterval(() => this.sweepSessions(), Math.max(1_000, Math.min(30_000, heartbeatMs)));
    this.sweeper.unref();
    connection.onFrame((frame) => {
      if (frame.kind !== "request") {
        this.close("only requests are accepted from the gateway");
        return;
      }
      void this.dispatch(frame);
    });
    connection.onClose(() => this.handleClose());
  }

  close(reason: string): void {
    if (this.closed) return;
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const pending of this.requests.values()) {
      pending.abortReason = "disconnect";
      pending.controller.abort("disconnected");
    }
    this.abortFileRequests("disconnect", undefined, false);
    for (const session of this.sessions.values()) {
      this.send({
        v: 1,
        kind: "event",
        event: "session.closed",
        sessionId: session.sessionId,
        reason,
      });
      void this.closeHostSession(session).catch(() => undefined);
    }
    this.requests.clear();
    this.sessions.clear();
    this.closed = true;
    this.connection.close();
  }

  private async closeHostSession(session: Session): Promise<void> {
    if (session.direct) await this.options.direct?.closeSession(session.sessionId);
  }

  private send(frame: RpcFrame): void {
    if (this.closed || this.connection.closed) return;
    try {
      this.connection.send(frame);
    } catch {
      this.close("failed to send a frame");
    }
  }

  private respondOk(id: string, result: unknown): void {
    this.send({ v: 1, kind: "response", id, status: "ok", result });
  }

  private respondError(id: string, code: RpcErrorCode, message: string, outcome?: RpcOutcome): void {
    this.send({
      v: 1,
      kind: "response",
      id,
      status: "error",
      error: { code, message, ...(outcome === undefined ? {} : { outcome }), retryable: false },
    });
  }

  private async dispatch(frame: RpcRequestFrame): Promise<void> {
    if (this.closed) return;
    if (this.seenRequestIds.has(frame.id)) {
      this.respondError(frame.id, "invalid_request", "duplicate request id on this connection", "not_started");
      return;
    }
    this.seenRequestIds.add(frame.id);
    if (this.seenRequestIds.size > 100_000) {
      this.close("request id table exceeded its bound");
      return;
    }
    // A valid envelope with an invalid payload is a request error, not a transport error: answer
    // the caller and keep the connection, so one bad parameter cannot fail every other session on it.
    if (frame.payloadError !== undefined) {
      this.respondError(frame.id, frame.payloadError.code, frame.payloadError.message, "not_started");
      return;
    }
    try {
      switch (frame.method) {
        case "health.check":
          this.respondOk(frame.id, this.health());
          return;
        case "preflight":
          this.respondOk(frame.id, await this.preflight());
          return;
        case "session.open":
          await this.openSession(frame);
          return;
        case "session.close":
          this.closeSessionFromRequest(frame);
          return;
        case "execute":
          this.startExecution(frame);
          return;
        case "cancel":
          this.cancelRequest(frame);
          return;
        case "file.stat":
        case "file.exists":
        case "file.canonical":
        case "file.open":
        case "file.read":
        case "file.scanLines":
        case "file.close":
        case "file.readText":
        case "file.write":
          this.startFileRequest(frame);
          return;
        // Retired PTC / code mode wire methods. Their frames are still parsed and their payloads
        // validated by the protocol layer, but the agent has no VM or nested-tool host. Refusing
        // them explicitly starts nothing and is reported as a clear business outcome.
        case "tool.call":
        case "vm.start":
        case "vm.reply":
        case "vm.message":
          this.respondError(
            frame.id,
            "not_implemented",
            "PTC / code mode is retired; " + frame.method + " is not implemented",
            "not_started",
          );
          return;
      }
    } catch {
      this.respondError(frame.id, "internal", "execution agent failed to handle the request", "failed");
    }
  }

  private health(): Record<string, unknown> {
    const direct = this.options.direct?.enabled === true;
    const phase = direct ? 2 : 0;
    return {
      executionId: this.options.executionId,
      protocol: RPC_PROTOCOL_VERSION,
      agentVersion: this.options.agentVersion ?? (direct ? "phase2" : "phase0"),
      phase,
      transport: this.options.transport,
      peer: this.peer.peer ?? null,
      methods: direct ? HOST_METHODS : BASE_METHODS,
      testExecutor: this.testExecutorEnabled,
      // Retired PTC: a fixed false in the wire response keeps existing health probes valid.
      ptc: false,
      directBash: direct,
      fileTools: direct,
      sharedMode: direct ? this.options.direct?.sharedMode ?? "none" : "none",
    };
  }

  private async preflight(): Promise<Record<string, unknown>> {
    const direct = this.options.direct;
    const remote = direct?.enabled === true;
    const checks: Record<string, boolean | null> = {
      testExecutor: this.testExecutorEnabled,
      mutualTls: this.options.transport === "tls" ? this.peer.authorized : null,
    };
    if (direct?.enabled === true) {
      Object.assign(checks, await direct.preflight());
      checks.direct = true;
    }
    // A shared-host agent reports the host's own checks; the test executor is a test-only facility
    // expected to be off in production, so it does not decide whether the host is healthy.
    const ok = remote
      ? Object.entries(checks).every(([key, value]) => key === "testExecutor" || value !== false)
      : this.testExecutorEnabled;
    return {
      ok,
      executionId: this.options.executionId,
      agentVersion: this.options.agentVersion ?? (remote ? "phase2" : "phase0"),
      checks,
    };
  }

  private async openSession(frame: RpcRequestFrame): Promise<void> {
    const sessionId = frame.payload.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "sessionId is required", "not_started");
      return;
    }
    // "jobId" is a retired PTC field. It is still accepted on the wire for version compatibility,
    // but it no longer selects an execution host: such a session has no bash or file primitives.
    const jobId = typeof frame.payload.jobId === "string" ? frame.payload.jobId : undefined;
    if (this.sessions.has(sessionId)) {
      this.respondError(frame.id, "busy", "session already exists on this connection", "not_started");
      return;
    }
    if (this.sessions.size >= this.maxSessions) {
      this.respondError(frame.id, "busy", "maximum sessions reached", "not_started");
      return;
    }
    const cwd = typeof frame.payload.cwd === "string" ? frame.payload.cwd : undefined;
    const now = (this.options.now ?? nowMs)();
    const direct = jobId === undefined && this.options.direct?.enabled === true;
    const session: Session = {
      sessionId,
      ...(jobId === undefined ? {} : { jobId }),
      direct,
      createdAt: now,
      lastActiveAt: now,
      requests: new Set(),
    };
    let directState: { readonly sharedMode: "ro" | "rw"; readonly tmpPath: string; readonly workspace?: string } | undefined;
    try {
      if (direct && this.options.direct !== undefined) {
        directState = await this.options.direct.openSession(sessionId, cwd);
      }
    } catch (error) {
      const failure = this.hostFailure(error);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
      return;
    }
    if (this.closed) return;
    this.sessions.set(sessionId, session);
    this.respondOk(frame.id, {
      sessionId,
      executionId: this.options.executionId,
      ...(session.jobId === undefined ? {} : { jobId: session.jobId }),
      // Only virtual paths cross this boundary: the host tmp directory stays on the agent.
      ...(directState === undefined
        ? {}
        : {
            direct: {
              sharedMode: directState.sharedMode,
              // Virtual paths only; the host directory never crosses this boundary.
              workspace: directState.workspace ?? "/shared",
              tmp: "/tmp",
            },
          }),
      limits: {
        maxSessions: this.maxSessions,
        maxConcurrent: this.maxConcurrent,
        sessionTtlMs: this.sessionTtlMs,
      },
    });
  }

  private closeSessionFromRequest(frame: RpcRequestFrame): void {
    const sessionId = frame.payload.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "sessionId is required", "not_started");
      return;
    }
    const existed = this.sessions.has(sessionId);
    this.closeSession(sessionId, "session.close");
    this.respondOk(frame.id, { sessionId, closed: existed });
  }

  private closeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    for (const requestId of session.requests) {
      const pending = this.requests.get(requestId);
      if (pending === undefined) continue;
      pending.abortReason = "session_close";
      pending.controller.abort("session closed");
    }
    this.abortFileRequests("session_close", sessionId);
    void this.closeHostSession(session).catch(() => undefined);
    this.send({ v: 1, kind: "event", event: "session.closed", sessionId, reason });
  }

  private sweepSessions(): void {
    if (this.closed) return;
    const now = (this.options.now ?? nowMs)();
    for (const session of this.sessions.values()) {
      if (session.requests.size > 0 || this.hasFileRequest(session.sessionId)) continue;
      if (now - session.lastActiveAt > this.sessionTtlMs) {
        this.closeSession(session.sessionId, "idle timeout");
      }
    }
  }

  /** A file request is activity: a long scan must not be cut short by the idle sweeper. */
  private hasFileRequest(sessionId: string): boolean {
    for (const pending of this.fileRequests.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  private startExecution(frame: RpcRequestFrame): void {
    const sessionId = frame.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "execute requires a sessionId", "not_started");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.respondError(frame.id, "not_found", "session is not open on this connection", "not_started");
      return;
    }
    if (frame.payload.executor === "test") {
      if (!this.testExecutorEnabled) {
        this.respondError(frame.id, "not_implemented", "the test executor is disabled", "not_started");
        return;
      }
      const payload = parseTestExecutePayload(frame.payload);
      if (!payload.ok) {
        this.respondError(frame.id, "invalid_request", payload.message, "not_started");
        return;
      }
      if (this.active >= this.maxConcurrent) {
        this.respondError(frame.id, "busy", "execution concurrency limit reached", "not_started");
        return;
      }
      const pending = this.beginPending(frame, session, "execute");
      void this.runTest(frame, payload.value, pending, session);
      return;
    }
    if (frame.payload.executor === "bash") {
      if (!session.direct || this.options.direct?.enabled !== true) {
        this.respondError(frame.id, "not_implemented", "the bash executor needs a direct session", "not_started");
        return;
      }
      const payload = parseBashExecutePayload(frame.payload);
      if (!payload.ok) {
        this.respondError(frame.id, "invalid_request", payload.message, "not_started");
        return;
      }
      if (this.active >= this.maxConcurrent) {
        this.respondError(frame.id, "busy", "execution concurrency limit reached", "not_started");
        return;
      }
      const pending = this.beginPending(frame, session, "execute");
      void this.runBash(frame, payload.value, pending, session, this.options.direct);
      return;
    }
    this.respondError(
      frame.id,
      "not_implemented",
      `executor ${String(frame.payload.executor).slice(0, 32)} is not implemented`,
      "not_started",
    );
  }

  private async runBash(
    frame: RpcRequestFrame,
    payload: RpcBashExecutePayload,
    pending: PendingExecution,
    session: Session,
    direct: DirectHost,
  ): Promise<void> {
    try {
      const result = await direct.execute({
        sessionId: session.sessionId,
        payload,
        signal: pending.controller.signal,
        emit: (seq, stream, text, skipped) => {
          if (pending.settled || this.closed) return;
          this.send({
            v: 1,
            kind: "event",
            event: "output",
            id: frame.id,
            sessionId: session.sessionId,
            seq,
            stream,
            text,
            ...(skipped === undefined ? {} : { skipped }),
          });
        },
      });
      if (pending.settled) return;
      this.finish(pending, session);
      this.respondOk(frame.id, result);
    } catch (error) {
      if (pending.settled) return;
      const failure = this.failureFor(error, pending);
      this.finish(pending, session);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
    }
  }

  /**
   * A file primitive runs on the shared host that owns the session's virtual namespace (its
   * workspace and private `/tmp`). Its deadline and cancel are handled here so a slow read can
   * never be mistaken for a completed write.
   */
  private startFileRequest(frame: RpcRequestFrame): void {
    if (!isRpcFileMethod(frame.method)) {
      this.respondError(frame.id, "invalid_request", "unknown file method", "not_started");
      return;
    }
    const session = this.sessionFor(frame, frame.method);
    if (session === undefined) return;
    const target = session.direct && this.options.direct?.enabled === true ? this.options.direct : undefined;
    if (target === undefined) {
      this.respondError(frame.id, "not_implemented", "file tools are unavailable in this session", "not_started");
      return;
    }
    if (this.fileRequests.size >= MAX_PENDING_FILE_REQUESTS) {
      this.respondError(frame.id, "busy", "too many file requests in flight", "not_started");
      return;
    }
    const pending: PendingFileRequest = {
      id: frame.id,
      sessionId: session.sessionId,
      method: frame.method,
      controller: new AbortController(),
      deadline: undefined,
      abortReason: undefined,
      settled: false,
    };
    pending.deadline = setTimeout(() => {
      if (pending.settled) return;
      pending.abortReason = "timeout";
      this.settleFileRequest(pending);
      pending.controller.abort("deadline exceeded");
      this.respondError(
        frame.id,
        "timeout",
        "execution deadline exceeded",
        pending.method === "file.write" ? "unknown" : "failed",
      );
    }, frame.deadlineMs);
    pending.deadline.unref();
    this.fileRequests.set(frame.id, pending);
    session.lastActiveAt = (this.options.now ?? nowMs)();
    void this.runFileRequest(frame, pending, target);
  }

  private async runFileRequest(
    frame: RpcRequestFrame,
    pending: PendingFileRequest,
    target: {
      fileRequest(input: {
        sessionId: string;
        method: RpcFileMethod;
        payload: Record<string, unknown>;
        signal: AbortSignal;
      }): Promise<unknown>;
    },
  ): Promise<void> {
    try {
      const result = await target.fileRequest({
        sessionId: pending.sessionId,
        method: pending.method,
        payload: frame.payload,
        signal: pending.controller.signal,
      });
      if (pending.settled) return;
      this.settleFileRequest(pending);
      this.respondOk(frame.id, result);
    } catch (error) {
      if (pending.settled) return;
      this.settleFileRequest(pending);
      const failure = this.hostFailure(error);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
    }
  }

  private settleFileRequest(pending: PendingFileRequest): void {
    pending.settled = true;
    if (pending.deadline !== undefined) clearTimeout(pending.deadline);
    this.fileRequests.delete(pending.id);
  }

  private abortFileRequests(
    reason: PendingFileRequest["abortReason"],
    sessionId?: string,
    respond = true,
  ): void {
    for (const pending of [...this.fileRequests.values()]) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      pending.abortReason = reason;
      this.settleFileRequest(pending);
      pending.controller.abort("aborted");
      if (!respond || this.closed) continue;
      this.respondError(
        pending.id,
        reason === "timeout" ? "timeout" : "aborted",
        reason === "timeout" ? "execution deadline exceeded" : "execution was aborted",
        pending.method === "file.write" ? "unknown" : "failed",
      );
    }
  }

  private async runTest(
    frame: RpcRequestFrame,
    payload: RpcTestExecutePayload,
    pending: PendingExecution,
    session: Session,
  ): Promise<void> {
    try {
      const result = await executeTestOperation(payload, pending.controller.signal, (text) => {
        if (pending.settled || this.closed) return;
        pending.seq++;
        this.send({
          v: 1,
          kind: "event",
          event: "output",
          id: frame.id,
          sessionId: pending.sessionId,
          seq: pending.seq,
          stream: "stdout",
          text,
        });
      });
      if (pending.settled) return;
      this.finish(pending, session);
      this.respondOk(frame.id, result);
    } catch (error) {
      if (pending.settled) return;
      const failure = this.failureFor(error, pending);
      this.finish(pending, session);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
    }
  }

  private sessionFor(frame: RpcRequestFrame, method: string): Session | undefined {
    const sessionId = frame.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", `${method} requires a sessionId`, "not_started");
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.respondError(frame.id, "not_found", "session is not open on this connection", "not_started");
      return undefined;
    }
    return session;
  }

  private beginPending(
    frame: RpcRequestFrame,
    session: Session,
    method: PendingExecution["method"],
    onDeadline?: () => void,
  ): PendingExecution {
    const controller = new AbortController();
    const pending: PendingExecution = {
      id: frame.id,
      method,
      sessionId: session.sessionId,
      controller,
      deadline: undefined,
      abortReason: undefined,
      settled: false,
      seq: 0,
    };
    pending.deadline = setTimeout(() => {
      pending.abortReason = "timeout";
      onDeadline?.();
      controller.abort("deadline exceeded");
    }, frame.deadlineMs);
    pending.deadline.unref();
    this.requests.set(frame.id, pending);
    session.requests.add(frame.id);
    session.lastActiveAt = (this.options.now ?? nowMs)();
    this.active++;
    return pending;
  }

  private hostFailure(error: unknown): Failure {
    if (error instanceof DirectHostError) {
      return { code: error.code, message: error.message, outcome: error.outcome };
    }
    return { code: "internal", message: "the execution host failed to handle the request", outcome: "failed" };
  }

  private failureFor(error: unknown, pending: PendingExecution): Failure {
    if (pending.abortReason === "timeout") {
      return { code: "timeout", message: "execution deadline exceeded", outcome: "unknown" };
    }
    if (pending.abortReason !== undefined) {
      return { code: "aborted", message: "execution was aborted", outcome: "unknown" };
    }
    if (error instanceof DirectHostError) {
      return { code: error.code, message: error.message, outcome: error.outcome };
    }
    if (error instanceof RpcAbortError) {
      return { code: "aborted", message: "execution was aborted", outcome: "unknown" };
    }
    if (error instanceof TestExecutionError) {
      return { code: "test_error", message: error.message, outcome: "failed" };
    }
    return { code: "internal", message: "executor failed", outcome: "failed" };
  }

  private finish(pending: PendingExecution, session: Session): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.deadline !== undefined) clearTimeout(pending.deadline);
    this.requests.delete(pending.id);
    session.requests.delete(pending.id);
    this.active--;
  }

  private cancelRequest(frame: RpcRequestFrame): void {
    const targetId = frame.payload.targetId;
    if (typeof targetId !== "string") {
      this.respondError(frame.id, "invalid_request", "targetId is required", "not_started");
      return;
    }
    const pending = this.requests.get(targetId);
    if (pending === undefined) {
      const file = this.fileRequests.get(targetId);
      if (file === undefined) {
        this.respondError(frame.id, "not_found", "target request is not active", "not_started");
        return;
      }
      file.abortReason = "cancel";
      this.settleFileRequest(file);
      file.controller.abort("cancelled");
      this.respondError(
        file.id,
        "aborted",
        "execution was aborted",
        file.method === "file.write" ? "unknown" : "failed",
      );
      this.respondOk(frame.id, { targetId, cancelled: true });
      return;
    }
    pending.abortReason = "cancel";
    pending.controller.abort("cancelled");
    this.respondOk(frame.id, { targetId, cancelled: true });
  }

  private handleClose(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const pending of this.requests.values()) {
      pending.abortReason = "disconnect";
      pending.controller.abort("disconnected");
    }
    this.abortFileRequests("disconnect", undefined, false);
    for (const session of this.sessions.values()) {
      void this.closeHostSession(session).catch(() => undefined);
    }
    this.requests.clear();
    this.sessions.clear();
    this.closed = true;
    this.onClosed();
  }
}

export function startRpcAgent(options: RpcAgentOptions): RpcAgent {
  const connections = new Set<AgentConnection>();
  options.server.onConnection((connection, peer) => {
    const agentConnection = new AgentConnection(connection, peer, options, () => {
      connections.delete(agentConnection);
    });
    connections.add(agentConnection);
  });
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        for (const connection of connections) connection.close("server shutdown");
        connections.clear();
        await options.server.close();
      })();
      return closing;
    },
  };
}
