import type { ExecRequest } from "./protocol.js";

/** Output emitted by a command runner; the broker applies the caller's window and framing. */
export type OutputSink = {
  stdout(text: string): void;
  stderr(text: string): void;
};

/** Runs one validated request. Throws `RunnerError` for failures the caller must distinguish. */
export type CommandRunner = (
  request: ExecRequest,
  sink: OutputSink,
  signal: AbortSignal,
) => Promise<{ readonly exitCode: number }>;

export type RunnerErrorCode = "timeout" | "spawn_error" | "aborted" | "unknown";

export class RunnerError extends Error {
  override name = "RunnerError";
  constructor(readonly code: RunnerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
