import type {
  PtcIsolationState,
  PtcToolCallPayload,
  PtcToolCallResult,
  PtcVmReplyPayload,
  PtcVmStartPayload,
  PtcWorkspaceState,
  RpcBashExecutePayload,
  RpcErrorCode,
  RpcFileMethod,
  RpcOutcome,
  RpcSkippedOutput,
} from "./rpc-protocol.js";
/** Where the executor reports what the remote VM and a nested call did. */
export type PtcEventSink = {
  vmMessage(callId: number | undefined, messages: readonly Record<string, unknown>[]): void;
  toolOutput(seq: number, stream: "stdout" | "stderr", text: string, skipped?: RpcSkippedOutput): void;
};

/**
 * A PTC failure with its protocol meaning. The executor raises this for expected conditions; anything
 * else becomes `internal`, so a bug can never masquerade as a business error.
 */
export class PtcHostError extends Error {
  override name = "PtcHostError";

  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly outcome: RpcOutcome = "failed",
  ) {
    super(message);
  }
}

/**
 * What the RPC server needs from the execution agent's sandbox. Implementations own the workspace,
 * isolation, runner process and output spill; the server owns framing, deadlines, sessions and
 * request-id deduplication.
 */
export type PtcHost = {
  readonly enabled: boolean;
  readonly isolation: PtcIsolationState;
  preflight(): Promise<Record<string, boolean | null>>;
  /**
   * `cwd` names the virtual workspace a same-host sandbox roots the session in. Hosts that derive
   * the workspace from the job id ignore it.
   */
  openSession(sessionId: string, jobId: string, workspaceReady: boolean, cwd?: string): Promise<PtcWorkspaceState>;
  closeSession(sessionId: string): Promise<void>;
  startVm(input: {
    readonly sessionId: string;
    readonly request: PtcVmStartPayload["request"];
    readonly signal: AbortSignal;
    readonly sink: PtcEventSink;
  }): Promise<unknown>;
  replyVm(sessionId: string, payload: PtcVmReplyPayload): Promise<void>;
  toolCall(input: {
    readonly sessionId: string;
    readonly payload: PtcToolCallPayload;
    readonly signal: AbortSignal;
    readonly sink: PtcEventSink;
  }): Promise<PtcToolCallResult>;
  /** One bounded file primitive, executed inside this session's sandbox. */
  fileRequest(input: {
    readonly sessionId: string;
    readonly method: RpcFileMethod;
    readonly payload: Record<string, unknown>;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  /** Requests immediate process termination; the signal is the cooperative path. */
  cancel(sessionId: string, requestId: string): void;
};

/**
 * A direct session's host, which owns the session workspace and one private `/tmp` directory per
 * session. The legacy bwrap host exposes `/shared`; a same-host container sandbox roots each
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
