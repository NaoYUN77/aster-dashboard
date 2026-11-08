// Background jobs (ADR-0024): limits, the terminal outcome shape, and the deterministic notice text.
//
// Everything here is host-owned and bounded. Nothing in this file reads a model parameter or a
// request field: a job's command comes from a tool call, but its directory, its timeout and the
// shape of its record are decided here.

import { rpcMaxTimeoutSeconds } from "../execution/rpc-protocol.js";

/** Longest command accepted from the model. It is a display bound as well as an input bound. */
export const JOB_COMMAND_MAX_CHARS = 4_000;
/** Tail of the combined output kept in the job row and quoted in the notice. */
export const JOB_OUTPUT_TAIL_BYTES = 4_096;
/** Bound on the stored notice; the tail above already bounds the body. */
export const JOB_NOTICE_MAX_CHARS = 2_000;
/** How many jobs one bot may have unfinished at once. Dispatched work is real resource use. */
export const JOB_LIVE_LIMIT = 4;
/** Characters of a command quoted in a one-line listing or a notice heading. */
export const JOB_COMMAND_DISPLAY_CHARS = 200;
/** Registered name of the durable task one job runs under. */
export const JOB_TASK_KIND = "personal.job";
/**
 * Bounds of the reconciler's scan of that kind. The newest records are the ones a live row can name,
 * so the scan is descending and short; reaching the bound is reported rather than silently trimming.
 */
export const JOB_SCAN_PAGE = 200;
export const JOB_SCAN_MAX_PAGES = 5;
/**
 * Time limit for a deployment that runs commands in this process. The local environment has no bound
 * of its own, so the host states one rather than letting a job run unbounded; it matches the default
 * ceiling the remote transports are configured with.
 */
export const JOB_LOCAL_TIMEOUT_SECONDS = 3_600;

/**
 * The longest single command a job may run, in whole seconds, derived from the configured transport
 * rather than from the model or the request. The configured ceiling is not what the transport
 * accepts — the direct transport reserves part of its wire deadline — so the transport's own
 * derivation is reused here and a dispatched job can never ask for a timeout that is refused before
 * the command runs. With no remote transport there is nothing to derive from but the local bound.
 */
export function jobTimeoutSeconds(
  execution: { readonly transport: "ssh" | "rpc"; readonly maxTimeoutSeconds: number } | undefined,
): number {
  if (execution === undefined) return JOB_LOCAL_TIMEOUT_SECONDS;
  return execution.transport === "rpc" ? rpcMaxTimeoutSeconds(execution.maxTimeoutSeconds) : execution.maxTimeoutSeconds;
}

/** A job's terminal state. `queued` and `running` never appear: they are not outcomes. */
export type JobState = "done" | "failed" | "canceled" | "unknown";

export type JobOutcome = {
  readonly state: JobState;
  /** The command's exit code when it ran to completion; null when it never produced one. */
  readonly exitCode: number | null;
  /** A stable business code, never a transport exception's message. Null on success. */
  readonly error: string | null;
  /** Bounded tail of the combined output. */
  readonly output: string;
};

/**
 * A terminal outcome as it is written into the task's durable `result`. The reconciler reads it back
 * through {@link parseJobOutcome}, so the two never disagree about what a finished job means.
 */
export function parseJobOutcome(value: unknown): JobOutcome | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!["done", "failed", "canceled", "unknown"].includes(String(raw.state))) return undefined;
  const exitCode = raw.exitCode == null ? null : Number(raw.exitCode);
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) return undefined;
  return Object.freeze({
    state: raw.state as JobState,
    exitCode,
    error: raw.error == null ? null : String(raw.error).slice(0, 64),
    output: typeof raw.output === "string" ? raw.output : "",
  });
}

/**
 * The bytes a notice quotes. Deterministic and model-free: the same terminal state always renders
 * the same text, so a replayed write cannot publish a second, differently worded notice.
 */
export function jobNoticeText(jobId: string, command: string, outcome: JobOutcome, durationMs: number | null): string {
  const heading = `${JOB_STATE_WORDS[outcome.state]}：${truncate(command, JOB_COMMAND_DISPLAY_CHARS)}`;
  const facts = [
    `作业 ${jobId}`,
    outcome.exitCode === null ? null : `退出码 ${outcome.exitCode}`,
    outcome.error === null ? null : `错误码 ${outcome.error}`,
    durationMs === null ? null : `耗时 ${(durationMs / 1_000).toFixed(1)}s`,
  ].filter((part): part is string => part !== null).join("｜");
  const body = outcome.output.trim() === "" ? "" : `\n输出尾：\n${outcome.output.trim()}`;
  return truncate(`${heading}\n${facts}${body}`, JOB_NOTICE_MAX_CHARS);
}

const JOB_STATE_WORDS: Readonly<Record<JobState, string>> = {
  done: "后台作业已完成",
  failed: "后台作业失败",
  canceled: "后台作业已取消",
  unknown: "后台作业结果未知",
};

/**
 * The tail of a text stream, bounded by UTF-8 bytes and never splitting a surrogate pair. The
 * environment delivers output in arbitrary chunks and may deliver a lot of it, so appending is
 * amortized: compaction happens only after the bound is crossed.
 */
export class TailText {
  readonly #maxBytes: number;
  #chunks: string[] = [];
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: string): void {
    if (chunk === "") return;
    this.#chunks.push(chunk);
    this.#bytes += Buffer.byteLength(chunk, "utf8");
    if (this.#bytes > this.#maxBytes) this.#compact();
  }

  text(): string {
    return this.#chunks.join("");
  }

  #compact(): void {
    const joined = this.#chunks.join("");
    this.#chunks = [tailByBytes(joined, this.#maxBytes)];
    this.#bytes = Buffer.byteLength(this.#chunks[0]!, "utf8");
  }
}

/** The last `maxBytes` UTF-8 bytes of `text`, cut at a character boundary. */
export function tailByBytes(text: string, maxBytes: number): string {
  let start = 0;
  while (start < text.length && Buffer.byteLength(text.slice(start), "utf8") > maxBytes) {
    const code = text.codePointAt(start) ?? 0;
    start += code > 0xffff ? 2 : 1;
  }
  return text.slice(start);
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
