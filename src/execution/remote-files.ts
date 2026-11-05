// pi-durable `FileSystem` over the RPC file primitives.
//
// Interface: one instance per remote environment (`PtcExecutionEnv` or `RemoteRpcExecutionEnv`).
// Every method that pi-durable's built-in `read`, `write` and `edit` tools need is implemented over
// `file.*` requests; everything that would need a directory listing, a watcher or a rename stays
// `not_supported`, so the model never sees a half-implemented namespace.
//
// Inputs: a session-scoped request callback (the host chooses the session and transport), a virtual
// cwd, and paths from the tool layer. Paths are absolute virtual paths; the execution host confines
// them to its roots.
//
// Errors: RPC failures become `FileError`s with a matching code. A write whose outcome is unknown
// stays `unknown`; nothing is reported as a clean failure after it may have landed.

import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  FileError,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type FileListing,
  type FileWatcher,
  type LineScan,
  type ListFilesOptions,
  type Result,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { RpcClientError } from "./rpc-client.js";
import {
  FILE_MAX_READ_CHUNK_BYTES,
  FILE_MAX_WRITE_BYTES,
  type RpcFileMethod,
} from "./rpc-protocol.js";

export type RemoteFileRequest = (
  method: RpcFileMethod,
  payload: Record<string, unknown>,
  options?: { readonly signal?: AbortSignal },
) => Promise<unknown>;

const FILE_TOOLS_UNAVAILABLE =
  "The remote environment supports reading, writing and editing files under /workspace, /shared and /tmp only";

/** Map one transport failure onto pi-durable's file error vocabulary. */
export function toFileError(error: unknown, path?: string): FileError {
  if (!(error instanceof RpcClientError)) {
    return new FileError("unknown", "the remote file operation failed", path);
  }
  const message = error.message;
  // A request whose outcome the agent could not confirm (a write that may have reached its rename)
  // must never be reported as a clean failure.
  if (error.options.outcome === "unknown") {
    return new FileError("unknown", `${message}; the outcome is unknown`, path, error);
  }
  switch (error.code) {
    case "aborted":
      return new FileError("aborted", message, path, error);
    case "not_found":
      return new FileError("not_found", message, path, error);
    case "permission_denied":
      return new FileError("permission_denied", message, path, error);
    case "not_directory":
      return new FileError("not_directory", message, path, error);
    case "is_directory":
      return new FileError("is_directory", message, path, error);
    case "invalid_request":
    case "too_large":
      return new FileError("invalid", message, path, error);
    case "not_implemented":
    case "unsupported_version":
      return new FileError("not_supported", message, path, error);
    default:
      return new FileError("unknown", message, path, error);
  }
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("the execution agent returned no data");
  return Buffer.from(value, "base64");
}

/**
 * The file half of a remote environment. `cwd` is mutable because pi-durable updates it after a
 * successful `cd` inside bash; no other state is shared between tools.
 */
export class RemoteFileSystem {
  readonly id: string;
  cwd: string;
  readonly #request: RemoteFileRequest;

  constructor(options: { readonly namespace: string; readonly cwd: string; readonly request: RemoteFileRequest }) {
    this.id = options.namespace;
    this.cwd = options.cwd;
    this.#request = options.request;
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    if (path.includes("\0")) return err(new FileError("invalid", "Path contains NUL", path));
    if (path === "~" || path.startsWith("~/")) {
      return err(new FileError("invalid", "Remote home expansion is unavailable; use an absolute path", path));
    }
    if (path.length === 0) return err(new FileError("invalid", "Path is empty", path));
    return ok(posix.normalize(path.startsWith("/") ? path : posix.resolve(this.cwd, path)));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    if (parts.some((part) => part.includes("\0"))) {
      return err(new FileError("invalid", "Path contains NUL"));
    }
    return ok(posix.join(...parts));
  }

  async fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    try {
      const result = await this.#request("file.stat", { path }) as { info: FileInfo };
      return ok(result.info);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
    try {
      const result = await this.#request("file.exists", { path }) as { exists: boolean };
      return ok(result.exists);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
    try {
      const result = await this.#request("file.canonical", { path }) as { path: string };
      return ok(result.path);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
    try {
      const result = await this.#request("file.readText", { path }) as { data: string };
      return ok(decodeBase64(result.data).toString("utf8"));
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (buffer.length > FILE_MAX_WRITE_BYTES) {
      return err(new FileError("invalid", `Content exceeds ${FILE_MAX_WRITE_BYTES} bytes`, path));
    }
    try {
      await this.#request("file.write", { path, content: buffer.toString("base64") }, {
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    let handle: string;
    let info: FileInfo;
    try {
      const opened = await this.#request("file.open", {
        path,
        ...(options?.noFollow === true ? { noFollow: true } : {}),
      }) as { handle: string; info: FileInfo };
      handle = opened.handle;
      info = opened.info;
    } catch (error) {
      return err(toFileError(error, path));
    }
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // A handle that the host already dropped is not an error for the reader's owner.
      await this.#request("file.close", { handle }).catch(() => undefined);
    };
    const reader: BinaryReader = {
      info: async () => ok(info),
      read: async (offset, length, readContext) => {
        if (closed) return err(new FileError("invalid", "The file is closed", path));
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
          return err(new FileError("invalid", "The read range is invalid", path));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          while (total < length) {
            const want = Math.min(length - total, FILE_MAX_READ_CHUNK_BYTES);
            const result = await this.#request("file.read", {
              handle,
              offset: offset + total,
              length: want,
            }, {
              ...(readContext.abortSignal === undefined ? {} : { signal: readContext.abortSignal }),
            }) as { data: string; bytesRead: number; nextOffset: number; eof: boolean };
            const chunk = decodeBase64(result.data);
            if (chunk.length !== result.bytesRead || result.nextOffset !== offset + total + chunk.length) {
              throw new RpcClientError("protocol_error", "file.read returned an inconsistent range", { outcome: "failed" });
            }
            if (chunk.length > 0) {
              chunks.push(chunk);
              total += chunk.length;
            }
            if (result.eof || result.bytesRead < want) break;
          }
          return ok(new Uint8Array(Buffer.concat(chunks, total)));
        } catch (error) {
          return err(toFileError(error, path));
        }
      },
      scanLines: async (scanOptions, scanContext) => {
        if (closed) return err(new FileError("invalid", "The file is closed", path));
        try {
          const result = await this.#request("file.scanLines", {
            handle,
            startLine: scanOptions.startLine,
            ...(scanOptions.endLine === undefined ? {} : { endLine: scanOptions.endLine }),
          }, {
            ...(scanContext.abortSignal === undefined ? {} : { signal: scanContext.abortSignal }),
          }) as { scan: LineScan };
          return ok(result.scan);
        } catch (error) {
          return err(toFileError(error, path));
        }
      },
      close: async () => { await close(); },
    };
    return ok(reader);
  }

  private unsupported<T>(path?: string): Result<T, FileError> {
    return err(new FileError("not_supported", FILE_TOOLS_UNAVAILABLE, path));
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

  async listDir(path: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.unsupported(path);
  }

  async listFiles(path: string, _options: ListFilesOptions | undefined, _context: Context): Promise<Result<FileListing, FileError>> {
    return this.unsupported(path);
  }

  async openDirReader(path: string, _context: Context): Promise<Result<DirReader, FileError>> {
    return this.unsupported(path);
  }

  async watch(
    _targets: readonly WatchTarget[],
    _onChange: (change: WatchChange) => void,
    _context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.unsupported();
  }

  async createDir(path: string, _options: { recursive?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async remove(
    path: string,
    _options: { recursive?: boolean; force?: boolean } | undefined,
    _context: Context,
  ): Promise<Result<void, FileError>> {
    return this.unsupported(path);
  }

  async createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported();
  }

  async createTempFile(_options: { prefix?: string; suffix?: string } | undefined, _context: Context): Promise<Result<string, FileError>> {
    return this.unsupported();
  }

  /** Handles belong to the session; the host closes them with the session, not with one tool call. */
  async cleanup(_context: Context): Promise<void> {
    return;
  }
}
