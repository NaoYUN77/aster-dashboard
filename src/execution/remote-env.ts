import { randomUUID } from "node:crypto";
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
import { BrokerClientError, type BrokerClient } from "./broker-client.js";
import {
  validateCommand,
  validateCwd,
  validateEnv,
  validateTimeoutSeconds,
  type ExecRequest,
} from "./protocol.js";

const FILE_TOOLS_UNAVAILABLE =
  "Remote execution phase 1 runs commands only; file tools are unavailable until remote file operations land. Use bash on the execution host.";

export type RemoteExecutionEnvOptions = {
  readonly client: BrokerClient;
  readonly executionId: string;
  readonly cwd: string;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
};

/**
 * `ExecutionEnv` whose shell half runs on the execution host through the host-side broker. The
 * filesystem half is deliberately fail-closed: pretending to read or write the control plane's
 * filesystem while commands run elsewhere would give the model two different views of one path.
 */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly client: BrokerClient;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;

  constructor(options: RemoteExecutionEnvOptions) {
    this.client = options.client;
    this.id = `execution:${options.executionId}`;
    this.cwd = options.cwd;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds;
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
    // pi-durable passes seconds as any finite number; the wire contract uses whole seconds, so a
    // sub-second request rounds up rather than silently becoming zero.
    const seconds = options?.timeout === undefined ? this.defaultTimeoutSeconds : Math.ceil(options.timeout);
    if (seconds > this.maxTimeoutSeconds) {
      return err(new ExecutionError(
        "timeout",
        `Timeout ${seconds}s exceeds EXECUTION_MAX_TIMEOUT_SECONDS=${this.maxTimeoutSeconds}`,
      ));
    }
    const timeoutError = validateTimeoutSeconds(seconds);
    if (timeoutError !== undefined) return err(new ExecutionError("timeout", `Invalid timeout: ${timeoutError}`));
    const request: ExecRequest = {
      v: 1,
      type: "exec",
      id: randomUUID(),
      command,
      cwd,
      env,
      inheritEnv: options?.inheritEnv ?? true,
      timeoutSeconds: seconds,
      ...(options?.window === undefined ? {} : { window: options.window }),
    };
    try {
      const onOutput = options?.onOutput;
      const exit = await this.client.exec(request, {
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        ...(onOutput === undefined ? {} : {
          onOutput: (frame) => onOutput(frame.text, context, {
            stream: frame.stream,
            ...(frame.skipped === undefined ? {} : { skipped: frame.skipped }),
          }),
        }),
      });
      return ok({ exitCode: exit.exitCode });
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

  async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported(path);
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

  async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, _context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.unsupported(path);
  }

  async writeFile(path: string, _content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
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

  async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    return this.unsupported(path);
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

  async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported(path);
  }

  async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
    return this.unsupported(path);
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

  async cleanup(_context: Context): Promise<void> {
    this.client.abortAll();
  }
}

function mapExecutionError(error: unknown): ExecutionError {
  if (!(error instanceof BrokerClientError)) return new ExecutionError("unknown", "Remote execution failed");
  switch (error.code) {
    case "aborted":
      return new ExecutionError("aborted", "Command aborted", error);
    case "timeout":
      return new ExecutionError("timeout", "Command timed out", error);
    case "spawn_error":
      return new ExecutionError("spawn_error", error.message, error);
    case "busy":
      return new ExecutionError("unknown", "Execution broker is busy; retry the command", error);
    case "invalid_request":
      return new ExecutionError("unknown", `Execution broker rejected the request: ${error.message}`, error);
    case "unavailable":
      return new ExecutionError("unknown", "Execution broker is unavailable", error);
    default:
      return new ExecutionError("unknown", error.message, error);
  }
}
