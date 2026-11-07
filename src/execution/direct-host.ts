// Shared Phase 1 execution host contract and failure type.
//
// The retired PTC / code mode feature used to define these alongside its VM host in
// `ptc-host.ts`. Only `DirectHost` and the failure type are still used by the shared
// CVM host, so they live here under a neutral name; the VM host interface was archived.

import type {
  RpcBashExecutePayload,
  RpcErrorCode,
  RpcFileMethod,
  RpcOutcome,
  RpcSkippedOutput,
} from "./rpc-protocol.js";

/**
 * An expected execution-host failure with its protocol meaning. The host raises this for
 * business conditions; anything else becomes `internal`, so a bug can never masquerade
 * as a business error.
 */
export class DirectHostError extends Error {
  override name = "DirectHostError";

  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly outcome: RpcOutcome = "failed",
  ) {
    super(message);
  }
}

/**
 * What the RPC server needs from the shared execution host. The host owns the session
 * workspace and one private `/tmp` directory per session; the server owns framing,
 * deadlines, sessions and request-id deduplication. A same-host container roots each
 * session in the virtual `cwd` it was opened with.
 */
export type DirectHost = {
  readonly enabled: boolean;
  readonly sharedMode: "none" | "ro" | "rw";
  preflight(): Promise<Record<string, boolean | null>>;
  openSession(sessionId: string, cwd?: string): Promise<{
    readonly sharedMode: "ro" | "rw";
    readonly tmpPath: string;
    readonly workspace?: string;
  }>;
  closeSession(sessionId: string): Promise<void>;
  execute(input: {
    readonly sessionId: string;
    readonly payload: RpcBashExecutePayload;
    readonly signal: AbortSignal;
    readonly emit: (seq: number, stream: "stdout" | "stderr", text: string, skipped?: RpcSkippedOutput) => void;
  }): Promise<{ readonly exitCode: number; readonly durationMs: number }>;
  fileRequest(input: {
    readonly sessionId: string;
    readonly method: RpcFileMethod;
    readonly payload: Record<string, unknown>;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
};
