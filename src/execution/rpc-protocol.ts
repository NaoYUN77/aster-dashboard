/**
 * Unified wire contract for the resident execution agent. Frames are length-prefixed JSON: a
 * 4-byte big-endian payload length followed by UTF-8 JSON. The protocol is deliberately small and
 * strict; the transport may be a Unix socket for local tests or TCP/TLS with mutual certificates
 * across VPS hosts. Phase 0 exposes the restricted test executor; Phase 1 adds the remote PTC
 * sandbox (`vm.start`/`vm.reply` requests and `vm.message`/`tool.output` events). Phase 2 adds
 * direct `bash` execution (`execute` with `executor: "bash"`) and the bounded `file.*` primitives
 * both direct sessions and PTC nested calls use.
 */

import { validateCommand, validateEnv } from "./protocol.js";

export const RPC_PROTOCOL_VERSION = 1;
export const RPC_HEADER_BYTES = 4;
export const RPC_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const RPC_MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const RPC_MIN_DEADLINE_MS = 1;
export const RPC_MAX_DEADLINE_MS = 3_600_000;
export const RPC_MAX_ID_BYTES = 64;
export const RPC_MAX_JOB_ID_BYTES = 128;
export const RPC_MAX_REASON_BYTES = 512;
/** The only cwd the Phase 1 sandbox exposes. A model-supplied path never reaches the agent. */
export const PTC_WORKSPACE_PATH = "/workspace";
export const PTC_MAX_TOOL_TIMEOUT_MS = 86_400_000;
export const PTC_MAX_VM_MESSAGES = 4_096;
export const PTC_MAX_VM_CODE_BYTES = 1024 * 1024;
export const PTC_MAX_VM_TOOLS = 512;
export const PTC_MAX_VM_GLOBALS = 256;
export const PTC_MAX_VM_STORE_ENTRIES = 1_024;
export const PTC_MAX_INTERRUPT_BUDGET = 1_000_000_000;
export const PTC_MAX_WINDOW_BYTES = 16 * 1024 * 1024;
export const PTC_MAX_WINDOW_LINES = 1_000_000;
/** A single VM reply's payload must leave room for frame envelope fields inside one frame. */
export const PTC_MAX_REPLY_PAYLOAD_BYTES = RPC_MAX_FRAME_BYTES - 64 * 1024;

/** Direct execution bounds. They are wire bounds; the agent clamps them to its own configuration. */
export const RPC_MAX_EXECUTE_TIMEOUT_MS = RPC_MAX_DEADLINE_MS - 60_000;
export const FILE_MAX_PATH_BYTES = 4_096;
export const FILE_MAX_WRITE_BYTES = 2 * 1024 * 1024;
export const FILE_MAX_READ_TEXT_BYTES = 2 * 1024 * 1024;
export const FILE_MAX_READ_CHUNK_BYTES = 256 * 1024;
export const FILE_MAX_SCAN_LINES = 10_000_000;
export const FILE_MAX_HANDLES = 64;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_HANDLE_PATTERN = /^f[a-f0-9]{16}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type RpcMethod =
  | "health.check"
  | "preflight"
  | "session.open"
  | "session.close"
  | "execute"
  | "tool.call"
  | "cancel"
  | "vm.start"
  | "vm.message"
  | "vm.reply"
  | "file.stat"
  | "file.exists"
  | "file.canonical"
  | "file.open"
  | "file.read"
  | "file.scanLines"
  | "file.close"
  | "file.readText"
  | "file.write";

/** The bounded file primitives. Read-only methods and `file.write` share one wire shape. */
export type RpcFileMethod =
  | "file.stat"
  | "file.exists"
  | "file.canonical"
  | "file.open"
  | "file.read"
  | "file.scanLines"
  | "file.close"
  | "file.readText"
  | "file.write";

export type RpcErrorCode =
  | "invalid_request"
  | "unsupported_version"
  | "not_found"
  | "busy"
  | "not_implemented"
  | "timeout"
  | "aborted"
  | "too_large"
  | "spawn_error"
  | "unavailable"
  | "protocol_error"
  | "test_error"
  | "workspace_missing"
  | "output_unavailable"
  | "permission_denied"
  | "is_directory"
  | "not_directory"
  | "internal";

export type RpcOutcome = "not_started" | "failed" | "unknown";

export type RpcErrorPayload = {
  readonly code: RpcErrorCode;
  readonly message: string;
  readonly outcome?: RpcOutcome;
  readonly retryable?: boolean;
};

export type RpcRequestFrame = {
  readonly v: 1;
  readonly kind: "request";
  readonly id: string;
  readonly method: RpcMethod;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly correlationId?: string;
  readonly deadlineMs: number;
  readonly payload: Record<string, unknown>;
  /**
   * Set when the frame envelope is valid but the method's payload is not. The request keeps its id
   * and is answered with this error; only envelope failures close the connection. `payload` is
   * empty in that case and the dispatcher must not touch it.
   */
  readonly payloadError?: RpcErrorPayload;
};

export type RpcResponseFrame =
  | {
      readonly v: 1;
      readonly kind: "response";
      readonly id: string;
      readonly correlationId?: string;
      readonly status: "ok";
      readonly result?: unknown;
    }
  | {
      readonly v: 1;
      readonly kind: "response";
      readonly id: string;
      readonly correlationId?: string;
      readonly status: "error";
      readonly error: RpcErrorPayload;
    };

export type RpcOutputEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "output";
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export type RpcHeartbeatEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "heartbeat";
  readonly timestamp: number;
  readonly sessionId?: string;
};

export type RpcSessionClosedEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "session.closed";
  readonly sessionId: string;
  readonly reason: string;
};

/**
 * One batch of VM messages produced by the remote `serveCodemodeRemote`. `callId` is present only
 * when the batch carries a `call`; the gateway answers that batch with a `vm.reply` request. A
 * batch without a call carries output, `started`, `idle`, or the terminal `done`/`crash`/`failure`
 * and needs no reply.
 */
export type RpcVmMessageEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "vm.message";
  readonly id: string;
  readonly sessionId: string;
  readonly callId?: number;
  readonly messages: readonly Record<string, unknown>[];
};

/** One windowed chunk of a nested bash call; `id` is the `tool.call` request id. */
export type RpcToolOutputEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "tool.output";
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly skipped?: RpcSkippedOutput;
};

export type RpcSkippedOutput = {
  readonly bytes: number;
  readonly newlines: number;
  readonly endsWithNewline: boolean;
};

export type RpcEventFrame =
  | RpcOutputEvent
  | RpcHeartbeatEvent
  | RpcSessionClosedEvent
  | RpcVmMessageEvent
  | RpcToolOutputEvent;

export type RpcFrame = RpcRequestFrame | RpcResponseFrame | RpcEventFrame;

export type ParseResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly message: string };

/** Payload validation never fails a connection; it carries the code the request is answered with. */
type PayloadResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly code: RpcErrorCode; readonly message: string };

export class RpcProtocolError extends Error {
  override name = "RpcProtocolError";

  constructor(
    readonly code: "invalid_request" | "too_large" | "protocol_error",
    message: string,
  ) {
    super(message);
  }
}

export type RpcTestExecutePayload =
  | {
      readonly executor: "test";
      readonly operation: "echo";
      readonly text: string;
    }
  | {
      readonly executor: "test";
      readonly operation: "stream";
      readonly chunks: number;
      readonly chunkBytes: number;
      readonly delayMs?: number;
    }
  | {
      readonly executor: "test";
      readonly operation: "sleep";
      readonly ms: number;
    }
  | {
      readonly executor: "test";
      readonly operation: "fail";
      readonly code: "test_error";
    };

/**
 * A direct `bash` call. The `command`, `cwd`, environment and timeout are host-supplied through
 * pi-durable's shell contract; the model only supplies command text. The agent re-validates the
 * cwd against the session's exposed roots before spawning anything.
 */
export type RpcBashExecutePayload = {
  readonly executor: "bash";
  readonly command: string | readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: boolean;
  readonly timeoutMs: number;
  readonly window: PtcOutputWindow;
};

export type RpcExecutePayload = RpcTestExecutePayload | RpcBashExecutePayload;

export type RpcBashExecuteResult = {
  readonly exitCode: number;
  readonly durationMs: number;
};

/**
 * The tail of one nested command's combined output the caller keeps. Same shape as pi-durable's
 * `ShellOutputWindow`; the agent clamps every field to its own configured maximum.
 */
export type PtcOutputWindow = {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly minIntervalMs: number;
  readonly bytesPerSecond: number;
};

export type PtcToolCallArgs = {
  readonly command: string | readonly string[];
  readonly cwd: typeof PTC_WORKSPACE_PATH;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: boolean;
  readonly timeoutMs: number;
  readonly window: PtcOutputWindow;
};

/** A nested tool call already authorized, validated and journaled by the control plane. */
export type PtcToolCallPayload = {
  readonly tool: "bash";
  readonly callId: number;
  readonly args: PtcToolCallArgs;
};

/**
 * Content-addressed reference to the complete output of one nested call. The content lives in the
 * job workspace on the execution host; the control plane stores only this metadata.
 */
export type PtcOutputRef = {
  readonly blobId: string;
  readonly jobId: string;
  readonly sessionId: string;
  readonly callId: number;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "available" | "evicted" | "unknown";
};

export type PtcToolCallResult = {
  readonly exitCode: number;
  readonly outputRef?: PtcOutputRef;
  /** The complete output was larger than the spill limit and was not written past it. */
  readonly spillTruncated: boolean;
  readonly durationMs: number;
};

export type PtcVmToolDefinition = {
  readonly name: string;
  readonly jsName: string;
  readonly description: string;
};

export type PtcVmStartPayload = {
  readonly request: {
    readonly data: {
      readonly code: string;
      readonly tools: readonly PtcVmToolDefinition[];
      readonly globals: readonly { readonly name: string; readonly spread: boolean }[];
      readonly store: Readonly<Record<string, string>>;
      readonly memoryLimitBytes?: number;
      readonly deterministic?: { readonly startedAt: number; readonly seed: number };
    };
    readonly interruptBudget?: number;
  };
};

export type PtcVmReplyPayload = {
  readonly callId: number;
  readonly reply: Record<string, unknown> | null;
};

/** Workspace state reported by `session.open` after the agent prepared (or found) the job directory. */
export type PtcWorkspaceState = {
  readonly path: string;
  readonly created: boolean;
  readonly reused: boolean;
};

export type PtcIsolationState = {
  readonly mode: "bwrap" | "degraded-prlimit";
  readonly bwrap: boolean;
  readonly userNamespace: boolean;
  readonly cgroup: "v2" | "none";
  readonly network: "none" | "host";
};

/** File metadata as the execution host reports it; `path` is the virtual path, never a host path. */
export type RpcFileInfo = {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
};

export type RpcFileStatResult = { readonly info: RpcFileInfo };
export type RpcFileExistsResult = { readonly exists: boolean };
export type RpcFileCanonicalResult = { readonly path: string };
export type RpcFileOpenResult = { readonly handle: string; readonly info: RpcFileInfo };
export type RpcFileReadResult = {
  readonly data: string;
  readonly bytesRead: number;
  /** Offset the next read starts at; `eof` marks the end of the file. */
  readonly nextOffset: number;
  readonly eof: boolean;
};
export type RpcFileScanResult = {
  readonly scan: {
    readonly newlines: number;
    readonly start: number;
    readonly end: number;
    readonly firstLineEnd: number;
    readonly lastLineStart: number;
    readonly selectedBytes: number;
    readonly firstLineBytes: number;
  };
};
export type RpcFileReadTextResult = { readonly data: string };
export type RpcFileWriteResult = { readonly info: RpcFileInfo };

const METHODS = new Set<RpcMethod>([
  "health.check",
  "preflight",
  "session.open",
  "session.close",
  "execute",
  "tool.call",
  "cancel",
  "vm.start",
  "vm.message",
  "vm.reply",
  "file.stat",
  "file.exists",
  "file.canonical",
  "file.open",
  "file.read",
  "file.scanLines",
  "file.close",
  "file.readText",
  "file.write",
]);

const ERROR_CODES = new Set<RpcErrorCode>([
  "invalid_request",
  "unsupported_version",
  "not_found",
  "busy",
  "not_implemented",
  "timeout",
  "aborted",
  "too_large",
  "spawn_error",
  "unavailable",
  "protocol_error",
  "test_error",
  "workspace_missing",
  "output_unavailable",
  "permission_denied",
  "is_directory",
  "not_directory",
  "internal",
]);

const OUTCOMES = new Set<RpcOutcome>(["not_started", "failed", "unknown"]);

function fail<TValue>(message: string): ParseResult<TValue> {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const accepted = new Set(allowed);
  return Object.keys(value).find((key) => !accepted.has(key));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && byteLength(value) <= RPC_MAX_ID_BYTES;
}

function isSafeJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value) && byteLength(value) <= RPC_MAX_JOB_ID_BYTES;
}

function isSafeReason(value: unknown): value is string {
  return typeof value === "string" && byteLength(value) <= RPC_MAX_REASON_BYTES;
}

function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= 128;
}

function isSafeText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && byteLength(value) <= maxBytes;
}

function validateErrorPayload(value: unknown): ParseResult<RpcErrorPayload> {
  if (!isPlainObject(value)) return fail("error must be an object");
  const unknown = unexpectedKey(value, ["code", "message", "outcome", "retryable"]);
  if (unknown !== undefined) return fail(`unknown error field: ${unknown}`);
  if (typeof value.code !== "string" || !ERROR_CODES.has(value.code as RpcErrorCode)) {
    return fail("error.code is invalid");
  }
  if (!isSafeText(value.message, 4096)) return fail("error.message is invalid");
  if (Object.hasOwn(value, "outcome")
    && (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome as RpcOutcome))) {
    return fail("error.outcome is invalid");
  }
  if (Object.hasOwn(value, "retryable") && typeof value.retryable !== "boolean") {
    return fail("error.retryable must be a boolean");
  }
  return {
    ok: true,
    value: {
      code: value.code as RpcErrorCode,
      message: value.message,
      ...(Object.hasOwn(value, "outcome") ? { outcome: value.outcome as RpcOutcome } : {}),
      ...(Object.hasOwn(value, "retryable") ? { retryable: value.retryable as boolean } : {}),
    },
  };
}

export function parseTestExecutePayload(value: unknown): ParseResult<RpcTestExecutePayload> {
  if (!isPlainObject(value)) return fail("execute payload must be an object");
  if (value.executor !== "test") return fail("Phase 0 only implements the test executor");
  switch (value.operation) {
    case "echo": {
      const unknown = unexpectedKey(value, ["executor", "operation", "text"]);
      if (unknown !== undefined) return fail(`unknown echo field: ${unknown}`);
      if (!isSafeText(value.text, 4096)) return fail("text must be a string of at most 4096 bytes");
      return { ok: true, value: { executor: "test", operation: "echo", text: value.text } };
    }
    case "stream": {
      const unknown = unexpectedKey(value, ["executor", "operation", "chunks", "chunkBytes", "delayMs"]);
      if (unknown !== undefined) return fail(`unknown stream field: ${unknown}`);
      if (!Number.isSafeInteger(value.chunks) || (value.chunks as number) < 1 || (value.chunks as number) > 100) {
        return fail("chunks must be an integer in 1..100");
      }
      if (!Number.isSafeInteger(value.chunkBytes) || (value.chunkBytes as number) < 1
        || (value.chunkBytes as number) > 16 * 1024) {
        return fail("chunkBytes must be an integer in 1..16384");
      }
      if (Object.hasOwn(value, "delayMs")
        && (!Number.isSafeInteger(value.delayMs) || (value.delayMs as number) < 0 || (value.delayMs as number) > 1000)) {
        return fail("delayMs must be an integer in 0..1000");
      }
      return {
        ok: true,
        value: {
          executor: "test",
          operation: "stream",
          chunks: value.chunks as number,
          chunkBytes: value.chunkBytes as number,
          ...(Object.hasOwn(value, "delayMs") ? { delayMs: value.delayMs as number } : {}),
        },
      };
    }
    case "sleep": {
      const unknown = unexpectedKey(value, ["executor", "operation", "ms"]);
      if (unknown !== undefined) return fail(`unknown sleep field: ${unknown}`);
      if (!Number.isSafeInteger(value.ms) || (value.ms as number) < 1 || (value.ms as number) > 60_000) {
        return fail("ms must be an integer in 1..60000");
      }
      return { ok: true, value: { executor: "test", operation: "sleep", ms: value.ms as number } };
    }
    case "fail": {
      const unknown = unexpectedKey(value, ["executor", "operation", "code"]);
      if (unknown !== undefined) return fail(`unknown fail field: ${unknown}`);
      if (value.code !== "test_error") return fail("code must be test_error");
      return { ok: true, value: { executor: "test", operation: "fail", code: "test_error" } };
    }
    default:
      return fail("unknown test operation");
  }
}

function isPositiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
}

function isNonNegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

/**
 * A virtual path is absolute and POSIX-shaped. `..` is not a syntax error but an authorization
 * failure: the service normalizes the path and only exposed roots survive, so the caller sees
 * `permission_denied` rather than a dropped connection. Every failure here becomes a per-request
 * error response; only the frame envelope can close the connection.
 */
function virtualPathIssue(value: unknown): { readonly code: RpcErrorCode; readonly message: string } | undefined {
  if (typeof value !== "string" || value.length === 0) return { code: "invalid_request", message: "path is invalid" };
  if (byteLength(value) > FILE_MAX_PATH_BYTES) return { code: "invalid_request", message: "path is too long" };
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\")) {
    return { code: "invalid_request", message: "path is invalid" };
  }
  if (value.split("/").some((segment) => segment === "..")) {
    return { code: "permission_denied", message: "the path leaves its root" };
  }
  return undefined;
}

/**
 * A working directory is stricter than a file path: it must already be normalized, because the
 * executor compares it against a fixed root rather than resolving it. A `..` segment is therefore
 * a malformed request, not a path that would merely be refused.
 */
function isVirtualPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && virtualPathIssue(value) === undefined;
}

function isFileHandle(value: unknown): value is string {
  return typeof value === "string" && FILE_HANDLE_PATTERN.test(value);
}

function isBase64(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length > Math.ceil(maxBytes / 3) * 4) return false;
  return BASE64_PATTERN.test(value);
}

/** Parse and bound a direct `bash` request; the agent still authorizes the cwd and environment. */
export function parseBashExecutePayload(value: unknown): ParseResult<RpcBashExecutePayload> {
  if (!isPlainObject(value)) return fail("execute payload must be an object");
  const unknown = unexpectedKey(value, ["executor", "command", "cwd", "env", "inheritEnv", "timeoutMs", "window"]);
  if (unknown !== undefined) return fail(`unknown bash execute field: ${unknown}`);
  const commandError = validateCommand(value.command);
  if (commandError !== undefined) return fail(commandError);
  if (!isVirtualPath(value.cwd)) return fail("cwd is invalid");
  const envError = validateEnv(value.env);
  if (envError !== undefined) return fail(envError);
  if (typeof value.inheritEnv !== "boolean") return fail("inheritEnv must be a boolean");
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1
    || (value.timeoutMs as number) > RPC_MAX_EXECUTE_TIMEOUT_MS) {
    return fail(`timeoutMs must be an integer in 1..${RPC_MAX_EXECUTE_TIMEOUT_MS}`);
  }
  const window = parsePtcOutputWindow(value.window);
  if (!window.ok) return fail(window.message);
  return {
    ok: true,
    value: {
      executor: "bash",
      command: value.command as string | readonly string[],
      cwd: value.cwd,
      env: value.env as Record<string, string>,
      inheritEnv: value.inheritEnv,
      timeoutMs: value.timeoutMs as number,
      window: window.value,
    },
  };
}

function validateFilePayload(method: RpcFileMethod, value: unknown): PayloadResult {
  const invalid = (message: string): PayloadResult => ({ ok: false, code: "invalid_request", message });
  if (!isPlainObject(value)) return invalid(`${method} payload must be an object`);
  switch (method) {
    case "file.stat":
    case "file.open": {
      const unknown = unexpectedKey(value, ["path", "noFollow"]);
      if (unknown !== undefined) return invalid(`unknown ${method} field: ${unknown}`);
      const issue = virtualPathIssue(value.path);
      if (issue !== undefined) return { ok: false, ...issue };
      if (Object.hasOwn(value, "noFollow") && typeof value.noFollow !== "boolean") {
        return invalid("noFollow must be a boolean");
      }
      return { ok: true, value };
    }
    case "file.exists":
    case "file.canonical":
    case "file.readText": {
      const unknown = unexpectedKey(value, ["path"]);
      if (unknown !== undefined) return invalid(`unknown ${method} field: ${unknown}`);
      const issue = virtualPathIssue(value.path);
      if (issue !== undefined) return { ok: false, ...issue };
      return { ok: true, value };
    }
    case "file.read": {
      const unknown = unexpectedKey(value, ["handle", "offset", "length"]);
      if (unknown !== undefined) return invalid(`unknown file.read field: ${unknown}`);
      if (!isFileHandle(value.handle)) return invalid("handle is invalid");
      if (!isNonNegativeInteger(value.offset)) return invalid("offset is invalid");
      if (!isPositiveInteger(value.length, FILE_MAX_READ_CHUNK_BYTES)) {
        return invalid(`length must be an integer in 1..${FILE_MAX_READ_CHUNK_BYTES}`);
      }
      return { ok: true, value };
    }
    case "file.scanLines": {
      const unknown = unexpectedKey(value, ["handle", "startLine", "endLine"]);
      if (unknown !== undefined) return invalid(`unknown file.scanLines field: ${unknown}`);
      if (!isFileHandle(value.handle)) return invalid("handle is invalid");
      if (!isNonNegativeInteger(value.startLine, FILE_MAX_SCAN_LINES)) return invalid("startLine is invalid");
      if (Object.hasOwn(value, "endLine")) {
        if (!isNonNegativeInteger(value.endLine, FILE_MAX_SCAN_LINES)
          || (value.endLine as number) <= (value.startLine as number)) {
          return invalid("endLine must be an integer greater than startLine");
        }
      }
      return { ok: true, value };
    }
    case "file.close": {
      const unknown = unexpectedKey(value, ["handle"]);
      if (unknown !== undefined) return invalid(`unknown file.close field: ${unknown}`);
      if (!isFileHandle(value.handle)) return invalid("handle is invalid");
      return { ok: true, value };
    }
    case "file.write": {
      const unknown = unexpectedKey(value, ["path", "content"]);
      if (unknown !== undefined) return invalid(`unknown file.write field: ${unknown}`);
      const issue = virtualPathIssue(value.path);
      if (issue !== undefined) return { ok: false, ...issue };
      if (!isBase64(value.content, FILE_MAX_WRITE_BYTES)) {
        return invalid(`content must be base64 of at most ${FILE_MAX_WRITE_BYTES} bytes`);
      }
      return { ok: true, value };
    }
    default:
      return invalid("unknown file method");
  }
}

export const FILE_METHODS = new Set<RpcFileMethod>([
  "file.stat",
  "file.exists",
  "file.canonical",
  "file.open",
  "file.read",
  "file.scanLines",
  "file.close",
  "file.readText",
  "file.write",
]);

export function isRpcFileMethod(value: unknown): value is RpcFileMethod {
  return typeof value === "string" && FILE_METHODS.has(value as RpcFileMethod);
}

/** Validate a file request exactly once at each boundary: the RPC server and the runner both call it. */
export function parseFileRequestPayload(method: RpcFileMethod, value: unknown): ParseResult<Record<string, unknown>> {
  return validateFilePayload(method, value);
}

/** Validate a file result according to the method that produced it. */
export function parseFileResult(method: RpcFileMethod, value: unknown): ParseResult<unknown> {
  switch (method) {
    case "file.stat":
    case "file.write":
      return parseFileStatResult(value);
    case "file.exists":
      return parseFileExistsResult(value);
    case "file.canonical":
      return parseFileCanonicalResult(value);
    case "file.open":
      return parseFileOpenResult(value);
    case "file.read":
      return parseFileReadResult(value);
    case "file.scanLines":
      return parseFileScanResult(value);
    case "file.readText":
      return parseFileReadTextResult(value);
    case "file.close": {
      if (!isPlainObject(value)) return fail("file result must be an object");
      const unknown = unexpectedKey(value, []);
      return unknown === undefined ? { ok: true, value: {} } : fail(`unknown file result field: ${unknown}`);
    }
  }
}

export function parseRpcFileInfo(value: unknown): ParseResult<RpcFileInfo> {
  if (!isPlainObject(value)) return fail("file info must be an object");
  const unknown = unexpectedKey(value, ["name", "path", "kind", "size", "mtimeMs"]);
  if (unknown !== undefined) return fail(`unknown file info field: ${unknown}`);
  if (typeof value.name !== "string" || value.name.length === 0 || byteLength(value.name) > 255) {
    return fail("file info.name is invalid");
  }
  if (!isVirtualPath(value.path)) return fail("file info.path is invalid");
  if (value.kind !== "file" && value.kind !== "directory" && value.kind !== "symlink") {
    return fail("file info.kind is invalid");
  }
  if (!isNonNegativeInteger(value.size)) return fail("file info.size is invalid");
  if (typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs) || value.mtimeMs < 0) {
    return fail("file info.mtimeMs is invalid");
  }
  return {
    ok: true,
    value: {
      name: value.name,
      path: value.path,
      kind: value.kind,
      size: value.size as number,
      mtimeMs: value.mtimeMs,
    },
  };
}

function parseFileInfoResult(value: unknown): ParseResult<RpcFileStatResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["info"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  const info = parseRpcFileInfo(value.info);
  if (!info.ok) return fail(info.message);
  return { ok: true, value: { info: info.value } };
}

export function parseFileStatResult(value: unknown): ParseResult<RpcFileStatResult> {
  return parseFileInfoResult(value);
}

export function parseFileExistsResult(value: unknown): ParseResult<RpcFileExistsResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["exists"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  if (typeof value.exists !== "boolean") return fail("exists must be a boolean");
  return { ok: true, value: { exists: value.exists } };
}

export function parseFileCanonicalResult(value: unknown): ParseResult<RpcFileCanonicalResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["path"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  if (!isVirtualPath(value.path)) return fail("path is invalid");
  return { ok: true, value: { path: value.path } };
}

export function parseFileOpenResult(value: unknown): ParseResult<RpcFileOpenResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["handle", "info"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  if (!isFileHandle(value.handle)) return fail("handle is invalid");
  const info = parseRpcFileInfo(value.info);
  if (!info.ok) return fail(info.message);
  return { ok: true, value: { handle: value.handle, info: info.value } };
}

export function parseFileReadResult(value: unknown): ParseResult<RpcFileReadResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["data", "bytesRead", "nextOffset", "eof"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  if (!isBase64(value.data, FILE_MAX_READ_CHUNK_BYTES)) return fail("data is invalid");
  if (!isNonNegativeInteger(value.bytesRead, FILE_MAX_READ_CHUNK_BYTES)) return fail("bytesRead is invalid");
  if (!isNonNegativeInteger(value.nextOffset)) return fail("nextOffset is invalid");
  if ((value.nextOffset as number) < (value.bytesRead as number)) return fail("nextOffset is inconsistent");
  if (typeof value.eof !== "boolean") return fail("eof must be a boolean");
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.length !== value.bytesRead) {
    return fail("data does not match bytesRead");
  }
  return {
    ok: true,
    value: {
      data: value.data,
      bytesRead: value.bytesRead as number,
      nextOffset: value.nextOffset as number,
      eof: value.eof,
    },
  };
}

export function parseFileScanResult(value: unknown): ParseResult<RpcFileScanResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["scan"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  if (!isPlainObject(value.scan)) return fail("scan must be an object");
  const scan = value.scan;
  const unknownScan = unexpectedKey(scan, [
    "newlines", "start", "end", "firstLineEnd", "lastLineStart", "selectedBytes", "firstLineBytes",
  ]);
  if (unknownScan !== undefined) return fail(`unknown scan field: ${unknownScan}`);
  for (const field of ["newlines", "start", "end", "firstLineEnd", "lastLineStart", "selectedBytes", "firstLineBytes"]) {
    if (!isNonNegativeInteger(scan[field])) return fail(`scan.${field} is invalid`);
  }
  if ((scan.start as number) > (scan.end as number)) return fail("scan range is invalid");
  return {
    ok: true,
    value: {
      scan: {
        newlines: scan.newlines as number,
        start: scan.start as number,
        end: scan.end as number,
        firstLineEnd: scan.firstLineEnd as number,
        lastLineStart: scan.lastLineStart as number,
        selectedBytes: scan.selectedBytes as number,
        firstLineBytes: scan.firstLineBytes as number,
      },
    },
  };
}

export function parseFileReadTextResult(value: unknown): ParseResult<RpcFileReadTextResult> {
  if (!isPlainObject(value)) return fail("file result must be an object");
  const unknown = unexpectedKey(value, ["data"]);
  if (unknown !== undefined) return fail(`unknown file result field: ${unknown}`);
  if (!isBase64(value.data, FILE_MAX_READ_TEXT_BYTES)) return fail("data is invalid");
  return { ok: true, value: { data: value.data } };
}

export function parseFileWriteResult(value: unknown): ParseResult<RpcFileWriteResult> {
  return parseFileInfoResult(value);
}

export function parseBashExecuteResult(value: unknown): ParseResult<RpcBashExecuteResult> {
  if (!isPlainObject(value)) return fail("execute result must be an object");
  const unknown = unexpectedKey(value, ["exitCode", "durationMs"]);
  if (unknown !== undefined) return fail(`unknown execute result field: ${unknown}`);
  if (!isNonNegativeInteger(value.exitCode, 255)) return fail("exitCode must be an integer in 0..255");
  if (!isNonNegativeInteger(value.durationMs)) return fail("durationMs is invalid");
  return { ok: true, value: { exitCode: value.exitCode as number, durationMs: value.durationMs as number } };
}

function parsePtcOutputWindow(value: unknown): ParseResult<PtcOutputWindow> {
  if (!isPlainObject(value)) return fail("args.window must be an object");
  const unknown = unexpectedKey(value, ["maxBytes", "maxLines", "minIntervalMs", "bytesPerSecond"]);
  if (unknown !== undefined) return fail(`unknown args.window field: ${unknown}`);
  const { maxBytes, maxLines, minIntervalMs, bytesPerSecond } = value;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > PTC_MAX_WINDOW_BYTES) {
    return fail(`args.window.maxBytes must be an integer in 1..${PTC_MAX_WINDOW_BYTES}`);
  }
  if (!Number.isSafeInteger(maxLines) || (maxLines as number) < 1 || (maxLines as number) > PTC_MAX_WINDOW_LINES) {
    return fail(`args.window.maxLines must be an integer in 1..${PTC_MAX_WINDOW_LINES}`);
  }
  if (!Number.isSafeInteger(minIntervalMs) || (minIntervalMs as number) < 0 || (minIntervalMs as number) > 60_000) {
    return fail("args.window.minIntervalMs must be an integer in 0..60000");
  }
  if (!Number.isSafeInteger(bytesPerSecond) || (bytesPerSecond as number) < 0
    || (bytesPerSecond as number) > 1_000_000_000) {
    return fail("args.window.bytesPerSecond must be an integer in 0..1000000000");
  }
  return {
    ok: true,
    value: {
      maxBytes: maxBytes as number,
      maxLines: maxLines as number,
      minIntervalMs: minIntervalMs as number,
      bytesPerSecond: bytesPerSecond as number,
    },
  };
}

/** Validate a nested `bash` call. The control plane has already authorized it; this is the agent's own gate. */
export function parsePtcToolCallPayload(value: unknown): ParseResult<PtcToolCallPayload> {
  if (!isPlainObject(value)) return fail("tool.call payload must be an object");
  const unknown = unexpectedKey(value, ["tool", "callId", "args"]);
  if (unknown !== undefined) return fail(`unknown tool.call field: ${unknown}`);
  if (value.tool !== "bash") return fail("Phase 1 only implements the bash tool");
  if (!isPositiveInteger(value.callId)) return fail("callId must be a positive integer");
  if (!isPlainObject(value.args)) return fail("args must be an object");
  const args = value.args;
  const unknownArg = unexpectedKey(args, ["command", "cwd", "env", "inheritEnv", "timeoutMs", "window"]);
  if (unknownArg !== undefined) return fail(`unknown args field: ${unknownArg}`);
  const commandError = validateCommand(args.command);
  if (commandError !== undefined) return fail(commandError);
  if (args.cwd !== PTC_WORKSPACE_PATH) return fail(`args.cwd must be ${PTC_WORKSPACE_PATH}`);
  const envError = validateEnv(args.env);
  if (envError !== undefined) return fail(envError);
  if (typeof args.inheritEnv !== "boolean") return fail("args.inheritEnv must be a boolean");
  if (!Number.isSafeInteger(args.timeoutMs) || (args.timeoutMs as number) < 1
    || (args.timeoutMs as number) > PTC_MAX_TOOL_TIMEOUT_MS) {
    return fail(`args.timeoutMs must be an integer in 1..${PTC_MAX_TOOL_TIMEOUT_MS}`);
  }
  const window = parsePtcOutputWindow(args.window);
  if (!window.ok) return fail(window.message);
  return {
    ok: true,
    value: {
      tool: "bash",
      callId: value.callId,
      args: {
        command: args.command as string | readonly string[],
        cwd: PTC_WORKSPACE_PATH,
        env: args.env as Record<string, string>,
        inheritEnv: args.inheritEnv,
        timeoutMs: args.timeoutMs as number,
        window: window.value,
      },
    },
  };
}

function isShortString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && byteLength(value) <= maxBytes;
}

/**
 * The VM start request is built by the control plane's code mode extension, but it crosses an
 * untrusted boundary like every other payload. Bounds here keep the agent from accepting an
 * unbounded or malformed VM definition; the runner still treats it as data.
 */
export function parsePtcVmStartPayload(value: unknown): ParseResult<PtcVmStartPayload> {
  if (!isPlainObject(value)) return fail("vm.start payload must be an object");
  const unknown = unexpectedKey(value, ["request"]);
  if (unknown !== undefined) return fail(`unknown vm.start field: ${unknown}`);
  if (!isPlainObject(value.request)) return fail("request must be an object");
  const request = value.request;
  const unknownRequest = unexpectedKey(request, ["data", "interruptBudget"]);
  if (unknownRequest !== undefined) return fail(`unknown request field: ${unknownRequest}`);
  if (!isPlainObject(request.data)) return fail("request.data must be an object");
  const data = request.data;
  const unknownData = unexpectedKey(data, ["code", "tools", "globals", "memoryLimitBytes", "store", "deterministic"]);
  if (unknownData !== undefined) return fail(`unknown request.data field: ${unknownData}`);
  if (!isShortString(data.code, PTC_MAX_VM_CODE_BYTES)) {
    return fail(`request.data.code must be a string of at most ${PTC_MAX_VM_CODE_BYTES} bytes`);
  }
  if (!Array.isArray(data.tools) || data.tools.length > PTC_MAX_VM_TOOLS) {
    return fail(`request.data.tools must be an array of at most ${PTC_MAX_VM_TOOLS} entries`);
  }
  for (const tool of data.tools) {
    if (!isPlainObject(tool)) return fail("request.data.tools entries must be objects");
    if (unexpectedKey(tool, ["name", "jsName", "description"]) !== undefined) {
      return fail("request.data.tools entries have unknown fields");
    }
    if (!isShortString(tool.name, 256) || !isShortString(tool.jsName, 256)
      || !isShortString(tool.description, 4096)) {
      return fail("request.data.tools entries are invalid");
    }
  }
  if (!Array.isArray(data.globals) || data.globals.length > PTC_MAX_VM_GLOBALS) {
    return fail(`request.data.globals must be an array of at most ${PTC_MAX_VM_GLOBALS} entries`);
  }
  for (const global of data.globals) {
    if (!isPlainObject(global) || unexpectedKey(global, ["name", "spread"]) !== undefined) {
      return fail("request.data.globals entries are invalid");
    }
    if (!isShortString(global.name, 256) || typeof global.spread !== "boolean") {
      return fail("request.data.globals entries are invalid");
    }
  }
  if (Object.hasOwn(data, "memoryLimitBytes")
    && (!isPositiveInteger(data.memoryLimitBytes, 512 * 1024 * 1024))) {
    return fail("request.data.memoryLimitBytes must be an integer in 1..536870912");
  }
  if (!isPlainObject(data.store)) return fail("request.data.store must be an object");
  const storeEntries = Object.entries(data.store);
  if (storeEntries.length > PTC_MAX_VM_STORE_ENTRIES) {
    return fail(`request.data.store must have at most ${PTC_MAX_VM_STORE_ENTRIES} entries`);
  }
  for (const [key, entry] of storeEntries) {
    if (byteLength(key) > 256 || !isShortString(entry, 256 * 1024)) {
      return fail("request.data.store entries are invalid");
    }
  }
  if (Object.hasOwn(data, "deterministic")) {
    const deterministic = data.deterministic;
    if (!isPlainObject(deterministic)
      || unexpectedKey(deterministic, ["startedAt", "seed"]) !== undefined
      || !Number.isSafeInteger(deterministic.startedAt) || (deterministic.startedAt as number) < 0
      || !Number.isSafeInteger(deterministic.seed)) {
      return fail("request.data.deterministic is invalid");
    }
  }
  if (Object.hasOwn(request, "interruptBudget")
    && !isPositiveInteger(request.interruptBudget, PTC_MAX_INTERRUPT_BUDGET)) {
    return fail(`request.interruptBudget must be an integer in 1..${PTC_MAX_INTERRUPT_BUDGET}`);
  }
  return {
    ok: true,
    value: {
      request: {
        data: {
          code: data.code as string,
          tools: data.tools as PtcVmToolDefinition[],
          globals: data.globals as { name: string; spread: boolean }[],
          store: data.store as Record<string, string>,
          ...(Object.hasOwn(data, "memoryLimitBytes") ? { memoryLimitBytes: data.memoryLimitBytes as number } : {}),
          ...(Object.hasOwn(data, "deterministic")
            ? { deterministic: data.deterministic as { startedAt: number; seed: number } }
            : {}),
        },
        ...(Object.hasOwn(request, "interruptBudget") ? { interruptBudget: request.interruptBudget as number } : {}),
      },
    },
  };
}

/** Validate the gateway's answer to one VM exchange. Only `stop` and `result` can come back. */
export function parsePtcVmReplyPayload(value: unknown): ParseResult<PtcVmReplyPayload> {
  if (!isPlainObject(value)) return fail("vm.reply payload must be an object");
  const unknown = unexpectedKey(value, ["callId", "reply"]);
  if (unknown !== undefined) return fail(`unknown vm.reply field: ${unknown}`);
  if (!isPositiveInteger(value.callId)) return fail("callId must be a positive integer");
  const reply = value.reply;
  if (reply === null) return { ok: true, value: { callId: value.callId, reply: null } };
  if (!isPlainObject(reply)) return fail("reply must be an object or null");
  if (reply.type === "stop") {
    const unknownStop = unexpectedKey(reply, ["type"]);
    if (unknownStop !== undefined) return fail(`unknown stop field: ${unknownStop}`);
    return { ok: true, value: { callId: value.callId, reply: { type: "stop" } } };
  }
  if (reply.type !== "result") return fail("reply.type is invalid");
  const unknownResult = unexpectedKey(reply, ["type", "id", "ok", "payload", "seq", "now", "properties"]);
  if (unknownResult !== undefined) return fail(`unknown result field: ${unknownResult}`);
  if (!isPositiveInteger(reply.id)) return fail("reply.id must be a positive integer");
  if (typeof reply.ok !== "boolean") return fail("reply.ok must be a boolean");
  if (Object.hasOwn(reply, "payload") && !isShortString(reply.payload, PTC_MAX_REPLY_PAYLOAD_BYTES)) {
    return fail("reply.payload is invalid");
  }
  if (Object.hasOwn(reply, "seq")
    && (!Number.isSafeInteger(reply.seq) || (reply.seq as number) < 0)) {
    return fail("reply.seq is invalid");
  }
  if (Object.hasOwn(reply, "now") && !Number.isSafeInteger(reply.now)) return fail("reply.now is invalid");
  if (Object.hasOwn(reply, "properties") && !isShortString(reply.properties, 16 * 1024)) {
    return fail("reply.properties is invalid");
  }
  return {
    ok: true,
    value: {
      callId: value.callId,
      reply: {
        type: "result",
        id: reply.id,
        ok: reply.ok,
        ...(Object.hasOwn(reply, "payload") ? { payload: reply.payload } : {}),
        ...(Object.hasOwn(reply, "seq") ? { seq: reply.seq } : {}),
        ...(Object.hasOwn(reply, "now") ? { now: reply.now } : {}),
        ...(Object.hasOwn(reply, "properties") ? { properties: reply.properties } : {}),
      },
    },
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OUTPUT_PATH_PREFIX = `${PTC_WORKSPACE_PATH}/.ptc/outputs/`;

export function parsePtcOutputRef(value: unknown): ParseResult<PtcOutputRef> {
  if (!isPlainObject(value)) return fail("outputRef must be an object");
  const unknown = unexpectedKey(value, [
    "blobId", "jobId", "sessionId", "callId", "path", "size", "sha256", "createdAt", "expiresAt", "state",
  ]);
  if (unknown !== undefined) return fail(`unknown outputRef field: ${unknown}`);
  if (!isShortString(value.blobId, 64) || !SHA256_PATTERN.test(value.blobId)) return fail("outputRef.blobId is invalid");
  if (!isSafeJobId(value.jobId)) return fail("outputRef.jobId is invalid");
  if (!isSafeId(value.sessionId)) return fail("outputRef.sessionId is invalid");
  if (!isPositiveInteger(value.callId)) return fail("outputRef.callId is invalid");
  if (!isShortString(value.path, 4096) || !value.path.startsWith(OUTPUT_PATH_PREFIX)
    || value.path.includes("\0") || value.path.includes("\n") || value.path.includes("\r")) {
    return fail("outputRef.path is invalid");
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) return fail("outputRef.size is invalid");
  if (!isShortString(value.sha256, 64) || !SHA256_PATTERN.test(value.sha256)) return fail("outputRef.sha256 is invalid");
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) return fail("outputRef.createdAt is invalid");
  if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0) return fail("outputRef.expiresAt is invalid");
  if (value.state !== "available" && value.state !== "evicted" && value.state !== "unknown") {
    return fail("outputRef.state is invalid");
  }
  return {
    ok: true,
    value: {
      blobId: value.blobId,
      jobId: value.jobId,
      sessionId: value.sessionId,
      callId: value.callId,
      path: value.path,
      size: value.size as number,
      sha256: value.sha256,
      createdAt: value.createdAt as number,
      expiresAt: value.expiresAt as number,
      state: value.state,
    },
  };
}

export function parsePtcToolCallResult(value: unknown): ParseResult<PtcToolCallResult> {
  if (!isPlainObject(value)) return fail("tool.call result must be an object");
  const unknown = unexpectedKey(value, ["exitCode", "outputRef", "spillTruncated", "durationMs"]);
  if (unknown !== undefined) return fail(`unknown tool.call result field: ${unknown}`);
  if (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0 || (value.exitCode as number) > 255) {
    return fail("exitCode must be an integer in 0..255");
  }
  if (typeof value.spillTruncated !== "boolean") return fail("spillTruncated must be a boolean");
  if (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0) return fail("durationMs is invalid");
  let outputRef: PtcOutputRef | undefined;
  if (Object.hasOwn(value, "outputRef")) {
    const parsed = parsePtcOutputRef(value.outputRef);
    if (!parsed.ok) return fail(parsed.message);
    outputRef = parsed.value;
  }
  return {
    ok: true,
    value: {
      exitCode: value.exitCode as number,
      spillTruncated: value.spillTruncated,
      durationMs: value.durationMs as number,
      ...(outputRef === undefined ? {} : { outputRef }),
    },
  };
}

function validateRequestPayload(method: RpcMethod, payload: unknown): PayloadResult {
  const invalid = (message: string): PayloadResult => ({ ok: false, code: "invalid_request", message });
  if (!isPlainObject(payload)) return invalid("request payload must be an object");
  switch (method) {
    case "health.check":
    case "preflight": {
      const unknown = unexpectedKey(payload, []);
      return unknown === undefined ? { ok: true, value: payload } : invalid(`unknown payload field: ${unknown}`);
    }
    case "session.open": {
      const unknown = unexpectedKey(payload, ["sessionId", "jobId", "workspaceReady"]);
      if (unknown !== undefined) return invalid(`unknown session.open field: ${unknown}`);
      if (!isSafeId(payload.sessionId)) return invalid("sessionId is invalid");
      if (Object.hasOwn(payload, "jobId") && !isSafeJobId(payload.jobId)) return invalid("jobId is invalid");
      if (Object.hasOwn(payload, "workspaceReady") && typeof payload.workspaceReady !== "boolean") {
        return invalid("workspaceReady must be a boolean");
      }
      return { ok: true, value: payload };
    }
    case "session.close": {
      const unknown = unexpectedKey(payload, ["sessionId"]);
      if (unknown !== undefined) return invalid(`unknown session.close field: ${unknown}`);
      if (!isSafeId(payload.sessionId)) return invalid("sessionId is invalid");
      return { ok: true, value: payload };
    }
    case "cancel": {
      const unknown = unexpectedKey(payload, ["targetId", "reason"]);
      if (unknown !== undefined) return invalid(`unknown cancel field: ${unknown}`);
      if (!isSafeId(payload.targetId)) return invalid("targetId is invalid");
      if (Object.hasOwn(payload, "reason") && !isSafeReason(payload.reason)) return invalid("reason is invalid");
      return { ok: true, value: payload };
    }
    case "execute": {
      if (typeof payload.executor !== "string" || payload.executor.length > 32) {
        return invalid("execute.executor must be a string of at most 32 bytes");
      }
      if (payload.executor === "test") {
        const parsed = parseTestExecutePayload(payload);
        if (!parsed.ok) return invalid(parsed.message);
      }
      if (payload.executor === "bash") {
        const parsed = parseBashExecutePayload(payload);
        if (!parsed.ok) return invalid(parsed.message);
      }
      // Other executors are parsed but rejected by the dispatcher; they are never executed.
      return { ok: true, value: payload };
    }
    case "file.stat":
    case "file.exists":
    case "file.canonical":
    case "file.open":
    case "file.read":
    case "file.scanLines":
    case "file.close":
    case "file.readText":
    case "file.write":
      return validateFilePayload(method, payload);
    case "tool.call": {
      const parsed = parsePtcToolCallPayload(payload);
      if (!parsed.ok) return invalid(parsed.message);
      return { ok: true, value: payload };
    }
    case "vm.start": {
      const parsed = parsePtcVmStartPayload(payload);
      if (!parsed.ok) return invalid(parsed.message);
      return { ok: true, value: payload };
    }
    case "vm.message": {
      const unknown = unexpectedKey(payload, ["messages"]);
      if (unknown !== undefined) return invalid(`unknown vm.message field: ${unknown}`);
      if (!Array.isArray(payload.messages) || payload.messages.length > PTC_MAX_VM_MESSAGES) {
        return invalid(`messages must be an array of at most ${PTC_MAX_VM_MESSAGES} entries`);
      }
      if (!payload.messages.every(isPlainObject)) return invalid("messages entries must be objects");
      return { ok: true, value: payload };
    }
    case "vm.reply": {
      const parsed = parsePtcVmReplyPayload(payload);
      if (!parsed.ok) return invalid(parsed.message);
      return { ok: true, value: payload };
    }
    default:
      return invalid("unknown method");
  }
}

function parseRequest(value: Record<string, unknown>): ParseResult<RpcRequestFrame> {
  const unknown = unexpectedKey(value, [
    "v", "kind", "id", "method", "sessionId", "jobId", "correlationId", "deadlineMs", "payload",
  ]);
  if (unknown !== undefined) return fail(`unknown request field: ${unknown}`);
  if (!isSafeId(value.id)) return fail("id is invalid");
  if (typeof value.method !== "string" || !METHODS.has(value.method as RpcMethod)) return fail("method is invalid");
  if (Object.hasOwn(value, "sessionId") && !isSafeId(value.sessionId)) return fail("sessionId is invalid");
  if (Object.hasOwn(value, "jobId") && !isSafeJobId(value.jobId)) return fail("jobId is invalid");
  if (Object.hasOwn(value, "correlationId") && !isSafeCorrelationId(value.correlationId)) {
    return fail("correlationId is invalid");
  }
  if (!Number.isSafeInteger(value.deadlineMs)
    || (value.deadlineMs as number) < RPC_MIN_DEADLINE_MS
    || (value.deadlineMs as number) > RPC_MAX_DEADLINE_MS) {
    return fail(`deadlineMs must be an integer in ${RPC_MIN_DEADLINE_MS}..${RPC_MAX_DEADLINE_MS}`);
  }
  const method = value.method as RpcMethod;
  const payload = validateRequestPayload(method, value.payload);
  return {
    ok: true,
    value: {
      v: 1,
      kind: "request",
      id: value.id,
      method,
      deadlineMs: value.deadlineMs as number,
      payload: payload.ok ? payload.value : {},
      ...(payload.ok ? {} : { payloadError: { code: payload.code, message: payload.message } }),
      ...(Object.hasOwn(value, "sessionId") ? { sessionId: value.sessionId as string } : {}),
      ...(Object.hasOwn(value, "jobId") ? { jobId: value.jobId as string } : {}),
      ...(Object.hasOwn(value, "correlationId") ? { correlationId: value.correlationId as string } : {}),
    },
  };
}

function parseResponse(value: Record<string, unknown>): ParseResult<RpcResponseFrame> {
  const unknown = unexpectedKey(value, ["v", "kind", "id", "correlationId", "status", "result", "error"]);
  if (unknown !== undefined) return fail(`unknown response field: ${unknown}`);
  if (!isSafeId(value.id)) return fail("id is invalid");
  if (Object.hasOwn(value, "correlationId") && !isSafeCorrelationId(value.correlationId)) {
    return fail("correlationId is invalid");
  }
  const correlationId = Object.hasOwn(value, "correlationId")
    ? { correlationId: value.correlationId as string }
    : {};
  if (value.status === "ok") {
    return { ok: true, value: { v: 1, kind: "response", id: value.id, status: "ok", result: value.result, ...correlationId } };
  }
  if (value.status === "error") {
    const error = validateErrorPayload(value.error);
    if (!error.ok) return fail(error.message);
    return { ok: true, value: { v: 1, kind: "response", id: value.id, status: "error", error: error.value, ...correlationId } };
  }
  return fail("response.status is invalid");
}

function parseEvent(value: Record<string, unknown>): ParseResult<RpcEventFrame> {
  if (value.event === "output") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "id", "sessionId", "seq", "stream", "text"]);
    if (unknown !== undefined) return fail(`unknown output event field: ${unknown}`);
    if (!isSafeId(value.id)) return fail("id is invalid");
    if (!isSafeId(value.sessionId)) return fail("sessionId is invalid");
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return fail("seq is invalid");
    if (value.stream !== "stdout" && value.stream !== "stderr") return fail("stream is invalid");
    if (!isSafeText(value.text, RPC_MAX_OUTPUT_CHUNK_BYTES)) return fail("text is invalid");
    return {
      ok: true,
      value: {
        v: 1,
        kind: "event",
        event: "output",
        id: value.id,
        sessionId: value.sessionId,
        seq: value.seq as number,
        stream: value.stream,
        text: value.text,
      },
    };
  }
  if (value.event === "heartbeat") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "timestamp", "sessionId"]);
    if (unknown !== undefined) return fail(`unknown heartbeat field: ${unknown}`);
    if (!Number.isSafeInteger(value.timestamp)) return fail("timestamp is invalid");
    if (Object.hasOwn(value, "sessionId") && !isSafeId(value.sessionId)) return fail("sessionId is invalid");
    return {
      ok: true,
      value: {
        v: 1,
        kind: "event",
        event: "heartbeat",
        timestamp: value.timestamp as number,
        ...(Object.hasOwn(value, "sessionId") ? { sessionId: value.sessionId as string } : {}),
      },
    };
  }
  if (value.event === "session.closed") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "sessionId", "reason"]);
    if (unknown !== undefined) return fail(`unknown session.closed field: ${unknown}`);
    if (!isSafeId(value.sessionId)) return fail("sessionId is invalid");
    if (!isSafeReason(value.reason)) return fail("reason is invalid");
    return {
      ok: true,
      value: { v: 1, kind: "event", event: "session.closed", sessionId: value.sessionId, reason: value.reason },
    };
  }
  if (value.event === "vm.message") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "id", "sessionId", "callId", "messages"]);
    if (unknown !== undefined) return fail(`unknown vm.message event field: ${unknown}`);
    if (!isSafeId(value.id)) return fail("id is invalid");
    if (!isSafeId(value.sessionId)) return fail("sessionId is invalid");
    if (Object.hasOwn(value, "callId") && !isPositiveInteger(value.callId)) return fail("callId is invalid");
    if (!Array.isArray(value.messages) || value.messages.length > PTC_MAX_VM_MESSAGES) {
      return fail(`messages must be an array of at most ${PTC_MAX_VM_MESSAGES} entries`);
    }
    if (!value.messages.every(isPlainObject)) return fail("messages entries must be objects");
    return {
      ok: true,
      value: {
        v: 1,
        kind: "event",
        event: "vm.message",
        id: value.id,
        sessionId: value.sessionId,
        messages: value.messages,
        ...(Object.hasOwn(value, "callId") ? { callId: value.callId as number } : {}),
      },
    };
  }
  if (value.event === "tool.output") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "id", "sessionId", "seq", "stream", "text", "skipped"]);
    if (unknown !== undefined) return fail(`unknown tool.output event field: ${unknown}`);
    if (!isSafeId(value.id)) return fail("id is invalid");
    if (!isSafeId(value.sessionId)) return fail("sessionId is invalid");
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return fail("seq is invalid");
    if (value.stream !== "stdout" && value.stream !== "stderr") return fail("stream is invalid");
    if (!isSafeText(value.text, RPC_MAX_OUTPUT_CHUNK_BYTES)) return fail("text is invalid");
    let skipped: RpcSkippedOutput | undefined;
    if (Object.hasOwn(value, "skipped")) {
      if (!isPlainObject(value.skipped)
        || unexpectedKey(value.skipped, ["bytes", "newlines", "endsWithNewline"]) !== undefined) {
        return fail("skipped is invalid");
      }
      if (!Number.isSafeInteger(value.skipped.bytes) || (value.skipped.bytes as number) < 0
        || !Number.isSafeInteger(value.skipped.newlines) || (value.skipped.newlines as number) < 0
        || typeof value.skipped.endsWithNewline !== "boolean") {
        return fail("skipped is invalid");
      }
      skipped = {
        bytes: value.skipped.bytes as number,
        newlines: value.skipped.newlines as number,
        endsWithNewline: value.skipped.endsWithNewline,
      };
    }
    return {
      ok: true,
      value: {
        v: 1,
        kind: "event",
        event: "tool.output",
        id: value.id,
        sessionId: value.sessionId,
        seq: value.seq as number,
        stream: value.stream,
        text: value.text,
        ...(skipped === undefined ? {} : { skipped }),
      },
    };
  }
  return fail("event is invalid");
}

export function parseRpcFrame(value: unknown): ParseResult<RpcFrame> {
  if (!isPlainObject(value)) return fail("frame must be an object");
  if (value.v !== RPC_PROTOCOL_VERSION) {
    return fail(`unsupported protocol version; expected ${RPC_PROTOCOL_VERSION}`);
  }
  if (value.kind === "request") return parseRequest(value);
  if (value.kind === "response") return parseResponse(value);
  if (value.kind === "event") return parseEvent(value);
  return fail("kind is invalid");
}

export function encodeRpcFrame(frame: RpcFrame, maxFrameBytes = RPC_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length > maxFrameBytes) {
    throw new RpcProtocolError("too_large", `frame exceeds ${maxFrameBytes} bytes`);
  }
  const header = Buffer.allocUnsafe(RPC_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder for a byte stream. Oversized or malformed frames fail the connection. */
export class RpcFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = RPC_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): RpcFrame[] {
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: RpcFrame[] = [];
    while (this.buffer.length >= RPC_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0) throw new RpcProtocolError("protocol_error", "empty frame");
      if (length > this.maxFrameBytes) {
        throw new RpcProtocolError("too_large", `frame exceeds ${this.maxFrameBytes} bytes`);
      }
      if (this.buffer.length < RPC_HEADER_BYTES + length) break;
      const body = this.buffer.subarray(RPC_HEADER_BYTES, RPC_HEADER_BYTES + length).toString("utf8");
      this.buffer = this.buffer.subarray(RPC_HEADER_BYTES + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new RpcProtocolError("protocol_error", "frame is not valid JSON");
      }
      const frame = parseRpcFrame(parsed);
      if (!frame.ok) throw new RpcProtocolError("protocol_error", frame.message);
      frames.push(frame.value);
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}
