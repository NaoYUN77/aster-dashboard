/**
 * Wire contract between the application (control plane container) and the host-side execution
 * broker. One request per connection, newline-delimited JSON in both directions. Everything the
 * model can influence (command, cwd, env) is validated here before it reaches an SSH argv or a
 * remote shell, and unknown fields are rejected so a protocol extension cannot silently change
 * meaning.
 */

export const EXECUTION_PROTOCOL_VERSION = 1;
/** Largest request line accepted by the broker. */
export const MAX_REQUEST_BYTES = 256 * 1024;
/** Largest frame line accepted by the client. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Longest command string, or sum of an argv, accepted for one execution. */
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_ARGV_ELEMENTS = 256;
export const MAX_ARGUMENT_BYTES = 16 * 1024;
export const MAX_ENV_ENTRIES = 128;
export const MAX_ENV_KEY_BYTES = 128;
export const MAX_ENV_VALUE_BYTES = 8 * 1024;
export const MAX_ENV_TOTAL_BYTES = 32 * 1024;
export const MAX_CWD_BYTES = 4096;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 86_400;

/** The same shape as pi-durable's `ShellOutputWindow`; `bytesPerSecond` is accepted but unused on a local socket. */
export type ShellWindow = {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly minIntervalMs: number;
  readonly bytesPerSecond: number;
};

export type ExecCommand = string | readonly string[];

export type ExecRequest = {
  readonly v: 1;
  readonly type: "exec";
  readonly id: string;
  readonly command: ExecCommand;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: boolean;
  readonly timeoutSeconds: number;
  readonly window?: ShellWindow;
};

export type PingRequest = {
  readonly v: 1;
  readonly type: "ping";
};

export type BrokerRequest = ExecRequest | PingRequest;

export type BrokerErrorCode =
  | "invalid_request"
  | "busy"
  | "timeout"
  | "spawn_error"
  | "aborted"
  | "unknown";

export type SkippedOutput = {
  readonly bytes: number;
  readonly newlines: number;
  readonly endsWithNewline: boolean;
};

export type OutputFrame = {
  readonly v: 1;
  readonly type: "output";
  readonly id: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly skipped?: SkippedOutput;
};

export type ExitFrame = {
  readonly v: 1;
  readonly type: "exit";
  readonly id: string;
  readonly exitCode: number;
};

export type ErrorFrame = {
  readonly v: 1;
  readonly type: "error";
  readonly id: string | null;
  readonly code: BrokerErrorCode;
  readonly message: string;
};

export type PongFrame = {
  readonly v: 1;
  readonly type: "pong";
  readonly protocol: 1;
  /** Stable for one broker target; different execution hosts must not share it. */
  readonly executionId: string;
};

export type BrokerFrame = OutputFrame | ExitFrame | ErrorFrame | PongFrame;

export type ParseResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly message: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXECUTION_ID_PATTERN = /^[a-f0-9]{16}$/;
const ERROR_CODES = new Set<BrokerErrorCode>([
  "invalid_request", "busy", "timeout", "spawn_error", "aborted", "unknown",
]);

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

function containsNul(value: string): boolean {
  return value.includes("\0");
}

export function isSafeRemoteId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isAbsoluteRemotePath(value: string): boolean {
  return value.startsWith("/") && !containsNul(value) && !value.includes("\n") && !value.includes("\r");
}

export function validateCwd(value: unknown): string | undefined {
  if (typeof value !== "string") return "cwd must be a string";
  if (!isAbsoluteRemotePath(value)) return "cwd must be an absolute POSIX path without control characters";
  if (byteLength(value) > MAX_CWD_BYTES) return `cwd must be at most ${MAX_CWD_BYTES} bytes`;
  return undefined;
}

export function validateTimeoutSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "timeoutSeconds must be an integer";
  if (value < MIN_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) {
    return `timeoutSeconds must be in ${MIN_TIMEOUT_SECONDS}..${MAX_TIMEOUT_SECONDS}`;
  }
  return undefined;
}

export function validateCommand(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (containsNul(value)) return "command must not contain NUL";
    if (byteLength(value) > MAX_COMMAND_BYTES) return `command must be at most ${MAX_COMMAND_BYTES} bytes`;
    return undefined;
  }
  if (!Array.isArray(value)) return "command must be a string or an array of strings";
  if (value.length === 0) return "command argv must not be empty";
  if (value.length > MAX_ARGV_ELEMENTS) return `command argv must have at most ${MAX_ARGV_ELEMENTS} elements`;
  let total = 0;
  for (const element of value) {
    if (typeof element !== "string") return "command argv elements must be strings";
    if (containsNul(element)) return "command must not contain NUL";
    if (byteLength(element) > MAX_ARGUMENT_BYTES) return `command argv element must be at most ${MAX_ARGUMENT_BYTES} bytes`;
    total += byteLength(element) + 1;
  }
  if (total > MAX_COMMAND_BYTES) return `command argv must sum to at most ${MAX_COMMAND_BYTES} bytes`;
  return undefined;
}

export function validateEnv(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "env must be an object of strings";
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_ENTRIES) return `env must have at most ${MAX_ENV_ENTRIES} entries`;
  let total = 0;
  for (const [key, entry] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) return `env key is invalid: ${key.slice(0, MAX_ENV_KEY_BYTES)}`;
    if (byteLength(key) > MAX_ENV_KEY_BYTES) return `env key must be at most ${MAX_ENV_KEY_BYTES} bytes`;
    if (typeof entry !== "string") return `env value for ${key.slice(0, MAX_ENV_KEY_BYTES)} must be a string`;
    if (containsNul(entry)) return `env value for ${key.slice(0, MAX_ENV_KEY_BYTES)} must not contain NUL`;
    if (byteLength(entry) > MAX_ENV_VALUE_BYTES) return `env value for ${key.slice(0, MAX_ENV_KEY_BYTES)} must be at most ${MAX_ENV_VALUE_BYTES} bytes`;
    total += byteLength(key) + byteLength(entry);
  }
  if (total > MAX_ENV_TOTAL_BYTES) return `env must total at most ${MAX_ENV_TOTAL_BYTES} bytes`;
  return undefined;
}

function validateWindow(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "window must be an object";
  const unknown = unexpectedKey(value, ["maxBytes", "maxLines", "minIntervalMs", "bytesPerSecond"]);
  if (unknown !== undefined) return `unknown window field: ${unknown}`;
  const { maxBytes, maxLines, minIntervalMs, bytesPerSecond } = value;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 256 || (maxBytes as number) > 16 * 1024 * 1024) {
    return "window.maxBytes must be an integer in 256..16777216";
  }
  if (!Number.isSafeInteger(maxLines) || (maxLines as number) < 1 || (maxLines as number) > 1_000_000) {
    return "window.maxLines must be an integer in 1..1000000";
  }
  if (!Number.isSafeInteger(minIntervalMs) || (minIntervalMs as number) < 0 || (minIntervalMs as number) > 60_000) {
    return "window.minIntervalMs must be an integer in 0..60000";
  }
  if (!Number.isSafeInteger(bytesPerSecond) || (bytesPerSecond as number) < 1 || (bytesPerSecond as number) > 1_000_000_000) {
    return "window.bytesPerSecond must be an integer in 1..1000000000";
  }
  return undefined;
}

export function parseBrokerRequest(line: string): ParseResult<BrokerRequest> {
  if (byteLength(line) > MAX_REQUEST_BYTES) return fail(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail("request is not valid JSON");
  }
  if (!isPlainObject(parsed)) return fail("request must be an object");
  if (parsed.v !== EXECUTION_PROTOCOL_VERSION) return fail(`unsupported protocol version; expected ${EXECUTION_PROTOCOL_VERSION}`);
  if (parsed.type === "ping") {
    const unknown = unexpectedKey(parsed, ["v", "type"]);
    if (unknown !== undefined) return fail(`unknown request field: ${unknown}`);
    return { ok: true, value: { v: 1, type: "ping" } };
  }
  if (parsed.type !== "exec") return fail("unknown request type");
  const allowed = ["v", "type", "id", "command", "cwd", "env", "inheritEnv", "timeoutSeconds",
    ...(Object.hasOwn(parsed, "window") ? ["window"] : [])];
  const unknown = unexpectedKey(parsed, allowed);
  if (unknown !== undefined) return fail(`unknown request field: ${unknown}`);
  const id = parsed.id;
  if (!isSafeRemoteId(id)) return fail("id is invalid");
  const commandError = validateCommand(parsed.command);
  if (commandError !== undefined) return fail(commandError);
  const cwd = parsed.cwd;
  if (typeof cwd !== "string") return fail("cwd must be a string");
  const cwdError = validateCwd(cwd);
  if (cwdError !== undefined) return fail(cwdError);
  const envError = validateEnv(parsed.env);
  if (envError !== undefined) return fail(envError);
  const inheritEnv = parsed.inheritEnv;
  if (typeof inheritEnv !== "boolean") return fail("inheritEnv must be a boolean");
  const timeoutSeconds = parsed.timeoutSeconds;
  if (typeof timeoutSeconds !== "number") return fail("timeoutSeconds must be an integer");
  const timeoutError = validateTimeoutSeconds(timeoutSeconds);
  if (timeoutError !== undefined) return fail(timeoutError);
  if (Object.hasOwn(parsed, "window")) {
    const windowError = validateWindow(parsed.window);
    if (windowError !== undefined) return fail(windowError);
  }
  return {
    ok: true,
    value: {
      v: 1,
      type: "exec",
      id,
      command: parsed.command as ExecCommand,
      cwd,
      env: parsed.env as Record<string, string>,
      inheritEnv,
      timeoutSeconds,
      ...(Object.hasOwn(parsed, "window") ? { window: parsed.window as ShellWindow } : {}),
    },
  };
}

export function parseBrokerFrame(line: string): ParseResult<BrokerFrame> {
  if (byteLength(line) > MAX_FRAME_BYTES) return fail(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail("frame is not valid JSON");
  }
  if (!isPlainObject(parsed)) return fail("frame must be an object");
  if (parsed.v !== EXECUTION_PROTOCOL_VERSION) return fail(`unsupported protocol version; expected ${EXECUTION_PROTOCOL_VERSION}`);
  switch (parsed.type) {
    case "pong": {
      const unknown = unexpectedKey(parsed, ["v", "type", "protocol", "executionId"]);
      if (unknown !== undefined) return fail(`unknown frame field: ${unknown}`);
      if (parsed.protocol !== EXECUTION_PROTOCOL_VERSION) return fail("broker protocol version mismatch");
      if (typeof parsed.executionId !== "string" || !EXECUTION_ID_PATTERN.test(parsed.executionId)) {
        return fail("executionId is invalid");
      }
      return { ok: true, value: { v: 1, type: "pong", protocol: 1, executionId: parsed.executionId } };
    }
    case "output": {
      const unknown = unexpectedKey(parsed, ["v", "type", "id", "stream", "text", "skipped"]);
      if (unknown !== undefined) return fail(`unknown frame field: ${unknown}`);
      if (!isSafeRemoteId(parsed.id)) return fail("id is invalid");
      if (parsed.stream !== "stdout" && parsed.stream !== "stderr") return fail("stream is invalid");
      if (typeof parsed.text !== "string") return fail("text must be a string");
      if (Object.hasOwn(parsed, "skipped")) {
        const skipped = parsed.skipped;
        if (!isPlainObject(skipped) || unexpectedKey(skipped, ["bytes", "newlines", "endsWithNewline"]) !== undefined) {
          return fail("skipped is invalid");
        }
        if (!Number.isSafeInteger(skipped.bytes) || (skipped.bytes as number) < 0
          || !Number.isSafeInteger(skipped.newlines) || (skipped.newlines as number) < 0
          || typeof skipped.endsWithNewline !== "boolean") {
          return fail("skipped is invalid");
        }
      }
      return {
        ok: true,
        value: {
          v: 1, type: "output", id: parsed.id, stream: parsed.stream, text: parsed.text,
          ...(Object.hasOwn(parsed, "skipped") ? { skipped: parsed.skipped as SkippedOutput } : {}),
        },
      };
    }
    case "exit": {
      const unknown = unexpectedKey(parsed, ["v", "type", "id", "exitCode"]);
      if (unknown !== undefined) return fail(`unknown frame field: ${unknown}`);
      if (!isSafeRemoteId(parsed.id)) return fail("id is invalid");
      if (!Number.isSafeInteger(parsed.exitCode) || (parsed.exitCode as number) < 0 || (parsed.exitCode as number) > 255) {
        return fail("exitCode must be an integer in 0..255");
      }
      return { ok: true, value: { v: 1, type: "exit", id: parsed.id, exitCode: parsed.exitCode as number } };
    }
    case "error": {
      const unknown = unexpectedKey(parsed, ["v", "type", "id", "code", "message"]);
      if (unknown !== undefined) return fail(`unknown frame field: ${unknown}`);
      if (parsed.id !== null && !isSafeRemoteId(parsed.id)) return fail("id is invalid");
      if (typeof parsed.code !== "string" || !ERROR_CODES.has(parsed.code as BrokerErrorCode)) return fail("code is invalid");
      if (typeof parsed.message !== "string" || byteLength(parsed.message) > 4096) return fail("message is invalid");
      return {
        ok: true,
        value: {
          v: 1, type: "error", id: parsed.id, code: parsed.code as BrokerErrorCode, message: parsed.message,
        },
      };
    }
    default:
      return fail("unknown frame type");
  }
}
