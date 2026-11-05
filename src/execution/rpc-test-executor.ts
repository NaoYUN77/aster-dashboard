import type { RpcTestExecutePayload } from "./rpc-protocol.js";

export class RpcAbortError extends Error {
  override name = "RpcAbortError";
  readonly outcome = "unknown" as const;

  constructor(readonly reason: string) {
    super(reason);
  }
}

export class TestExecutionError extends Error {
  override name = "TestExecutionError";

  constructor(message: string) {
    super(message);
  }
}

export type TestExecutionResult =
  | { readonly operation: "echo"; readonly text: string }
  | { readonly operation: "stream"; readonly chunks: number; readonly bytes: number }
  | { readonly operation: "sleep"; readonly ms: number };

function abortError(signal: AbortSignal, reason: string): RpcAbortError {
  return new RpcAbortError(signal.reason === undefined ? reason : String(signal.reason));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal, "aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal, "aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Phase 0 executor. It intentionally cannot run a command, read a file, inherit the host
 * environment, or open a network connection. The only behaviours are the test operations below,
 * which are enough to verify streaming, deadlines, cancellation, and disconnect handling.
 */
export async function executeTestOperation(
  payload: RpcTestExecutePayload,
  signal: AbortSignal,
  emit: (text: string) => void,
): Promise<TestExecutionResult> {
  if (signal.aborted) throw abortError(signal, "aborted");
  switch (payload.operation) {
    case "echo":
      emit(payload.text);
      return { operation: "echo", text: payload.text };
    case "stream": {
      const delayMs = payload.delayMs ?? 0;
      const body = "x".repeat(payload.chunkBytes);
      let bytes = 0;
      for (let index = 0; index < payload.chunks; index++) {
        if (signal.aborted) throw abortError(signal, "aborted");
        const text = `chunk-${index}:${body}\n`;
        bytes += Buffer.byteLength(text, "utf8");
        emit(text);
        if (delayMs > 0) await wait(delayMs, signal);
        else await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (signal.aborted) throw abortError(signal, "aborted");
      return { operation: "stream", chunks: payload.chunks, bytes };
    }
    case "sleep":
      await wait(payload.ms, signal);
      return { operation: "sleep", ms: payload.ms };
    case "fail":
      throw new TestExecutionError("test executor was asked to fail");
  }
}
