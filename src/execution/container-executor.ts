// Direct execution on the same host as the control plane, inside the deployment's sandbox
// container. The container already provides the isolation a remote host gets from bwrap and a
// cgroup, so a command runs directly through the shell — but it still gets one workspace root per
// session and one private `/tmp`, exactly like the bwrap host.
//
// Interface: `ContainerDirectHost` implements the RPC agent's `DirectHost`; `containerWorkspacePath`
// is the one rule that turns a requested virtual directory into a session root.
//
// Inputs: the directory the container mounts as `/workspaces` (one directory per bot), a tmp root,
// the image's PATH and shell. The model never names a host path: the session's root comes from the
// app, which derives it from the bot id, and every later path is checked against it.
//
// Errors: a path outside the session's root is `invalid_request` and nothing runs; a timed out or
// aborted command is reported as such, never as success.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { OutputWindow } from "./broker.js";
import { clampWindow } from "./direct-executor.js";
import { handleFileRequest } from "./file-requests.js";
import { chunkText, signalNumber } from "./output-chunks.js";
import { PtcFileService } from "./ptc-fs.js";
import { PtcHostError, type DirectHost } from "./ptc-host.js";
import type { RpcBashExecutePayload, RpcFileMethod, RpcSkippedOutput } from "./rpc-protocol.js";

type ContainerSession = {
  readonly sessionId: string;
  /** Virtual root this session is confined to; also its host path inside the container. */
  readonly root: string;
  readonly tmpPath: string;
  readonly files: PtcFileService;
  active?: { readonly child: ChildProcess };
};

export type ContainerDirectHostOptions = {
  /** The directory mounted at `/workspaces`; each bot owns one directory below it. */
  readonly workspacesRoot: string;
  /** Root for per-session private `/tmp` directories. */
  readonly tmpRoot: string;
  /** Fixed PATH of a command; the image decides what exists. */
  readonly path: string;
  readonly shellPath: string;
  readonly outputChunkBytes: number;
  readonly outputBytesPerSecond: number;
};

function normalized(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * A requested working directory, confined to `root`. Equality is allowed because the legacy
 * bootstrap bot works in the workspace root itself; anything above or beside it is refused.
 */
export function containerWorkspacePath(root: string, requested: string | undefined): string {
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
 * volume must not become a way to read another bot's directory through a path that passes the
 * prefix check.
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
 * The same-host direct host. It advertises a single writable root namespace: the session's own
 * workspace plus a private `/tmp`, mirroring the bwrap host's shape with fewer moving parts.
 */
export class ContainerDirectHost implements DirectHost {
  readonly enabled = true;
  readonly sharedMode = "rw";
  readonly #sessions = new Map<string, ContainerSession>();

  constructor(private readonly options: ContainerDirectHostOptions) {}

  async preflight(): Promise<Record<string, boolean | null>> {
    return { container: true, workspacesRoot: true };
  }

  async openSession(sessionId: string, cwd?: string): Promise<{ sharedMode: "rw"; tmpPath: string; workspace: string }> {
    if (this.#sessions.has(sessionId)) {
      throw new PtcHostError("busy", "session already exists", "not_started");
    }
    const root = containerWorkspacePath(this.options.workspacesRoot, cwd);
    await ensureWorkspace(this.options.workspacesRoot, root);
    const tmpPath = await mkdtemp(join(this.options.tmpRoot, "aster-direct-"));
    const session: ContainerSession = {
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
    const cwd = containerWorkspacePath(session.root, input.payload.cwd);
    if (session.active !== undefined) {
      throw new PtcHostError("busy", "a command is already running in this session", "not_started");
    }
    if (input.signal.aborted) {
      throw new PtcHostError("aborted", "the command was aborted before it started", "not_started");
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
        env: {
          PATH: this.options.path,
          LANG: "C.UTF-8",
          HOME: session.root,
          TMPDIR: "/tmp",
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

  private requireSession(sessionId: string): ContainerSession {
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
