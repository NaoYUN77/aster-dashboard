// The `ExecutionEnv` for a direct RPC session: one command per `exec`, and file primitives over the
// same session's `/shared` and `/tmp` namespaces.
//
// Interface: pi-durable's built-in tools see a normal environment. `exec` becomes one `execute`
// request with `executor: "bash"`; the file methods delegate to `RemoteFileSystem`, which uses the
// `file.*` requests. Nothing in this environment contacts the host directly — the RPC client is
// shared with the gateway and owns framing, deadlines and cancellation.
//
// Inputs: a host-created session id, the client, and the configured cwd (a virtual path inside
// `/shared`). The model supplies only commands, environment variables and timeouts.
//
// Errors: validation failures and transport failures become `ExecutionError`s; a write whose
// outcome is unknown never becomes a success.

import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileError,
  type FileInfo,
  type FileListing,
  type FileWatcher,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { RpcClientError, type RpcBashExecuteHandle, type RpcSessionResult } from "./rpc-client.js";
import { RemoteFileSystem } from "./remote-files.js";
import {
  PTC_MAX_WINDOW_BYTES,
  PTC_MAX_WINDOW_LINES,
  RPC_MAX_DEADLINE_MS,
  type PtcOutputWindow,
  type RpcBashExecutePayload,
  type RpcFileMethod,
} from "./rpc-protocol.js";
import { validateCommand, validateCwd, validateEnv, validateTimeoutSeconds } from "./protocol.js";

const RPC_DEADLINE_SLACK_MS = 60_000;
const DEFAULT_WINDOW: PtcOutputWindow = { maxBytes: 32 * 1024, maxLines: 1_000, minIntervalMs: 0, bytesPerSecond: 0 };

/** The client surface a direct environment needs; the gateway and this environment share one client. */
export type DirectEnvClient = {
  openSession(
    sessionId: string,
    options?: { readonly deadlineMs?: number; readonly signal?: AbortSignal },
  ): Promise<RpcSessionResult>;
  closeSession(
    sessionId: string,
    options?: { readonly deadlineMs?: number; readonly signal?: AbortSignal },
  ): Promise<void>;
  startBashExecute(
    sessionId: string,
    payload: RpcBashExecutePayload,
    options?: {
      readonly deadlineMs?: number;
      readonly signal?: AbortSignal;
      readonly onOutput?: (event: { readonly text: string; readonly stream: "stdout" | "stderr"; readonly skipped?: { readonly bytes: number; readonly newlines: number; readonly endsWithNewline: boolean } }) => void;
    },
  ): RpcBashExecuteHandle;
  fileRequest(
    sessionId: string,
    method: RpcFileMethod,
    payload: Record<string, unknown>,
    options?: { readonly deadlineMs?: number; readonly signal?: AbortSignal },
  ): Promise<unknown>;
};

export type RemoteRpcEnvOptions = {
  readonly client: DirectEnvClient;
  readonly sessionId: string;
  /** Virtual working directory; must be `/shared` or a path below it. */
  readonly cwd: string;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
};

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function clampWindow(window: PtcOutputWindow | undefined): PtcOutputWindow {
  const source = window ?? DEFAULT_WINDOW;
  return {
    maxBytes: clampInteger(source.maxBytes, 1, PTC_MAX_WINDOW_BYTES),
    maxLines: clampInteger(source.maxLines, 1, PTC_MAX_WINDOW_LINES),
    minIntervalMs: clampInteger(source.minIntervalMs, 0, 60_000),
    bytesPerSecond: clampInteger(source.bytesPerSecond, 0, 1_000_000_000),
  };
}

function isSharedPath(value: string): boolean {
  const normalized = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  return normalized === "/shared"
    || (normalized.startsWith("/shared/")
      && !normalized.includes("\0")
      && !normalized.includes("\\")
      && !normalized.split("/").includes(".."));
}

/**
 * A session the agent swept while idle answers `not_found` with outcome `not_started`: the request
 * never ran. A file that is genuinely missing uses the same code with outcome `failed`.
 */
function isMissingSession(error: unknown): boolean {
  return error instanceof RpcClientError
    && error.code === "not_found"
    && error.options.outcome === "not_started";
}

function mapExecutionError(error: unknown): ExecutionError {
  if (!(error instanceof RpcClientError)) return new ExecutionError("unknown", "Remote execution failed");
  switch (error.code) {
    case "aborted":
      return new ExecutionError("aborted", "Command aborted", error);
    case "timeout":
      return new ExecutionError("timeout", "Command timed out", error);
    case "spawn_error":
      return new ExecutionError("spawn_error", "The command could not start", error);
    case "busy":
      return new ExecutionError("unknown", "Execution agent is busy; retry the command", error);
    case "not_found":
      return new ExecutionError("unknown", "The direct execution session is no longer active", error);
    case "unavailable":
      return new ExecutionError("unknown", "Execution agent is unavailable; the command outcome is unknown", error);
    case "not_implemented":
    case "unsupported_version":
      return new ExecutionError("unknown", "Execution agent does not support direct sessions", error);
    default:
      return new ExecutionError("unknown", `${error.message}; the command outcome is unknown`, error);
  }
}

/**
 * One direct session per agent run. The session is opened on first use, so constructing the
 * environment does not contact the execution agent, and closed by `close()` when the run ends.
 */
export class RemoteRpcExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #client: DirectEnvClient;
  readonly #sessionId: string;
  readonly #defaultTimeoutSeconds: number;
  readonly #maxTimeoutMs: number;
  readonly #files: RemoteFileSystem;
  #opening: Promise<void> | undefined;
  #reopening: Promise<void> | undefined;
  #closed = false;

  constructor(options: RemoteRpcEnvOptions) {
    if (!isSharedPath(options.cwd)) {
      throw new Error("a direct session's cwd must be inside /shared");
    }
    this.id = `direct:${options.sessionId}`;
    this.cwd = options.cwd;
    this.#client = options.client;
    this.#sessionId = options.sessionId;
    this.#defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    this.#maxTimeoutMs = Math.min(options.maxTimeoutSeconds * 1_000, RPC_MAX_DEADLINE_MS - RPC_DEADLINE_SLACK_MS);
    this.#files = new RemoteFileSystem({
      namespace: this.id,
      cwd: this.cwd,
      request: (method, payload, requestOptions) => this.#fileRequest(method, payload, requestOptions),
    });
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** Open the session once; concurrent callers share one request. */
  async #open(): Promise<void> {
    if (this.#closed) throw new RpcClientError("unavailable", "the direct session is closed");
    this.#opening ??= (async () => {
      const result = await this.#client.openSession(this.#sessionId);
      if (result.direct === undefined) {
        await this.#client.closeSession(this.#sessionId).catch(() => undefined);
        throw new RpcClientError("not_implemented", "the execution agent did not open a direct session", {
          outcome: "not_started",
        });
      }
    })();
    try {
      await this.#opening;
    } catch (error) {
      this.#opening = undefined;
      throw error;
    }
  }

  /**
   * A long-lived environment can outlive the agent's idle sweep. A missing session is re-established
   * once, and only when the agent said the request never started, so no side effect is duplicated.
   * The new session gets a fresh `/tmp`; handles opened in the old one are already dead.
   */
  async #reopen(): Promise<void> {
    this.#reopening ??= (async () => {
      this.#opening = undefined;
      await this.#open();
    })().finally(() => {
      this.#reopening = undefined;
    });
    await this.#reopening;
  }

  async #withSession<T>(operation: () => Promise<T>): Promise<T> {
    await this.#open();
    try {
      return await operation();
    } catch (error) {
      if (!isMissingSession(error)) throw error;
      await this.#reopen();
      return await operation();
    }
  }

  #fileRequest(
    method: RpcFileMethod,
    payload: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> {
    return this.#withSession(() => this.#client.fileRequest(this.#sessionId, method, payload, options));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#reopening?.catch(() => undefined);
    if (this.#opening === undefined) return;
    await this.#opening.catch(() => undefined);
    await this.#client.closeSession(this.#sessionId).catch(() => undefined);
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
    const commandError = validateCommand(command);
    if (commandError !== undefined) return err(new ExecutionError("unknown", `Invalid command: ${commandError}`));
    const env = options?.env ?? {};
    const envError = validateEnv(env);
    if (envError !== undefined) return err(new ExecutionError("unknown", `Invalid environment: ${envError}`));
    const requested = options?.cwd ?? this.cwd;
    const cwd = requested.startsWith("/") ? posix.normalize(requested) : posix.resolve(this.cwd, requested);
    const cwdError = validateCwd(cwd);
    if (cwdError !== undefined) return err(new ExecutionError("unknown", `Invalid working directory: ${cwdError}`));
    if (!isSharedPath(cwd)) {
      return err(new ExecutionError("unknown", "The direct session runs commands only inside /shared"));
    }
    // pi-durable passes seconds as any finite number; the wire contract uses whole milliseconds, so
    // a sub-second request rounds up rather than silently becoming zero.
    const seconds = options?.timeout === undefined ? this.#defaultTimeoutSeconds : Math.ceil(options.timeout);
    const timeoutError = validateTimeoutSeconds(seconds);
    if (timeoutError !== undefined) return err(new ExecutionError("timeout", `Invalid timeout: ${timeoutError}`));
    const timeoutMs = seconds * 1_000;
    if (timeoutMs > this.#maxTimeoutMs) {
      return err(new ExecutionError(
        "timeout",
        `Timeout ${seconds}s exceeds the direct execution limit of ${Math.floor(this.#maxTimeoutMs / 1_000)}s`,
      ));
    }

    const payload: RpcBashExecutePayload = {
      executor: "bash",
      command,
      cwd,
      env,
      inheritEnv: options?.inheritEnv ?? true,
      timeoutMs,
      window: clampWindow(options?.window),
    };
    try {
      const result = await this.#withSession(async () => {
        const handle: RpcBashExecuteHandle = this.#client.startBashExecute(this.#sessionId, payload, {
          deadlineMs: Math.min(RPC_MAX_DEADLINE_MS, timeoutMs + RPC_DEADLINE_SLACK_MS),
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          onOutput: (event) => {
            options?.onOutput?.(event.text, context, {
              stream: event.stream,
              ...(event.skipped === undefined ? {} : { skipped: event.skipped }),
            });
          },
        });
        return await handle.result;
      });
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      return err(mapExecutionError(error));
    }
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#files.absolutePath(path, context);
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.#files.joinPath(parts, context);
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#files.readTextFile(path, context);
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.#files.openTextLineReader(path, context);
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.#files.readTextLines(path, options, context);
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.#files.readBinaryFile(path, context);
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.#files.openBinaryReader(path, options, context);
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#files.writeFile(path, content, context);
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#files.appendFile(path, content, context);
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.#files.truncateFile(path, size, context);
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.#files.flushFile(path, context);
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.#files.renameFile(sourcePath, destinationPath, context);
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#files.fileInfo(path, context);
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.#files.listDir(path, context);
  }

  async listFiles(path: string, options: ListFilesOptions | undefined, context: Context): Promise<Result<FileListing, FileError>> {
    return this.#files.listFiles(path, options, context);
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.#files.openDirReader(path, context);
  }

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.#files.watch(targets, onChange, context);
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#files.canonicalPath(path, context);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.#files.exists(path, context);
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.#files.createDir(path, options, context);
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.#files.remove(path, options, context);
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.#files.createTempDir(prefix, context);
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.#files.createTempFile(options, context);
  }

  /**
   * Commands of this environment are killed through the RPC request that owns them; the session
   * itself outlives one tool call and is closed by `close()`.
   */
  async cleanup(_context: Context): Promise<void> {
    return;
  }
}
