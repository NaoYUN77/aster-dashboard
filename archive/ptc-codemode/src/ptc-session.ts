import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { RpcExecutionClient } from "./execution/rpc-client.js";

/** The RPC operations one PTC session needs. Structural, so tests can drive the gateway in-process. */
export type PtcRpcClient = Pick<
  RpcExecutionClient,
  "health" | "openSession" | "closeSession" | "startVm" | "replyVm" | "startToolCall" | "fileRequest" | "close"
>;

/**
 * One code mode run on the execution host. The host context creates it before the sandbox starts
 * and destroys it when the code mode call settles; nothing the model writes can create, replace or
 * retarget it. Nested calls find it through their durable task input (`parent`), never through
 * tool arguments.
 */
export type PtcSession = {
  readonly client: PtcRpcClient;
  readonly sessionId: string;
  readonly jobId: string;
  readonly conversationId: ConversationId;
  /** The durable code mode task this session belongs to; nested calls name it as `parent`. */
  readonly taskId: TaskId;
  /** Register the running VM so an abort can cancel it without leaving it computing. */
  registerVm(cancel: (() => void) | undefined): void;
};

/** `c<callId>` is the only key shape code mode uses; anything else is not a VM identity. */
export function parseNestedCallKey(key: string | undefined): number | undefined {
  if (key === undefined) return undefined;
  const match = /^c([1-9][0-9]*)$/.exec(key);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
