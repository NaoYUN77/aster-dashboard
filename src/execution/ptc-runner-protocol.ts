/**
 * Frames between the execution agent and the PTC runner process it starts inside bwrap. Stdio is
 * length-prefixed JSON, like the gateway protocol, so the runner can never inject shell or framing
 * syntax into the transport. Every frame is validated on receipt: the runner is inside the sandbox
 * and its output is untrusted data to the agent.
 */
import type {
  PtcToolCallArgs,
  PtcToolCallResult,
  RpcErrorCode,
  RpcFileMethod,
  RpcSkippedOutput,
} from "./rpc-protocol.js";
import { isRpcFileMethod, parseFileRequestPayload, parsePtcToolCallPayload } from "./rpc-protocol.js";

export const PTC_RUNNER_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const PTC_RUNNER_HEADER_BYTES = 4;

export type PtcRunnerStart = {
  readonly t: "start";
  readonly jobId: string;
  readonly sessionId: string;
  readonly request: {
    readonly data: Record<string, unknown>;
    readonly interruptBudget?: number;
  };
};

export type PtcRunnerReply = {
  readonly t: "reply";
  readonly callId: number;
  readonly reply: Record<string, unknown> | null;
};

export type PtcRunnerToolCall = {
  readonly t: "tool.call";
  readonly callId: number;
  readonly args: PtcToolCallArgs;
};

/**
 * One bounded file primitive executed inside the sandbox. `requestId` is the agent's RPC request
 * id space; it is independent of the VM's nested `callId`, because a file operation is not a tool
 * call and must never be answered as one.
 */
export type PtcRunnerFile = {
  readonly t: "file";
  readonly requestId: number;
  readonly method: RpcFileMethod;
  readonly payload: Record<string, unknown>;
};

export type PtcRunnerCancel = { readonly t: "cancel" };

export type HostToRunner = PtcRunnerStart | PtcRunnerReply | PtcRunnerToolCall | PtcRunnerFile | PtcRunnerCancel;

export type PtcRunnerVm = {
  readonly t: "vm";
  readonly callId?: number;
  readonly messages: readonly Record<string, unknown>[];
};

export type PtcRunnerToolOutput = {
  readonly t: "tool.output";
  readonly callId: number;
  readonly seq: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly skipped?: RpcSkippedOutput;
};

export type PtcRunnerToolDone = {
  readonly t: "tool.done";
  readonly callId: number;
  readonly result: PtcToolCallResult;
};

export type PtcRunnerToolError = {
  readonly t: "tool.error";
  readonly callId: number;
  readonly code: RpcErrorCode;
  readonly message: string;
};

export type PtcRunnerFileDone = {
  readonly t: "file.done";
  readonly requestId: number;
  readonly result: unknown;
};

export type PtcRunnerFileError = {
  readonly t: "file.error";
  readonly requestId: number;
  readonly code: RpcErrorCode;
  readonly message: string;
};

export type PtcRunnerDone = { readonly t: "done" };

export type PtcRunnerError = {
  readonly t: "error";
  readonly code: RpcErrorCode;
  readonly message: string;
};

export type RunnerToHost =
  | PtcRunnerVm
  | PtcRunnerToolOutput
  | PtcRunnerToolDone
  | PtcRunnerToolError
  | PtcRunnerFileDone
  | PtcRunnerFileError
  | PtcRunnerDone
  | PtcRunnerError;

export class PtcRunnerProtocolError extends Error {
  override name = "PtcRunnerProtocolError";

  constructor(readonly code: "invalid_frame" | "too_large" | "unsupported_version", message: string) {
    super(message);
  }
}

/** Incremental decoder; a partial frame stays buffered until its declared length arrives. */
export class PtcRunnerFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = PTC_RUNNER_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < PTC_RUNNER_HEADER_BYTES) break;
      const length = this.buffer.readUInt32BE(0);
      if (length === 0) throw new PtcRunnerProtocolError("invalid_frame", "empty frame");
      if (length > this.maxFrameBytes) {
        throw new PtcRunnerProtocolError("too_large", `frame exceeds ${this.maxFrameBytes} bytes`);
      }
      if (this.buffer.length < PTC_RUNNER_HEADER_BYTES + length) break;
      frames.push(this.buffer.subarray(PTC_RUNNER_HEADER_BYTES, PTC_RUNNER_HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(PTC_RUNNER_HEADER_BYTES + length);
    }
    return frames;
  }
}

export function encodeRunnerFrame(frame: HostToRunner | RunnerToHost): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length === 0 || payload.length > PTC_RUNNER_MAX_FRAME_BYTES) {
    throw new PtcRunnerProtocolError("too_large", "frame size is invalid");
  }
  const header = Buffer.alloc(PTC_RUNNER_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

export type RunnerParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Decode one frame payload into a validated message. Unknown shapes are rejected, never coerced. */
export function parseRunnerFrame(payload: Buffer | string): RunnerParseResult<RunnerToHost> {
  let value: unknown;
  try {
    value = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
  } catch {
    return fail("frame is not JSON");
  }
  if (!isRecord(value) || typeof value.t !== "string") return fail("frame is not tagged");
  const t = value.t;
  if (t === "vm") {
    if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 4_096) {
      return fail("vm.messages is invalid");
    }
    if (!value.messages.every(isRecord)) return fail("vm.messages entries are invalid");
    if (value.callId !== undefined && (!Number.isSafeInteger(value.callId) || (value.callId as number) < 1)) {
      return fail("vm.callId is invalid");
    }
    return {
      ok: true,
      value: {
        t: "vm",
        messages: value.messages as Record<string, unknown>[],
        ...(value.callId === undefined ? {} : { callId: value.callId as number }),
      },
    };
  }
  if (t === "tool.output") {
    if (!Number.isSafeInteger(value.callId) || (value.callId as number) < 1) return fail("tool.output.callId is invalid");
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return fail("tool.output.seq is invalid");
    if (value.stream !== "stdout" && value.stream !== "stderr") return fail("tool.output.stream is invalid");
    if (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 64 * 1024) {
      return fail("tool.output.text is invalid");
    }
    let skipped: RpcSkippedOutput | undefined;
    if (value.skipped !== undefined) {
      const skip = value.skipped;
      if (!isRecord(skip)
        || !Number.isSafeInteger(skip.bytes) || (skip.bytes as number) < 0
        || !Number.isSafeInteger(skip.newlines) || (skip.newlines as number) < 0
        || typeof skip.endsWithNewline !== "boolean") {
        return fail("tool.output.skipped is invalid");
      }
      skipped = {
        bytes: skip.bytes as number,
        newlines: skip.newlines as number,
        endsWithNewline: skip.endsWithNewline,
      };
    }
    return {
      ok: true,
      value: {
        t: "tool.output",
        callId: value.callId as number,
        seq: value.seq as number,
        stream: value.stream,
        text: value.text,
        ...(skipped === undefined ? {} : { skipped }),
      },
    };
  }
  if (t === "tool.done") {
    if (!Number.isSafeInteger(value.callId) || (value.callId as number) < 1) return fail("tool.done.callId is invalid");
    // The result is validated by the caller with `parsePtcToolCallResult`, which also owns its schema.
    if (!isRecord(value.result)) return fail("tool.done.result is invalid");
    return { ok: true, value: { t: "tool.done", callId: value.callId as number, result: value.result as unknown as PtcToolCallResult } };
  }
  if (t === "tool.error") {
    if (!Number.isSafeInteger(value.callId) || (value.callId as number) < 1) return fail("tool.error.callId is invalid");
    if (typeof value.code !== "string" || typeof value.message !== "string" || Buffer.byteLength(value.message) > 2_048) {
      return fail("tool.error is invalid");
    }
    return {
      ok: true,
      value: {
        t: "tool.error",
        callId: value.callId as number,
        code: value.code as RpcErrorCode,
        message: value.message,
      },
    };
  }
  if (t === "file.done") {
    const unknown = Object.keys(value).find((key) => !["t", "requestId", "result"].includes(key));
    if (unknown !== undefined) return fail(`unknown file.done field: ${unknown}`);
    if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) {
      return fail("file.done.requestId is invalid");
    }
    return { ok: true, value: { t: "file.done", requestId: value.requestId as number, result: value.result } };
  }
  if (t === "file.error") {
    const unknown = Object.keys(value).find((key) => !["t", "requestId", "code", "message"].includes(key));
    if (unknown !== undefined) return fail(`unknown file.error field: ${unknown}`);
    if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) {
      return fail("file.error.requestId is invalid");
    }
    if (typeof value.code !== "string" || typeof value.message !== "string"
      || Buffer.byteLength(value.message) > 2_048) {
      return fail("file.error is invalid");
    }
    return {
      ok: true,
      value: {
        t: "file.error",
        requestId: value.requestId as number,
        code: value.code as RpcErrorCode,
        message: value.message,
      },
    };
  }
  if (t === "done") return { ok: true, value: { t: "done" } };
  if (t === "error") {
    if (typeof value.code !== "string" || typeof value.message !== "string" || Buffer.byteLength(value.message) > 2_048) {
      return fail("error frame is invalid");
    }
    return { ok: true, value: { t: "error", code: value.code as RpcErrorCode, message: value.message } };
  }
  return fail("unknown frame type");
}

export type { PtcToolCallArgs };

const JOB_ID = /^ptc-[a-f0-9]{32}$/;
const SESSION_ID = /^[a-f0-9]{16}$/;

/**
 * Decoder for frames the agent sends into the sandbox. The runner trusts nothing: a malformed or
 * unknown frame stops the execution instead of being coerced into a command.
 */
export function parseHostFrame(payload: Buffer | string): RunnerParseResult<HostToRunner> {
  let value: unknown;
  try {
    value = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
  } catch {
    return fail("frame is not JSON");
  }
  if (!isRecord(value) || typeof value.t !== "string") return fail("frame is not tagged");
  const unknownKey = (allowed: readonly string[]): string | undefined =>
    Object.keys(value).find((key) => !allowed.includes(key));
  if (value.t === "start") {
    const unknown = unknownKey(["t", "jobId", "sessionId", "request"]);
    if (unknown !== undefined) return fail(`unknown start field: ${unknown}`);
    if (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)) return fail("start.jobId is invalid");
    if (typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId)) return fail("start.sessionId is invalid");
    if (!isRecord(value.request) || !isRecord(value.request.data)) return fail("start.request is invalid");
    const budget = value.request.interruptBudget;
    if (budget !== undefined && (!Number.isSafeInteger(budget) || (budget as number) < 1 || (budget as number) > 1_000_000_000)) {
      return fail("start.request.interruptBudget is invalid");
    }
    return {
      ok: true,
      value: {
        t: "start",
        jobId: value.jobId,
        sessionId: value.sessionId,
        request: {
          data: value.request.data,
          ...(budget === undefined ? {} : { interruptBudget: budget as number }),
        },
      },
    };
  }
  if (value.t === "reply") {
    const unknown = unknownKey(["t", "callId", "reply"]);
    if (unknown !== undefined) return fail(`unknown reply field: ${unknown}`);
    if (!Number.isSafeInteger(value.callId) || (value.callId as number) < 1) return fail("reply.callId is invalid");
    if (value.reply !== null && !isRecord(value.reply)) return fail("reply.reply must be an object or null");
    return {
      ok: true,
      value: { t: "reply", callId: value.callId as number, reply: value.reply as Record<string, unknown> | null },
    };
  }
  if (value.t === "tool.call") {
    const unknown = unknownKey(["t", "callId", "args"]);
    if (unknown !== undefined) return fail(`unknown tool.call field: ${unknown}`);
    if (!Number.isSafeInteger(value.callId) || (value.callId as number) < 1) return fail("tool.call.callId is invalid");
    const parsed = parsePtcToolCallPayload({ tool: "bash", callId: value.callId, args: value.args });
    if (!parsed.ok) return fail(`tool.call args are invalid: ${parsed.message}`);
    return { ok: true, value: { t: "tool.call", callId: value.callId as number, args: parsed.value.args } };
  }
  if (value.t === "file") {
    const unknown = unknownKey(["t", "requestId", "method", "payload"]);
    if (unknown !== undefined) return fail(`unknown file field: ${unknown}`);
    if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 1) return fail("file.requestId is invalid");
    if (!isRpcFileMethod(value.method)) return fail("file.method is invalid");
    const parsed = parseFileRequestPayload(value.method, value.payload);
    if (!parsed.ok) return fail(`file payload is invalid: ${parsed.message}`);
    return {
      ok: true,
      value: {
        t: "file",
        requestId: value.requestId as number,
        method: value.method,
        payload: parsed.value,
      },
    };
  }
  if (value.t === "cancel") {
    const unknown = unknownKey(["t"]);
    if (unknown !== undefined) return fail(`unknown cancel field: ${unknown}`);
    return { ok: true, value: { t: "cancel" } };
  }
  return fail("unknown frame type");
}
