// Direct RPC execution: one bwrap-isolated command per request, plus bounded file primitives over
// `/shared` and a private `/tmp` directory. Unlike PTC, no runner process stays alive: every
// request starts a fresh sandbox, and the session owns only its tmp directory and file handles.
//
// The session sees `/shared` (the agent host's shared workspace, read-only unless the operator
// chose `rw`) and `/tmp` (a per-session host directory). `/workspace` — the control plane's job
// area — is never mounted here. Direct mode is available only with full bwrap isolation; there is
// no degraded fallback.

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { OutputWindow } from "./broker.js";
import { chunkText, signalNumber } from "./output-chunks.js";
import { buildDirectBwrapArgv } from "./ptc-bwrap.js";
import { createPtcCgroup, spawnInCgroup, type PtcCgroup, type PtcRuntimeProbe } from "./ptc-cgroup.js";
import type { PtcConfig } from "./ptc-config.js";
import { handleFileRequest } from "./file-requests.js";
import { PtcFileService } from "./ptc-fs.js";
import { PtcHostError, type DirectHost } from "./ptc-host.js";
import {
  PTC_MAX_WINDOW_LINES,
  RPC_MAX_OUTPUT_CHUNK_BYTES,
  type RpcBashExecutePayload,
  type RpcFileMethod,
  type RpcSkippedOutput,
} from "./rpc-protocol.js";

type DirectSession = {
  readonly sessionId: string;
  readonly tmpPath: string;
  readonly files: PtcFileService;
  active?: { readonly child: ChildProcess; readonly cgroup?: PtcCgroup };
};

export type DirectExecutorOptions = {
  readonly config: PtcConfig;
  readonly probe: PtcRuntimeProbe;
};

/**
 * The direct-session host. Direct execution is opt-in (`PTC_DIRECT_ENABLED=1`), needs a readable
 * shared workspace and a writable tmp root, and never runs outside bwrap.
 */
export class DirectExecutor implements DirectHost {
  readonly enabled: boolean;
  readonly sharedMode: "none" | "ro" | "rw";
  readonly #sessions = new Map<string, DirectSession>();
  #nextExecution = 1;

  constructor(private readonly options: DirectExecutorOptions) {
    const { config, probe } = options;
    this.sharedMode = config.sharedWorkspaceMode;
    this.enabled = config.directEnabled
      && probe.isolation.mode === "bwrap"
      && probe.isolation.bwrap
      && probe.isolation.userNamespace
      && probe.isolation.cgroup === "v2"
      && probe.checks.sharedWorkspace === true
      && probe.checks.directTmpRoot === true;
  }

  async preflight(): Promise<Record<string, boolean | null>> {
    return {
      direct: this.enabled,
      sharedWorkspace: this.options.probe.checks.sharedWorkspace ?? null,
      directTmpRoot: this.options.probe.checks.directTmpRoot ?? null,
    };
  }

  async openSession(sessionId: string, _cwd?: string): Promise<{ sharedMode: "ro" | "rw"; tmpPath: string; workspace: string }> {
    if (!this.enabled) {
      throw new PtcHostError("unavailable", "direct execution is not available on this host", "not_started");
    }
    if (this.#sessions.has(sessionId)) {
      throw new PtcHostError("busy", "session already exists", "not_started");
    }
    const shared = this.options.config.sharedWorkspace;
    if (shared === undefined || this.sharedMode === "none") {
      throw new PtcHostError("internal", "direct execution needs a shared workspace", "not_started");
    }
    const tmpPath = await mkdtemp(join(this.options.config.directTmpRoot, "aster-direct-"));
    await chmod(tmpPath, 0o700).catch(() => undefined);
    const session: DirectSession = {
      sessionId,
      tmpPath,
      files: new PtcFileService({
        roots: [
          { virtual: "/shared", host: shared, writable: this.sharedMode === "rw" },
          { virtual: "/tmp", host: tmpPath, writable: true },
        ],
      }),
    };
    this.#sessions.set(sessionId, session);
    return { sharedMode: this.sharedMode === "rw" ? "rw" : "ro", tmpPath, workspace: "/shared" };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    if (session.active !== undefined) this.#kill(session.active);
    await session.files.closeAll();
    await rm(session.tmpPath, { recursive: true, force: true }).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.#sessions.keys()]) await this.closeSession(sessionId);
  }

  async execute(input: {
    sessionId: string;
    payload: RpcBashExecutePayload;
    signal: AbortSignal;
    emit: (seq: number, stream: "stdout" | "stderr", text: string, skipped?: RpcSkippedOutput) => void;
  }): Promise<{ exitCode: number; durationMs: number }> {
    const session = this.requireSession(input.sessionId);
    const cwd = sharedCwd(input.payload.cwd);
    if (session.active !== undefined) {
      throw new PtcHostError("busy", "a command is already running in this session", "not_started");
    }
    if (input.signal.aborted) {
      throw new PtcHostError("aborted", "the command was aborted before it started", "not_started");
    }
    const config = this.options.config;
    const argv = buildDirectBwrapArgv(config, {
      sharedPath: config.sharedWorkspace!,
      tmpPath: session.tmpPath,
      cwd,
    }, input.payload);
    const [file, ...args] = argv;
    if (file === undefined) {
      throw new PtcHostError("internal", "the sandbox command is empty", "not_started");
    }

    const cgroup = await createPtcCgroup(config, this.executionId(session.sessionId, input.payload));
    let child: ChildProcess;
    let ready: Promise<void>;
    try {
      const accounted = spawnInCgroup(cgroup.path, file, args, {
        cwd: session.tmpPath,
        env: { PATH: config.nodePath, LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child = accounted.child;
      ready = accounted.ready;
    } catch (error) {
      await cgroup.release();
      throw new PtcHostError(
        "spawn_error",
        `the sandbox could not start: ${error instanceof Error ? error.message : "spawn failed"}`,
        "not_started",
      );
    }
    try {
      // bwrap unshares the cgroup namespace, so the process must be accounted for before it runs.
      await ready;
    } catch (error) {
      child.kill("SIGKILL");
      await cgroup.release();
      throw new PtcHostError(
        "internal",
        `the sandbox process could not be accounted for: ${error instanceof Error ? error.message : "cgroup write failed"}`,
        "not_started",
      );
    }
    session.active = { child, cgroup };

    const startedAt = Date.now();
    const window = clampWindow(input.payload, config);
    const sink = new OutputWindow(window.maxBytes, window.maxLines);
    let seq = 0;
    let timer: NodeJS.Timeout | undefined;
    let nextFlushDelay = 0;
    let ended = false;
    let spawnError: Error | undefined;
    let timedOut = false;

    const flush = () => {
      timer = undefined;
      const taken = sink.take();
      if (taken === undefined) return;
      if (taken.text.length > 0) {
        const parts = chunkText(taken.text, RPC_MAX_OUTPUT_CHUNK_BYTES);
        for (const [index, text] of parts.entries()) {
          input.emit(seq++, "stdout", text, index === 0 ? taken.skipped : undefined);
        }
        const bytes = Buffer.byteLength(taken.text, "utf8");
        nextFlushDelay = window.bytesPerSecond > 0 ? Math.ceil((bytes / window.bytesPerSecond) * 1_000) : 0;
      }
      if (!ended) schedule();
    };
    const schedule = () => {
      if (ended || timer !== undefined) return;
      const wait = Math.max(window.minIntervalMs, nextFlushDelay);
      if (wait === 0) {
        flush();
        return;
      }
      timer = setTimeout(flush, wait);
      timer.unref();
    };

    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      sink.push(chunk.toString("utf8"));
      schedule();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      sink.push(chunk.toString("utf8"));
      schedule();
    });

    const kill = () => this.#kill(session.active);
    const timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.payload.timeoutMs);
    timeout.unref();
    const onAbort = () => kill();
    input.signal.addEventListener("abort", onAbort, { once: true });
    // The signal may have fired while the sandbox was being accounted for, before the listener
    // existed; kill now rather than letting the command run to its timeout.
    if (input.signal.aborted) onAbort();

    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    try {
      ({ code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
        child.once("error", () => resolve({ code: null, signal: null }));
      }));
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      flush();
      session.active = undefined;
      await cgroup.release();
    }

    if (spawnError !== undefined) {
      throw new PtcHostError("spawn_error", `the sandbox could not start: ${spawnError.message}`, "failed");
    }
    if (timedOut) {
      throw new PtcHostError("timeout", `the command timed out after ${input.payload.timeoutMs} ms`, "unknown");
    }
    if (input.signal.aborted) {
      throw new PtcHostError("aborted", "the command was aborted", "unknown");
    }
    return {
      exitCode: code ?? (128 + signalNumber(signal)),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  async fileRequest(input: {
    sessionId: string;
    method: RpcFileMethod;
    payload: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<unknown> {
    const session = this.requireSession(input.sessionId);
    if (input.signal.aborted) {
      throw new PtcHostError("aborted", "the file request was aborted before it started", "not_started");
    }
    return handleFileRequest(session.files, session.sessionId, input);
  }

  private requireSession(sessionId: string): DirectSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new PtcHostError("not_found", "session is not open", "not_started");
    }
    return session;
  }

  private executionId(sessionId: string, payload: RpcBashExecutePayload): string {
    const counter = this.#nextExecution++;
    const digest = createHash("sha256")
      .update(`direct\0${sessionId}\0${counter}\0${payload.command instanceof Array ? payload.command.join("\0") : payload.command}`)
      .digest("hex");
    return digest.slice(0, 16);
  }

  #kill(active: { readonly child: ChildProcess } | undefined): void {
    if (active === undefined) return;
    try {
      if (active.child.pid !== undefined) process.kill(-active.child.pid, "SIGKILL");
      else active.child.kill("SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }
}

/** Resolve a direct session's working directory; it must stay inside `/shared`. */
export function sharedCwd(value: string): string {
  const normalized = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  if (normalized !== "/shared" && !normalized.startsWith("/shared/")) {
    throw new PtcHostError("invalid_request", "the working directory must be inside /shared", "not_started");
  }
  if (normalized.includes("\0") || normalized.includes("\\") || normalized.split("/").includes("..")) {
    throw new PtcHostError("invalid_request", "the working directory is invalid", "not_started");
  }
  return normalized;
}

/** The caller's output window, clamped to what this host is willing to emit. */
export function clampWindow(
  payload: RpcBashExecutePayload,
  bounds: Pick<PtcConfig, "outputChunkBytes" | "outputBytesPerSecond">,
): RpcBashExecutePayload["window"] {
  return {
    maxBytes: Math.max(1, Math.min(payload.window.maxBytes, bounds.outputChunkBytes, RPC_MAX_OUTPUT_CHUNK_BYTES)),
    maxLines: Math.max(1, Math.min(payload.window.maxLines, PTC_MAX_WINDOW_LINES)),
    minIntervalMs: Math.min(Math.max(0, payload.window.minIntervalMs), 1_000),
    bytesPerSecond: Math.max(0, Math.min(payload.window.bytesPerSecond, Math.max(0, bounds.outputBytesPerSecond))),
  };
}
