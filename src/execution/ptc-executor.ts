import { spawn, type ChildProcess } from "node:child_process";
import { buildBwrapArgv, buildDegradedArgv, runnerEnvironment } from "./ptc-bwrap.js";
import { createPtcCgroup, spawnInCgroup, type PtcCgroup } from "./ptc-cgroup.js";
import type { PtcConfig } from "./ptc-config.js";
import { PtcHostError, type PtcEventSink, type PtcHost } from "./ptc-host.js";
import { preparePtcWorkspace, jobWorkspacePath, PTC_SANDBOX_WORKSPACE } from "./ptc-workspace.js";
import type { PtcRuntimeProbe } from "./ptc-cgroup.js";
import {
  PtcRunnerFrameDecoder,
  PtcRunnerProtocolError,
  encodeRunnerFrame,
  parseRunnerFrame,
  type HostToRunner,
  type RunnerToHost,
} from "./ptc-runner-protocol.js";
import {
  parseFileResult,
  parsePtcToolCallResult,
  type PtcIsolationState,
  type PtcToolCallPayload,
  type PtcToolCallResult,
  type PtcVmReplyPayload,
  type PtcVmStartPayload,
  type PtcWorkspaceState,
  type RpcErrorCode,
  type RpcFileMethod,
  type RpcOutcome,
} from "./rpc-protocol.js";

const ERROR_CODES = new Set<RpcErrorCode>([
  "invalid_request", "unsupported_version", "not_found", "busy", "not_implemented", "timeout",
  "aborted", "too_large", "spawn_error", "unavailable", "protocol_error", "test_error",
  "workspace_missing", "output_unavailable", "internal",
]);

/** A failed runner frame means the sandbox and the agent disagree about what is running. */
class RunnerFailure extends Error {
  constructor(readonly code: RpcErrorCode, message: string, readonly outcome: RpcOutcome = "unknown") {
    super(message);
  }
}

type PendingVm = {
  readonly sink: PtcEventSink;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

type PendingTool = {
  readonly callId: number;
  readonly sink: PtcEventSink;
  readonly resolve: (result: PtcToolCallResult) => void;
  readonly reject: (error: unknown) => void;
};

type PendingFile = {
  readonly method: RpcFileMethod;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
};

type Runner = {
  readonly sessionId: string;
  readonly jobId: string;
  readonly hostPath: string;
  readonly child: ChildProcess;
  readonly decoder: PtcRunnerFrameDecoder;
  readonly cgroup?: PtcCgroup;
  writes: Promise<void>;
  exit: Promise<void>;
  vm?: PendingVm;
  /** The call the VM is waiting on; the only `callId` that may be answered with `vm.reply`. */
  pendingVmCallId?: number;
  tool?: PendingTool;
  readonly files: Map<number, PendingFile>;
  finished: boolean;
  exited: boolean;
  stderr: string;
};

type SessionState = {
  readonly sessionId: string;
  readonly jobId: string;
  readonly hostPath: string;
  readonly workspace: PtcWorkspaceState;
  runner?: Runner;
  exiting?: Promise<void>;
};

export type PtcExecutorOptions = {
  readonly config: PtcConfig;
  /** Result of `probePtcRuntime`; the executor never probes implicitly at request time. */
  readonly probe: PtcRuntimeProbe;
  readonly now?: () => number;
};

/**
 * The execution agent's sandbox. One runner process per VM execution, inside bwrap and a cgroup;
 * the workspace outlives it, so a replay of the same job sees the same files.
 */
export class PtcExecutor implements PtcHost {
  readonly isolation: PtcIsolationState;
  readonly enabled: boolean;
  private readonly sessions = new Map<string, SessionState>();
  private readonly usable: boolean;
  private nextFileRequestId = 1;

  constructor(private readonly options: PtcExecutorOptions) {
    this.isolation = options.probe.isolation;
    this.usable = options.probe.isolation.mode === "bwrap"
      ? options.probe.isolation.bwrap
        && options.probe.isolation.userNamespace
        && options.probe.isolation.cgroup === "v2"
      : options.probe.isolation.mode === "degraded-prlimit";
    this.enabled = this.usable;
  }

  async preflight(): Promise<Record<string, boolean | null>> {
    return { ...this.options.probe.checks, usable: this.usable };
  }

  async openSession(sessionId: string, jobId: string, workspaceReady: boolean, _cwd?: string): Promise<PtcWorkspaceState> {
    if (!this.usable) throw new PtcHostError("unavailable", "the PTC sandbox is not usable on this host", "not_started");
    if (this.sessions.has(sessionId)) {
      throw new PtcHostError("busy", "session already exists", "not_started");
    }
    const workspace = await preparePtcWorkspace(this.options.config, jobId, workspaceReady);
    this.sessions.set(sessionId, {
      sessionId,
      jobId,
      hostPath: jobWorkspacePath(this.options.config, jobId),
      workspace,
    });
    return workspace;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    await this.stopRunner(session, new PtcHostError("aborted", "the session was closed", "unknown"));
    await session.exiting;
  }

  async startVm(input: {
    sessionId: string;
    request: PtcVmStartPayload["request"];
    signal: AbortSignal;
    sink: PtcEventSink;
  }): Promise<unknown> {
    if (!this.usable) throw new PtcHostError("unavailable", "the PTC sandbox is not usable on this host", "not_started");
    const session = this.requireSession(input.sessionId);
    if (session.runner !== undefined) {
      throw new PtcHostError("busy", "a VM is already running in this session", "not_started");
    }
    if (session.exiting !== undefined) await session.exiting;
    if (input.signal.aborted) throw new PtcHostError("aborted", "the VM was aborted before it started", "not_started");

    const runner = await this.spawnRunner(session);
    session.runner = runner;
    const started = new Promise<void>((resolve, reject) => {
      runner.vm = { sink: input.sink, resolve, reject };
    });
    const onAbort = () => {
      void this.stopRunner(session, new PtcHostError("aborted", "the VM was aborted", "unknown"));
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.send(runner, {
        t: "start",
        jobId: session.jobId,
        sessionId: session.sessionId,
        request: input.request,
      });
      await started;
    } catch (error) {
      await this.stopRunner(session, new PtcHostError("internal", "the VM could not be started in the sandbox", "unknown"));
      throw error;
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
    return {};
  }

  async replyVm(sessionId: string, payload: PtcVmReplyPayload): Promise<void> {
    const session = this.requireSession(sessionId);
    const runner = session.runner;
    if (runner === undefined) throw new PtcHostError("not_found", "no VM is running in this session", "not_started");
    // The runner drops a reply whose id is not pending, so accepting one here would report
    // `delivered: true` for a reply the VM never receives.
    if (runner.pendingVmCallId === undefined || runner.pendingVmCallId !== payload.callId) {
      throw new PtcHostError(
        "invalid_request",
        "callId does not answer the VM's pending call",
        "not_started",
      );
    }
    this.send(runner, { t: "reply", callId: payload.callId, reply: payload.reply });
    // The runner may already have emitted the next call by the time its stdin write returns;
    // only the id this reply consumed is cleared.
    if (runner.pendingVmCallId === payload.callId) runner.pendingVmCallId = undefined;
  }

  async toolCall(input: {
    sessionId: string;
    payload: PtcToolCallPayload;
    signal: AbortSignal;
    sink: PtcEventSink;
  }): Promise<PtcToolCallResult> {
    const session = this.requireSession(input.sessionId);
    const runner = session.runner;
    if (runner === undefined) throw new PtcHostError("not_found", "no VM is running in this session", "not_started");
    if (runner.tool !== undefined) throw new PtcHostError("busy", "a nested call is already running", "not_started");
    if (input.signal.aborted) throw new PtcHostError("aborted", "the call was aborted before it started", "not_started");

    const result = new Promise<PtcToolCallResult>((resolve, reject) => {
      runner.tool = { callId: input.payload.callId, sink: input.sink, resolve, reject };
    });
    const onAbort = () => {
      void this.stopRunner(session, new PtcHostError("aborted", "the call was aborted", "unknown"));
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.send(runner, { t: "tool.call", callId: input.payload.callId, args: input.payload.args });
      return await result;
    } catch (error) {
      if (runner.tool !== undefined) runner.tool = undefined;
      throw error;
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Forward one file primitive into the running sandbox. File requests never share the VM's call
   * cycle, so a slow read cannot deadlock a nested tool call; an aborted file request is dropped
   * from the pending map and its late answer is ignored.
   */
  async fileRequest(input: {
    sessionId: string;
    method: RpcFileMethod;
    payload: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<unknown> {
    const session = this.requireSession(input.sessionId);
    const runner = session.runner;
    if (runner === undefined) {
      throw new PtcHostError("not_found", "no VM is running in this session", "not_started");
    }
    if (input.signal.aborted) {
      throw new PtcHostError("aborted", "the file request was aborted before it started", "not_started");
    }
    const requestId = this.nextFileRequestId++;
    if (!Number.isSafeInteger(requestId)) {
      throw new PtcHostError("busy", "the sandbox ran out of file request ids", "not_started");
    }
    let rejectPending!: (error: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      rejectPending = reject;
      runner.files.set(requestId, { method: input.method, resolve, reject });
    });
    const onAbort = () => {
      if (!runner.files.delete(requestId)) return;
      rejectPending(new PtcHostError(
        "aborted",
        "the file request was aborted",
        input.method === "file.write" ? "unknown" : "failed",
      ));
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.send(runner, { t: "file", requestId, method: input.method, payload: input.payload });
      return await result;
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      runner.files.delete(requestId);
    }
  }

  cancel(sessionId: string, _requestId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    void this.stopRunner(session, new PtcHostError("aborted", "the execution was cancelled", "unknown"));
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new PtcHostError("not_found", "session is not open", "not_started");
    }
    return session;
  }

  private async spawnRunner(session: SessionState): Promise<Runner> {
    const config = this.options.config;
    const degraded = this.isolation.mode === "degraded-prlimit";
    const argv = degraded
      ? buildDegradedArgv(config, session.hostPath)
      : buildBwrapArgv(config, session.hostPath);
    const env = degraded
      ? {
          ...runnerEnvironment(config, session.hostPath),
          HOME: session.hostPath,
          TMPDIR: "/tmp",
          PATH: config.nodePath,
          LANG: "C.UTF-8",
          PTC_INSIDE_SANDBOX: "1",
        }
      : {};

    let cgroup: PtcCgroup | undefined;
    if (!degraded) {
      try {
        cgroup = await createPtcCgroup(config, session.sessionId);
      } catch (error) {
        // A rejected session id is the caller's mistake; wrapping it as `internal` would hide the
        // only actionable part of the failure.
        if (error instanceof PtcHostError) throw error;
        throw new PtcHostError(
          "internal",
          `the sandbox could not be constrained: ${error instanceof Error ? error.message : "cgroup setup failed"}`,
          "not_started",
        );
      }
    }

    let child: ChildProcess;
    const [file, ...args] = argv;
    if (file === undefined) {
      await cgroup?.release();
      throw new PtcHostError("internal", "the sandbox command is empty", "not_started");
    }
    const spawnOptions = {
      cwd: session.hostPath,
      env,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      detached: true,
    };
    let ready: Promise<void> | undefined;
    try {
      if (cgroup === undefined) {
        child = spawn(file, args, spawnOptions);
      } else {
        const accounted = spawnInCgroup(cgroup.path, file, args, spawnOptions);
        child = accounted.child;
        ready = accounted.ready;
      }
    } catch (error) {
      await cgroup?.release();
      throw new PtcHostError(
        "spawn_error",
        `the sandbox could not start: ${error instanceof Error ? error.message : "spawn failed"}`,
        "not_started",
      );
    }
    if (ready !== undefined) {
      try {
        // bwrap unshares the cgroup namespace, so the process must be accounted for before it runs.
        await ready;
      } catch (error) {
        child.kill("SIGKILL");
        await cgroup?.release();
        throw new PtcHostError(
          "internal",
          `the sandbox process could not be accounted for: ${error instanceof Error ? error.message : "cgroup write failed"}`,
          "not_started",
        );
      }
    }

    const runner: Runner = {
      sessionId: session.sessionId,
      jobId: session.jobId,
      hostPath: session.hostPath,
      child,
      decoder: new PtcRunnerFrameDecoder(),
      ...(cgroup === undefined ? {} : { cgroup }),
      files: new Map(),
      writes: Promise.resolve(),
      exit: Promise.resolve(),
      finished: false,
      exited: false,
      stderr: "",
    };

    child.once("error", (error) => {
      this.failRunner(session, runner, new PtcHostError("spawn_error", `the sandbox failed: ${error.message}`, "unknown"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Diagnostics only; never forwarded to the model or the gateway.
      runner.stderr = (runner.stderr + chunk.toString("utf8")).slice(-4_096);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = runner.decoder.push(chunk);
      } catch (error) {
        this.failRunner(session, runner, error instanceof PtcRunnerProtocolError
          ? new RunnerFailure("protocol_error", `the sandbox sent an invalid frame: ${error.message}`)
          : new RunnerFailure("protocol_error", "the sandbox frame stream is invalid"));
        return;
      }
      for (const frame of frames) {
        const parsed = parseRunnerFrame(frame);
        if (!parsed.ok) {
          this.failRunner(session, runner, new RunnerFailure("protocol_error", `the sandbox sent an invalid frame: ${parsed.message}`));
          return;
        }
        this.onFrame(session, runner, parsed.value);
        if (runner.finished) return;
      }
    });
    child.once("exit", () => {
      runner.exited = true;
    });
    runner.exit = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    }).then(async () => {
      runner.exited = true;
      await runner.cgroup?.release();
      if (!runner.finished) {
        this.failRunner(session, runner, new PtcHostError(
          "internal",
          `the sandbox exited before the VM completed${runner.stderr === "" ? "" : `: ${runner.stderr.slice(-512)}`}`,
          "unknown",
        ));
      }
    });

    return runner;
  }

  private onFrame(session: SessionState, runner: Runner, frame: RunnerToHost): void {
    if (runner.finished) return;
    switch (frame.t) {
      case "vm":
        if (runner.vm === undefined) {
          this.failRunner(session, runner, new RunnerFailure("protocol_error", "the sandbox reported VM messages after the VM ended"));
          return;
        }
        if (frame.callId !== undefined) runner.pendingVmCallId = frame.callId;
        runner.vm.sink.vmMessage(frame.callId, frame.messages);
        return;
      case "tool.output": {
        const tool = runner.tool;
        if (tool === undefined || tool.callId !== frame.callId) {
          this.failRunner(session, runner, new RunnerFailure("protocol_error", "the sandbox streamed output for an unknown call"));
          return;
        }
        tool.sink.toolOutput(frame.seq, frame.stream, frame.text, frame.skipped);
        return;
      }
      case "tool.done": {
        const tool = runner.tool;
        if (tool === undefined || tool.callId !== frame.callId) {
          this.failRunner(session, runner, new RunnerFailure("protocol_error", "the sandbox completed an unknown call"));
          return;
        }
        const parsed = parsePtcToolCallResult(frame.result);
        if (!parsed.ok) {
          this.failRunner(session, runner, new RunnerFailure("protocol_error", `the sandbox sent an invalid result: ${parsed.message}`));
          return;
        }
        runner.tool = undefined;
        tool.resolve(parsed.value);
        return;
      }
      case "tool.error": {
        const tool = runner.tool;
        if (tool === undefined || tool.callId !== frame.callId) {
          this.failRunner(session, runner, new RunnerFailure("protocol_error", "the sandbox failed an unknown call"));
          return;
        }
        runner.tool = undefined;
        const code: RpcErrorCode = ERROR_CODES.has(frame.code) ? frame.code : "internal";
        tool.reject(new PtcHostError(code, frame.message, outcomeFor(code)));
        return;
      }
      case "file.done": {
        const pending = runner.files.get(frame.requestId);
        if (pending === undefined) return;
        runner.files.delete(frame.requestId);
        const parsed = parseFileResult(pending.method, frame.result);
        if (!parsed.ok) {
          pending.reject(new PtcHostError(
            "protocol_error",
            `the sandbox sent an invalid file result: ${parsed.message}`,
            "failed",
          ));
          return;
        }
        pending.resolve(parsed.value);
        return;
      }
      case "file.error": {
        const pending = runner.files.get(frame.requestId);
        if (pending === undefined) return;
        runner.files.delete(frame.requestId);
        const code: RpcErrorCode = ERROR_CODES.has(frame.code) ? frame.code : "internal";
        pending.reject(new PtcHostError(code, frame.message, outcomeFor(code)));
        return;
      }
      case "done":
        this.finishRunner(session, runner, undefined);
        return;
      case "error":
        this.finishRunner(session, runner, new PtcHostError(
          ERROR_CODES.has(frame.code) ? frame.code : "internal",
          frame.message,
          "unknown",
        ));
        return;
    }
  }

  /** The VM reached a terminal state; the process is expected to exit on its own. */
  private finishRunner(session: SessionState, runner: Runner, error: PtcHostError | undefined): void {
    if (runner.finished) return;
    runner.finished = true;
    runner.pendingVmCallId = undefined;
    const tool = runner.tool;
    runner.tool = undefined;
    const vm = runner.vm;
    runner.vm = undefined;
    if (tool !== undefined) {
      tool.reject(error ?? new PtcHostError("internal", "the VM ended while a nested call was running", "unknown"));
    }
    for (const pending of runner.files.values()) {
      pending.reject(error ?? new PtcHostError(
        "unavailable",
        "the sandbox ended while the file operation was running",
        "unknown",
      ));
    }
    runner.files.clear();
    if (vm !== undefined) {
      if (error === undefined) vm.resolve();
      else vm.reject(error);
    }
    if (session.runner === runner) session.runner = undefined;
    const exiting = runner.exit;
    session.exiting = exiting;
    void exiting.finally(() => {
      if (session.exiting === exiting) session.exiting = undefined;
    });
    // A well-behaved runner exits after `done`; one that lingers is killed so the session can be reused.
    if (error === undefined && !runner.exited) {
      const timer = setTimeout(() => this.kill(runner), 2_000);
      timer.unref();
      void exiting.finally(() => clearTimeout(timer));
    }
  }

  /** Unexpected failure: kill first, then report; the process state is unknown by definition. */
  private failRunner(session: SessionState, runner: Runner, error: Error): void {
    this.kill(runner);
    const hostError = error instanceof RunnerFailure
      ? new PtcHostError(error.code, error.message, error.outcome)
      : error instanceof PtcHostError
        ? error
        : new PtcHostError("internal", error.message, "unknown");
    this.finishRunner(session, runner, hostError);
  }

  private async stopRunner(session: SessionState, reason: PtcHostError): Promise<void> {
    const runner = session.runner;
    if (runner === undefined) return;
    try {
      this.send(runner, { t: "cancel" });
    } catch {
      // The runner may already be gone.
    }
    this.kill(runner);
    this.finishRunner(session, runner, reason);
    await runner.exit;
  }

  private kill(runner: Runner): void {
    if (runner.cgroup !== undefined) {
      void runner.cgroup.kill().catch(() => undefined);
      return;
    }
    try {
      if (runner.child.pid !== undefined) process.kill(-runner.child.pid, "SIGKILL");
      else runner.child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }

  /** Frames are written in order; a failed write kills the sandbox instead of buffering forever. */
  private send(runner: Runner, frame: HostToRunner): void {
    if (runner.finished || runner.exited) {
      throw new PtcHostError("unavailable", "the sandbox is no longer running", "unknown");
    }
    const stdin = runner.child.stdin;
    if (stdin === undefined || stdin === null || !stdin.writable) {
      throw new PtcHostError("unavailable", "the sandbox stdin is closed", "unknown");
    }
    let buffer: Buffer;
    try {
      buffer = encodeRunnerFrame(frame);
    } catch (error) {
      throw new PtcHostError("too_large", error instanceof Error ? error.message : "frame is too large", "not_started");
    }
    runner.writes = runner.writes.then(async () => {
      if (!stdin.writable) return;
      if (!stdin.write(buffer)) {
        await new Promise<void>((resolve) => stdin.once("drain", () => resolve()));
      }
    }).catch(() => {
      // The close handler observes the process exit and rejects the pending work.
    });
  }
}

function outcomeFor(code: RpcErrorCode): RpcOutcome {
  return code === "timeout" || code === "aborted" ? "unknown" : "failed";
}

/** The sandbox path is fixed; the executor still exports it so callers never re-declare it. */
export { PTC_SANDBOX_WORKSPACE };
