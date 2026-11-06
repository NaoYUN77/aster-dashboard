// Direct execution on one shared Computer / Execution Host. Aster Dashboard is a single-user MVP:
// the host is not a per-bot container and provides no OS-level isolation. Every bot gets its own
// default working directory below one workspace root, but the underlying files and installed
// software (bash, git, python, node, claude code, herdr, ...) are shared by design.
//
// Interface: `SharedHostDirectHost` implements the RPC agent's `DirectHost`; `sessionWorkspacePath`
// is the one rule that turns a requested virtual directory into a session root. The agent process
// itself runs as a dedicated non-root Linux user (checked in `rpc-main.ts`), with no root, sudo,
// Docker socket or control-plane credentials.
//
// Inputs: the shared workspace root (one directory per bot), a private tmp root, the host's PATH
// and shell. The model never names a host path: the session's root comes from the app, which derives
// it from the bot id, and every later path is checked against it.
//
// Errors: a path outside the session's root is `invalid_request` and nothing runs; a timed out or
// aborted command is reported as such, never as success. Timeout, concurrency (enforced by the RPC
// agent), process-group termination, output windows and audit are all preserved from the RPC path;
// an interrupted RPC connection never replays a command automatically.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../errors.js";
import { OutputWindow } from "./broker.js";
import { clampWindow } from "./direct-executor.js";
import { handleFileRequest } from "./file-requests.js";
import { chunkText, signalNumber } from "./output-chunks.js";
import { PtcFileService } from "./ptc-fs.js";
import { PtcHostError, type DirectHost } from "./ptc-host.js";
import type { RpcBashExecutePayload, RpcFileMethod, RpcSkippedOutput } from "./rpc-protocol.js";

type SharedHostSession = {
  readonly sessionId: string;
  /** Virtual root this session is confined to; also its path on the shared host. */
  readonly root: string;
  readonly tmpPath: string;
  readonly files: PtcFileService;
  active?: { readonly child: ChildProcess };
};

export type SharedHostConfig = {
  /** Absolute root below which every bot's default working directory lives. */
  readonly workspacesRoot: string;
  /** Root for per-session private `/tmp` directories. */
  readonly tmpRoot: string;
  /** Fixed PATH of a command; the host decides what exists. */
  readonly path: string;
  readonly shellPath: string;
  readonly outputChunkBytes: number;
  readonly outputBytesPerSecond: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing configuration: ${name}`);
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
    throw new ConfigurationError(`${name} must be an absolute path without '..'`);
  }
  return value.replace(/\/+$/, "") || "/";
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function booleanFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new ConfigurationError(`${name} must be 0 or 1`);
}

/**
 * Phase 1 shared-host mode of the Execution Agent. `EXECUTION_AGENT_SHARED_HOST=1` is the only
 * switch; it is opt-in so the existing bwrap/cgroup PTC agent keeps its own deployment path.
 * Phase 1 migrates Bash / Read / Write / Edit only, so PTC is not started here.
 */
export function readSharedHostConfig(env: NodeJS.ProcessEnv = process.env): SharedHostConfig | undefined {
  if (!booleanFlag(env, "EXECUTION_AGENT_SHARED_HOST")) return undefined;
  return {
    workspacesRoot: required(env, "EXECUTION_AGENT_WORKSPACES"),
    tmpRoot: required(env, "EXECUTION_AGENT_TMP_ROOT"),
    path: env.EXECUTION_AGENT_PATH?.trim() || "/usr/local/bin:/usr/bin:/bin",
    shellPath: required(env, "EXECUTION_AGENT_SHELL"),
    outputChunkBytes: integer(env, "EXECUTION_AGENT_OUTPUT_CHUNK_BYTES", 32 * 1024, 1_024, 64 * 1024),
    outputBytesPerSecond: integer(env, "EXECUTION_AGENT_OUTPUT_BYTES_PER_SECOND", 0, 0, 1_000_000_000),
  };
}

/**
 * The Execution Service must never run as root on the shared host: no root, sudo, Docker socket or
 * control-plane credentials. This is a startup guard, not an OS isolation mechanism.
 */
export function assertNotRoot(getuid: () => number | undefined = () =>
  (typeof process.getuid === "function" ? process.getuid() : undefined)): void {
  if (getuid() === 0) {
    throw new ConfigurationError(
      "shared host mode must not run as root; start the Execution Service as its dedicated non-root user",
    );
  }
}

/** Operator-facing summary; no host path is secret, but the report stays free of credentials. */
export function describeSharedHostConfig(config: SharedHostConfig): Record<string, unknown> {
  return {
    mode: "shared-host",
    workspacesRoot: config.workspacesRoot,
    tmpRoot: config.tmpRoot,
    shellPath: config.shellPath,
    path: config.path,
    outputChunkBytes: config.outputChunkBytes,
    outputBytesPerSecond: config.outputBytesPerSecond,
  };
}

function normalized(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * A requested working directory, confined to `root`. Equality is allowed because the legacy
 * bootstrap bot works in the workspace root itself; anything above or beside it is refused.
 */
export function sessionWorkspacePath(root: string, requested: string | undefined): string {
  const base = normalized(root);
  const value = normalized(requested ?? base);
  if (!base.startsWith("/") || value.includes("\0") || value.includes("\\")) {
    throw new PtcHostError("invalid_request", "the workspace path is invalid", "not_started");
  }
  const parts = value.split("/");
  if (parts.includes("..") || parts.includes(".")) {
    throw new PtcHostError("invalid_request", "the workspace path is invalid", "not_started");
  }
  if (value !== base && !value.startsWith(`${base}/`)) {
    throw new PtcHostError("invalid_request", `the workspace must be ${base} or a directory below it`, "not_started");
  }
  return value;
}

/**
 * Create the session directory and prove it really lives under the workspace root. A symlink in the
 * shared tree must not become a way to read another bot's directory through a path that passes the
 * prefix check. This is a correctness bound, not a security/tenant isolation claim.
 */
export async function ensureWorkspace(root: string, directory: string): Promise<void> {
  const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new PtcHostError("internal", "the workspace cannot be inspected", "not_started");
  });
  if (existing?.isSymbolicLink()) {
    throw new PtcHostError("invalid_request", "the workspace must not be a symbolic link", "not_started");
  }
  if (existing !== undefined && !existing.isDirectory()) {
    throw new PtcHostError("invalid_request", "the workspace is not a directory", "not_started");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}/`)) {
    throw new PtcHostError("invalid_request", "the workspace resolves outside the workspace root", "not_started");
  }
}

/**
 * Environment variables the host owns: its runtime configuration, the command's working directory
 * and its identity. They come from host context, never from the wire payload. A request that tries
 * to set one is rejected with an explicit `invalid_request` rather than silently rewritten, so no
 * caller is told a value took effect when the host ignored it.
 */
const HOST_ENV_KEYS = new Set(["PATH", "LANG", "HOME", "TMPDIR", "PTC_INSIDE_SANDBOX"]);

/**
 * The shared-host direct host. It advertises a single writable root namespace: the session's own
 * workspace plus a private `/tmp`, preserving the RPC protocol's shape with no bwrap or cgroup.
 */
export class SharedHostDirectHost implements DirectHost {
  readonly enabled = true;
  readonly sharedMode = "rw";
  readonly #sessions = new Map<string, SharedHostSession>();

  constructor(private readonly options: SharedHostConfig) {}

  async preflight(): Promise<Record<string, boolean | null>> {
    return { sharedHost: true, workspacesRoot: true };
  }

  async openSession(sessionId: string, cwd?: string): Promise<{ sharedMode: "rw"; tmpPath: string; workspace: string }> {
    if (this.#sessions.has(sessionId)) {
      throw new PtcHostError("busy", "session already exists", "not_started");
    }
    const root = sessionWorkspacePath(this.options.workspacesRoot, cwd);
    await ensureWorkspace(this.options.workspacesRoot, root);
    const tmpPath = await mkdtemp(join(this.options.tmpRoot, "aster-direct-"));
    const session: SharedHostSession = {
      sessionId,
      root,
      tmpPath,
      files: new PtcFileService({
        roots: [
          { virtual: root, host: root, writable: true },
          { virtual: "/tmp", host: tmpPath, writable: true },
        ],
      }),
    };
    this.#sessions.set(sessionId, session);
    return { sharedMode: "rw", tmpPath, workspace: root };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    if (session.active !== undefined) kill(session.active);
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
    const cwd = sessionWorkspacePath(session.root, input.payload.cwd);
    if (session.active !== undefined) {
      throw new PtcHostError("busy", "a command is already running in this session", "not_started");
    }
    if (input.signal.aborted) {
      throw new PtcHostError("aborted", "the command was aborted before it started", "not_started");
    }
    // The RPC payload's `env` is untrusted input at the execution boundary. Task-intent variables
    // are allowed, but host-owned ones (credentials, identity, runtime directory, service clients)
    // are fixed by the host and must not be specified or overridden by the caller.
    const owned = Object.keys(input.payload.env).filter((key) => HOST_ENV_KEYS.has(key));
    if (owned.length > 0) {
      throw new PtcHostError(
        "invalid_request",
        `the host owns these environment variables and the request cannot set them: ${owned.sort().join(", ")}`,
        "not_started",
      );
    }
    const argv = typeof input.payload.command === "string"
      ? [this.options.shellPath, "-c", input.payload.command]
      : [...input.payload.command];
    const [file, ...args] = argv;
    if (file === undefined) {
      throw new PtcHostError("internal", "the command is empty", "not_started");
    }

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        // `inheritEnv` on the wire is deliberately ignored: the Execution Service's own process
        // environment may hold TLS paths and host configuration, and is never inherited into a
        // command. Only validated, non-host-owned task variables are added.
        env: {
          PATH: this.options.path,
          LANG: "C.UTF-8",
          HOME: session.root,
          TMPDIR: "/tmp",
          // Marker inherited from the PTC runner so nested tools do not try to sandbox again.
          PTC_INSIDE_SANDBOX: "1",
          ...input.payload.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      throw new PtcHostError(
        "spawn_error",
        `the command could not start: ${error instanceof Error ? error.message : "spawn failed"}`,
        "not_started",
      );
    }
    session.active = { child };

    const startedAt = Date.now();
    const window = clampWindow(input.payload, this.options);
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
        const parts = chunkText(taken.text, this.options.outputChunkBytes);
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

    const stop = () => kill(session.active);
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.payload.timeoutMs);
    timeout.unref();
    const onAbort = () => stop();
    input.signal.addEventListener("abort", onAbort, { once: true });
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
    }

    if (spawnError !== undefined) {
      throw new PtcHostError("spawn_error", `the command could not start: ${spawnError.message}`, "failed");
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

  private requireSession(sessionId: string): SharedHostSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new PtcHostError("not_found", "session is not open", "not_started");
    }
    return session;
  }
}

/** Kill the command's whole process group; a shell command may have started children. */
function kill(active: { readonly child: ChildProcess } | undefined): void {
  if (active === undefined) return;
  try {
    if (active.child.pid !== undefined) process.kill(-active.child.pid, "SIGKILL");
    else active.child.kill("SIGKILL");
  } catch {
    // The process may already be gone.
  }
}
