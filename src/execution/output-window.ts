// Shared Phase 1 execution host: bound the output window a caller may ask for.
//
// This is a wire-primitive, not a PTC feature. It used to live in `direct-executor.ts`
// (the retired bwrap direct-session host); the shared host still needs exactly this
// clamp, so it lives here under a neutral name.

import {
  PTC_MAX_WINDOW_LINES,
  RPC_MAX_OUTPUT_CHUNK_BYTES,
  type RpcBashExecutePayload,
} from "./rpc-protocol.js";

/** Host-side limits the caller's window is clamped against. */
export type OutputWindowBounds = {
  readonly outputChunkBytes: number;
  readonly outputBytesPerSecond: number;
};

/** The caller's output window, clamped to what this host is willing to emit. */
export function clampWindow(
  payload: RpcBashExecutePayload,
  bounds: OutputWindowBounds,
): RpcBashExecutePayload["window"] {
  return {
    maxBytes: Math.max(1, Math.min(payload.window.maxBytes, bounds.outputChunkBytes, RPC_MAX_OUTPUT_CHUNK_BYTES)),
    maxLines: Math.max(1, Math.min(payload.window.maxLines, PTC_MAX_WINDOW_LINES)),
    minIntervalMs: Math.min(Math.max(0, payload.window.minIntervalMs), 1_000),
    bytesPerSecond: Math.max(0, Math.min(payload.window.bytesPerSecond, Math.max(0, bounds.outputBytesPerSecond))),
  };
}
