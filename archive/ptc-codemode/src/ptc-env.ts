// The `ExecutionEnv` a nested code mode tool call sees in remote PTC mode.
//
// Interface: one instance per nested `bash` call. `exec` turns pi-durable's shell request into one
// `tool.call` on the job's RPC session, streams the runner's windowed tail into the caller's
// `output`, records the returned `OutputRef` through the host callback, and reports only the exit
// code. Every filesystem operation fails closed with `not_supported`: the sandbox has no file
// tools in Phase 1, and pretending to read the control plane's disk while commands run elsewhere
// would give the model two different views of one path.
//
// Inputs: the call's `PtcSession` (host-created identity), the VM `callId` taken from the durable
// nested key, the configured timeout bounds, and host options from pi-durable. The model supplies
// only the command, its environment and a timeout in seconds.
//
// Errors: validation failures, RPC failures and the runner's terminal errors are mapped to
// `ExecutionError` codes; a remote timeout is `timeout`, an abort is `aborted`, and a transport
// failure whose outcome is unknown stays `unknown` rather than becoming a success.
//
// Side effects: one RPC `tool.call`, output callbacks, and one host commit per returned output ref.

import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
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
import { RpcClientError } from "./execution/rpc-client.js";
import { RemoteFileSystem } from "./execution/remote-files.js";
import {
  PTC_MAX_TOOL_TIMEOUT_MS,
  PTC_MAX_WINDOW_BYTES,
  PTC_MAX_WINDOW_LINES,
  PTC_WORKSPACE_PATH,
  RPC_MAX_DEADLINE_MS,
  type PtcOutputRef,
  type PtcOutputWindow,
  type PtcToolCallArgs,
} from "./execution/rpc-protocol.js";
import { validateCommand, validateCwd, validateEnv, validateTimeoutSeconds } from "./execution/protocol.js";
import type { PtcSession } from "./ptc-session.js";

/** Slack over the command timeout for transport and the runner's own cleanup. */
const RPC_DEADLINE_SLACK_MS = 60_000;
/**
 * The wire deadline caps at one hour, so a longer command cannot be transported at all. Refusing it
 * loudly is the only honest answer; letting the request expire would report a live command as failed.
 */
export const PTC_MAX_CALL_TIMEOUT_MS = RPC_MAX_DEADLINE_MS - RPC_DEADLINE_SLACK_MS;
export const PTC_DEFAULT_WINDOW: PtcOutputWindow = {
  maxBytes: 32 * 1024,
  maxLines: 1_000,
  minIntervalMs: 0,
  bytesPerSecond: 0,
};

const FILE_TOOLS_UNAVAILABLE =
  "The PTC sandbox supports reading, writing and editing files under /workspace, /shared and /tmp only";

export type PtcExecutionEnvOptions = {
  readonly session: PtcSession;
  /** VM call id, derived from the durable nested key `c<callId>`; never supplied by the model. */
  readonly callId: number;
  readonly cwd: typeof PTC_WORKSPACE_PATH;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
  /** Persist the ref before the result reaches the VM. A rejection fails the call. */
  readonly onOutputRef: (ref: PtcOutputRef, context: Context) => Promise<void>;
};

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function clampWindow(window: PtcOutputWindow | undefined): PtcOutputWindow {
  const source = window ?? PTC_DEFAULT_WINDOW;
  return {
    maxBytes: clampInteger(source.maxBytes, 1, PTC_MAX_WINDOW_BYTES),
    maxLines: clampInteger(source.maxLines, 1, PTC_MAX_WINDOW_LINES),
    minIntervalMs: clampInteger(source.minIntervalMs, 0, 60_000),
    bytesPerSecond: clampInteger(source.bytesPerSecond, 0, 1_000_000_000),
  };
}

export class PtcExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: typeof PTC_WORKSPACE_PATH;
  private readonly session: PtcSession;
  private readonly callId: number;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutMs: number;
  private readonly onOutputRef: (ref: PtcOutputRef, context: Context) => Promise<void>;
  readonly #files: RemoteFileSystem;
  #lastOutputRef: PtcOutputRef | undefined;
  #lastSpillTruncated = false;

  constructor(options: PtcExecutionEnvOptions) {
    if (!Number.isSafeInteger(options.callId) || options.callId < 1) {
      throw new Error("PTC execution env needs a positive call id");
    }
    this.session = options.session;
    this.callId = options.callId;
    this.cwd = options.cwd;
    this.id = `ptc:${options.session.sessionId}:${options.callId}`;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    this.maxTimeoutMs = Math.min(
      options.maxTimeoutSeconds * 1_000,
      PTC_MAX_TOOL_TIMEOUT_MS,
      PTC_MAX_CALL_TIMEOUT_MS,
    );
    this.onOutputRef = options.onOutputRef;
    this.#files = new RemoteFileSystem({
      namespace: `ptc:${options.session.sessionId}`,
      cwd: this.cwd,
      request: (method, payload, requestOptions) => options.session.client.fileRequest(
        options.session.sessionId,
        method,
        payload,
        requestOptions,
      ),
    });
  }

  /** The ref produced by the last successful command, for the tool wrapper's structured output. */
  get outputRef(): PtcOutputRef | undefined {
    return this.#lastOutputRef;
  }

  /** Whether the runner stopped writing at the spill bound; the stored prefix is not the whole output. */
  get spillTruncated(): boolean {
    return this.#lastSpillTruncated;
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
    this.#lastOutputRef = undefined;
    this.#lastSpillTruncated = false;

    const commandError = validateCommand(command);
    if (commandError !== undefined) return err(new ExecutionError("unknown", `Invalid command: ${commandError}`));
    const env = options?.env ?? {};
    const envError = validateEnv(env);
    if (envError !== undefined) return err(new ExecutionError("unknown", `Invalid environment: ${envError}`));
    const requested = options?.cwd ?? this.cwd;
    const cwd = requested.startsWith("/") ? posix.normalize(requested) : posix.resolve(this.cwd, requested);
    const cwdError = validateCwd(cwd);
    if (cwdError !== undefined) return err(new ExecutionError("unknown", `Invalid working directory: ${cwdError}`));
    if (cwd !== this.cwd) {
      return err(new ExecutionError("unknown", `The PTC sandbox runs commands only in ${this.cwd}`));
    }
    // pi-durable passes seconds as any finite number; the wire contract uses whole milliseconds, so
    // a sub-second request rounds up rather than silently becoming zero.
    const seconds = options?.timeout === undefined ? this.defaultTimeoutSeconds : Math.ceil(options.timeout);
    const timeoutError = validateTimeoutSeconds(seconds);
    if (timeoutError !== undefined) return err(new ExecutionError("timeout", `Invalid timeout: ${timeoutError}`));
    const timeoutMs = seconds * 1_000;
    if (timeoutMs > this.maxTimeoutMs) {
      return err(new ExecutionError(
        "timeout",
        `Timeout ${seconds}s exceeds the PTC call limit of ${Math.floor(this.maxTimeoutMs / 1_000)}s`,
      ));
    }

    const args: PtcToolCallArgs = {
      command,
      cwd: this.cwd,
      env,
      inheritEnv: options?.inheritEnv ?? true,
      timeoutMs,
      window: clampWindow(options?.window),
    };
    const handle = this.session.client.startToolCall(
      this.session.sessionId,
      { tool: "bash", callId: this.callId, args },
      {
        deadlineMs: Math.min(RPC_MAX_DEADLINE_MS, timeoutMs + RPC_DEADLINE_SLACK_MS),
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        onToolOutput: (event) => {
          options?.onOutput?.(event.text, context, {
            stream: event.stream,
            ...(event.skipped === undefined ? {} : { skipped: event.skipped }),
          });
        },
      },
    );
    try {
      const result = await handle.result;
      this.#lastSpillTruncated = result.spillTruncated;
      if (result.outputRef !== undefined) {
        try {
          await this.onOutputRef(result.outputRef, context);
        } catch (error) {
          return err(new ExecutionError(
            "callback_error",
            "The output reference could not be recorded; the command may have run",
            error instanceof Error ? error : undefined,
          ));
        }
        this.#lastOutputRef = result.outputRef;
      }
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      return err(mapExecutionError(error));
    }
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    if (path.includes("\0")) return err(new FileError("invalid", "Path contains NUL", path));
    if (path === "~" || path.startsWith("~/")) {
      return err(new FileError("invalid", "Remote home expansion is unavailable; use an absolute path", path));
    }
    return ok(posix.normalize(path.startsWith("/") ? path : posix.resolve(this.cwd, path)));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    if (parts.some((part) => part.includes("\0"))) {
      return err(new FileError("invalid", "Path contains NUL"));
    }
    return ok(posix.join(...parts));
  }

  private unsupported<T>(path?: string): Result<T, FileError> {
    return err(new FileError("not_supported", FILE_TOOLS_UNAVAILABLE, path));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#files.readTextFile(path, context);
  }

  async openTextLineReader(path: string, _context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.unsupported(path);
  }

  async readTextLines(path: string, _options: { maxLines?: number } | undefined, _context: Context): Promise<Result<string[], FileError>> {
    return this.unsupported(path);
  }

  async readBinaryFile(path: string, _context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.unsupported(path);
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.#files.openBinaryReader(path, options, context);
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#files.writeFile(path, content, context);
  }

  async appendFile(path: string, _content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async truncateFile(path: string, _size: number, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async flushFile(path: string, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async renameFile(sourcePath: string, _destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(sourcePath);
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#files.fileInfo(path, context);
  }

  async listDir(path: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.unsupported(path);
  }

  async listFiles(path: string, _options: ListFilesOptions | undefined, _context: Context): Promise<Result<FileListing, FileError>> {
    return this.unsupported(path);
  }

  async openDirReader(path: string, _context: Context): Promise<Result<DirReader, FileError>> {
    return this.unsupported(path);
  }

  async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
    return this.unsupported();
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#files.canonicalPath(path, context);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.#files.exists(path, context);
  }

  async createDir(path: string, _options: { recursive?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async remove(path: string, _options: { recursive?: boolean; force?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported();
  }

  async createTempFile(_options: { prefix?: string; suffix?: string } | undefined, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported();
  }

  /**
   * One session is shared by every nested call in the code mode run; closing it here would abort the
   * caller's other work. Cancellation belongs to the VM and the session lifecycle.
   */
  async cleanup(_context: Context): Promise<void> {
    return;
  }
}

function mapExecutionError(error: unknown): ExecutionError {
  if (!(error instanceof RpcClientError)) return new ExecutionError("unknown", "Remote PTC execution failed");
  switch (error.code) {
    case "aborted":
      return new ExecutionError("aborted", "Command aborted", error);
    case "timeout":
      return new ExecutionError("timeout", "Command timed out", error);
    case "busy":
      return new ExecutionError("unknown", "Execution agent is busy; retry the command", error);
    case "not_found":
      return new ExecutionError("unknown", "The PTC session is no longer active", error);
    case "invalid_request":
    case "too_large":
      return new ExecutionError("unknown", `Execution agent rejected the request: ${error.message}`, error);
    case "unavailable":
      return new ExecutionError(
        "unknown",
        "Execution agent is unavailable; the command outcome is unknown",
        error,
      );
    case "unsupported_version":
    case "not_implemented":
      return new ExecutionError("unknown", "Execution agent does not support PTC tool calls", error);
    default:
      return new ExecutionError("unknown", `${error.message}; the command outcome is unknown`, error);
  }
}
