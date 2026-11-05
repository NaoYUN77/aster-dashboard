// The control-plane half of the remote PTC sandbox.
//
// Interface
//   derivePtcJobId(conversationId, taskId)     stable identity for one code mode task
//   SessionBoundCodemodeSandbox                remote VM sandbox whose session is the one bound around start()
//   PtcGateway.start()                         prove the agent speaks PTC and file tools before accepting work
//   PtcGateway.wrapCodemodeTool(tool)          open one PTC session per code mode call, close it in finally
//   PtcGateway.wrapScriptTools(extension)      run nested bash/read/write/edit calls through the session
//   PtcGateway.close()                         close sessions, then the RPC connection it owns
//
// Inputs: the validated RPC client configuration (or an already connected client shared with the
// direct environment), the code mode bounds, the execution timeout bounds, and pi-durable's per-call
// API. Identity is host-derived: jobId from the conversation and the code mode task, sessionId from the
// host's random source, callId from the durable nested key. The model supplies only script text and
// tool arguments.
//
// Errors: a missing session, an unexpected nested key and a failed RPC call are errors; the bash
// wrapper never falls back to the direct broker path. Closing a session is best-effort and logged,
// because the script result is already committed and a close failure must not turn it into a lie.
//
// Side effects: RPC sessions and VM runs on the execution host, durable PtcJobDoc/PtcOutputDoc
// commits, and the sandbox binding. Full output never crosses to the control plane.

import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  Extension,
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeRemoteExchange,
  type CodemodeRemoteMessage,
  type CodemodeRemoteReply,
  type CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { RpcClientError, type RpcExecutionClient } from "./execution/rpc-client.js";
import { connectRpcClient } from "./execution/rpc-connect.js";
import type { RpcClientConfig } from "./execution/rpc-config.js";
import {
  PTC_WORKSPACE_PATH,
  RPC_MAX_DEADLINE_MS,
  type PtcToolCallResult,
  type RpcVmMessageEvent,
  type PtcVmStartPayload,
} from "./execution/rpc-protocol.js";
import {
  appendPtcOutputInTx,
  ensurePtcJobInTx,
  initialPtcJob,
  markPtcWorkspaceReady,
  type PtcOutputRef,
} from "./ptc-docs.js";
import { PtcExecutionEnv } from "./ptc-env.js";
import { parseNestedCallKey, type PtcRpcClient, type PtcSession } from "./ptc-session.js";
import { currentSpan, stringBytes, traceChild, type TraceFields, type TraceOutcome } from "./trace.js";

/** Slack over the script deadline for the runner to report its own stop. */
const VM_DEADLINE_SLACK_MS = 60_000;

/** Built-in tools whose nested form must run in the sandbox rather than on the control plane. */
const NESTED_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/** `jobId` names one code mode task's workspace; a rerun of the same task derives the same id. */
export function derivePtcJobId(conversationId: ConversationId, taskId: TaskId): string {
  const digest = createHash("sha256")
    .update(`remote-ptc-sandbox\0${conversationId}\0${taskId}`)
    .digest("hex");
  return `ptc-${digest.slice(0, 32)}`;
}

export const PTC_BASH_STRUCTURED_OUTPUT_SCHEMA = Type.Object(
  {
    output: Type.String({ description: "Combined stdout and stderr: the retained tail" }),
    truncated: Type.Boolean({ description: "Whether earlier output was dropped" }),
    exitCode: Type.Number(),
    // The model only needs the spill path. The host still validates every persisted OutputRef
    // against the full PtcOutputRefSchema before it reaches durable storage.
    outputRef: Type.Optional(
      Type.Object(
        { path: Type.String({ description: "Sandbox path of the complete output" }) },
        { additionalProperties: true, description: "Spill file for truncated output: read outputRef.path" },
      ),
    ),
    spillTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A durable task input is an opaque JSON value; only a plain object can carry a task contract. */
function taskInputRecord(input: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(input) ? input : undefined;
}

/** A nested call's `parent` is the durable task id of the code mode call that made it. */
function taskIdOrUndefined(value: unknown): TaskId | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value as TaskId
    : undefined;
}

/** The remote is looked up through the ambient binding; no script can start a VM without a session. */
class MissingSessionRemote implements CodemodeRemote {
  async execute(_request: CodemodeRemoteRequest, _exchange: CodemodeRemoteExchange): Promise<void> {
    throw new Error("No PTC session is bound to this code mode execution");
  }
}

/** One execution's bridge between the host-side exchange and the RPC `vm.*` methods. */
class RpcCodemodeRemote implements CodemodeRemote {
  constructor(
    private readonly session: PtcSession,
    private readonly deadlineMs: number,
  ) {}

  async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
    const data = request.data;
    const payload: PtcVmStartPayload = {
      request: {
        data: {
          code: data.code,
          tools: data.tools.map((tool) => ({
            name: tool.name,
            jsName: tool.jsName,
            description: tool.description,
          })),
          globals: data.globals.map((global) => ({ name: global.name, spread: global.spread === true })),
          store: { ...data.store },
          ...(data.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: data.memoryLimitBytes }),
          ...(data.deterministic === undefined
            ? {}
            : { deterministic: { startedAt: data.deterministic.startedAt, seed: data.deterministic.seed } }),
        },
        ...(request.interruptBudget === undefined ? {} : { interruptBudget: request.interruptBudget }),
      },
    };

    // Deliver each batch as it arrives instead of chaining the exchanges. An exchange for a call
    // stays pending until that call's tool settles, and the VM's next message is often the idle
    // acknowledgment that admits that call; awaiting the previous exchange here would keep the
    // acknowledgment from reaching the host, and the call could never start. Delivery order is
    // still the arrival order because `exchange` hands its messages to the host synchronously.
    let replyChain: Promise<void> = Promise.resolve();
    const deliveries = new Set<Promise<void>>();
    let batchFailure: unknown;
    let rpcFailure: unknown;
    let runnerFailure: string | undefined;
    // The VM span is created before the RPC request so runner messages and rpc.vm.start share one
    // parent. The callback runs outside the ALS context, so it closes over this span.
    const codemodeSpan = currentSpan();
    const span = traceChild("runner.vm", {
      sessionId: this.session.sessionId,
      jobId: this.session.jobId,
      scriptBytes: stringBytes(data.code),
      toolCount: data.tools.length,
    });
    const onVmMessage = (event: RpcVmMessageEvent): void => {
      const messages = event.messages as unknown as CodemodeRemoteMessage[];
      const callId = event.callId;
      for (const message of messages) {
        const fields = runnerMessageFields(message);
        if (fields === undefined) continue;
        span?.event("runner.message", fields);
        if (message.type === "failure") runnerFailure = message.error.kind;
        else if (message.type === "crash") runnerFailure = "sandbox";
        else if (message.type === "done" && !message.ok) runnerFailure = "script";
      }
      const delivery = (async () => {
        if (batchFailure !== undefined || rpcFailure !== undefined) return;
        let reply: CodemodeRemoteReply;
        try {
          // VM callbacks arrive on the socket, outside the code mode ALS context. Re-enter the
          // codemode span so nested calls, and the RPC spans they issue, keep their parent.
          reply = codemodeSpan === undefined
            ? await exchange(messages)
            : await codemodeSpan.run(() => exchange(messages));
        } catch (error) {
          batchFailure = error;
          return;
        }
        // A batch without a call is output only; the host's exchange answered null and the runner
        // expects no reply. Anything else means the two sides disagree about the protocol.
        if (callId === undefined) {
          if (reply !== null) batchFailure = new Error("The code mode host answered a batch that carried no call");
          return;
        }
        // A missing reply would leave the VM waiting forever; stop is the honest terminal answer.
        const answer = reply ?? { type: "stop" as const };
        // Replies leave in arrival order, so a VM call that settles late cannot overtake one that
        // settled earlier and change what the script observes.
        const sent = replyChain.then(async () => {
          if (batchFailure !== undefined || rpcFailure !== undefined) return;
          try {
            await this.session.client.replyVm(this.session.sessionId, { callId, reply: answer });
          } catch (error) {
            batchFailure = error;
          }
        });
        replyChain = sent.catch((error: unknown) => {
          batchFailure ??= error;
        });
        await sent;
      })();
      deliveries.add(delivery);
      void delivery.then(
        () => deliveries.delete(delivery),
        (error: unknown) => {
          batchFailure ??= error;
          deliveries.delete(delivery);
        },
      );
    };
    let handle;
    try {
      handle = span === undefined
        ? this.session.client.startVm(this.session.sessionId, payload, {
            deadlineMs: this.deadlineMs,
            jobId: this.session.jobId,
            onVmMessage,
          })
        : span.run(() => this.session.client.startVm(this.session.sessionId, payload, {
            deadlineMs: this.deadlineMs,
            jobId: this.session.jobId,
            onVmMessage,
          }));
    } catch (error) {
      span?.end(failureOutcome(error), { errorCode: failureCode(error) });
      throw error;
    }
    this.session.registerVm(() => {
      void handle.cancel("the code mode call ended").catch(() => undefined);
    });
    try {
      await handle.result;
    } catch (error) {
      rpcFailure = error;
    }
    // The VM stopped, so no batch will arrive again; wait for the deliveries it produced before
    // attributing a failure and closing the session.
    while (deliveries.size > 0) await Promise.allSettled([...deliveries]);
    await replyChain;
    this.session.registerVm(undefined);
    const failure = rpcFailure ?? batchFailure;
    if (failure !== undefined) {
      span?.end(failureOutcome(failure), { errorCode: failureCode(failure) });
      await handle.cancel("the code mode execution failed").catch(() => undefined);
      throw failure;
    }
    if (runnerFailure === undefined) span?.end("ok");
    else span?.end("error", { errorCode: `RUNNER_${runnerFailure.toUpperCase()}`.slice(0, 128) });
  }
}

/** Outcome and code for an RPC failure: cancellation is aborted, a lost connection is unknown. */
function failureOutcome(error: unknown): TraceOutcome {
  if (error instanceof RpcClientError && error.code === "aborted") return "aborted";
  return error instanceof RpcClientError && error.options.outcome === "unknown" ? "unknown" : "error";
}

function failureCode(error: unknown): string {
  if (error instanceof RpcClientError) return error.code.slice(0, 128);
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.slice(0, 128);
  }
  return "TRACE_ERROR";
}

/** Summarize one runner message without retaining arguments, output text or error messages. */
function runnerMessageFields(message: CodemodeRemoteMessage): TraceFields | undefined {
  switch (message.type) {
    case "call":
      return { runnerEvent: "call", target: message.target, tool: message.name.slice(0, 128), argsBytes: stringBytes(message.args) };
    case "output":
      return { runnerEvent: "output", itemType: message.item.type };
    case "done":
      return message.ok
        ? { runnerEvent: "done", ok: true, valueBytes: stringBytes(message.value) }
        : { runnerEvent: "done", ok: false, errorBytes: stringBytes(message.error) };
    case "crash":
      return { runnerEvent: "crash", messageBytes: stringBytes(message.message) };
    case "started":
      return { runnerEvent: "started", fingerprint: message.fingerprint.slice(0, 64) };
    case "idle":
      return { runnerEvent: "idle", seq: message.seq, issued: message.issued };
    case "failure":
      return { runnerEvent: "failure", errorKind: message.error.kind };
  }
}

export type SessionBoundSandboxOptions = {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
};

/**
 * A remote sandbox whose VM belongs to the PTC session bound around the code mode tool call.
 * The binding is an `AsyncLocalStorage` value set before the sandbox starts the VM, so a concurrent
 * call in another conversation can never be handed this call's session.
 */
export class SessionBoundCodemodeSandbox extends RemoteCodemodeSandbox {
  readonly #bound: AsyncLocalStorage<PtcSession>;

  constructor(options: SessionBoundSandboxOptions) {
    const holder: { current?: AsyncLocalStorage<PtcSession> } = {};
    super({
      timeoutMs: options.timeoutMs,
      memoryLimitBytes: options.memoryLimitBytes,
      remote: () => {
        const session = holder.current?.getStore();
        if (session === undefined) return new MissingSessionRemote();
        const deadlineMs = Math.min(RPC_MAX_DEADLINE_MS, options.timeoutMs + VM_DEADLINE_SLACK_MS);
        return new RpcCodemodeRemote(session, deadlineMs);
      },
    });
    this.#bound = new AsyncLocalStorage<PtcSession>();
    holder.current = this.#bound;
  }

  bind<T>(session: PtcSession, run: () => T): T {
    return this.#bound.run(session, run);
  }
}

export type PtcGatewayOptions = {
  readonly rpc: RpcClientConfig;
  readonly sandbox: SessionBoundCodemodeSandbox;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
  /**
   * A connected client shared with the agent's direct environment, when the transport already built
   * one. The owner closes it; the gateway must not close a connection it does not own.
   */
  readonly client?: RpcExecutionClient;
  /** Test seam; production connects with mutual TLS or the host socket. */
  readonly connect?: (config: RpcClientConfig) => Promise<RpcExecutionClient>;
  readonly now?: () => number;
  readonly log?: (event: Record<string, unknown>) => void;
};

type TrackedSession = {
  readonly session: PtcSession;
  close(): Promise<void>;
};

export class PtcGateway {
  readonly #options: PtcGatewayOptions;
  readonly #sandbox: SessionBoundCodemodeSandbox;
  readonly #sessions = new Map<TaskId, TrackedSession>();
  #client: RpcExecutionClient | undefined;
  #connecting: Promise<RpcExecutionClient> | undefined;
  /** Injected clients belong to their owner; only a client this gateway connected is closed here. */
  #ownsClient = false;

  constructor(options: PtcGatewayOptions) {
    this.#options = options;
    this.#sandbox = options.sandbox;
    this.#client = options.client;
  }

  /** Fail closed at startup when the agent is unreachable or does not advertise PTC and file tools. */
  async start(): Promise<void> {
    const client = await this.#clientHandle();
    const health = await client.health();
    if (health.protocol !== 1 || health.ptc !== true || health.fileTools !== true) {
      throw new Error("The execution agent does not support the PTC sandbox with file tools");
    }
  }

  async #clientHandle(): Promise<RpcExecutionClient> {
    if (this.#client !== undefined) return this.#client;
    this.#connecting ??= (async () => {
      const connect = this.#options.connect ?? connectRpcClient;
      const client = await connect(this.#options.rpc);
      this.#client = client;
      this.#ownsClient = true;
      return client;
    })();
    try {
      return await this.#connecting;
    } catch (error) {
      this.#connecting = undefined;
      throw error;
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #log(event: Record<string, unknown>): void {
    this.#options.log?.(event);
  }

  /** Open the session for one code mode task; the durable job record gates workspace reuse. */
  async openSession(api: ToolExecutionApi, context: Context): Promise<TrackedSession> {
    const task = await api.getTask(api.taskId, context);
    if (task === undefined) throw new Error("The code mode task is not available");
    const input = taskInputRecord(task.input);
    if (input?.kind !== "model") {
      throw new Error("The code mode tool cannot be called from a script; start it from the model instead");
    }
    if (this.#sessions.has(api.taskId)) {
      throw new Error("A PTC session already exists for this code mode task");
    }
    const client = await this.#clientHandle();
    const jobId = derivePtcJobId(api.conversationId, api.taskId);
    const now = this.#now();
    const job = await api.commit(
      async (tx) => await ensurePtcJobInTx(tx, api.conversationId, initialPtcJob(jobId, now)),
      context,
    );
    const sessionId = randomBytes(8).toString("hex");
    let opened = false;
    try {
      const openedSession = await client.openSession(sessionId, {
        jobId,
        workspaceReady: job.workspaceReady,
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      });
      opened = true;
      if (openedSession.workspaceReady === undefined) {
        throw new Error("The execution agent did not report the workspace state");
      }
      if (!job.workspaceReady) {
        if (!openedSession.workspaceReady.created) {
          // A crashed attempt may have left files; they belong to the same job and stay available.
          this.#log({ event: "ptc.workspace.reused", jobId });
        }
        await api.commit(
          async (tx) => await markPtcWorkspaceReady(tx, api.conversationId, jobId, this.#now()),
          context,
        );
      }
    } catch (error) {
      if (opened) {
        await client.closeSession(sessionId).catch(() => undefined);
      }
      throw error;
    }

    let vmCancel: (() => void) | undefined;
    let closed = false;
    const session: PtcSession = {
      client: client as PtcRpcClient,
      sessionId,
      jobId,
      conversationId: api.conversationId,
      taskId: api.taskId,
      registerVm(cancel) {
        vmCancel = cancel;
        if (closed && cancel !== undefined) cancel();
      },
    };
    const tracked: TrackedSession = {
      session,
      close: async () => {
        closed = true;
        vmCancel?.();
        vmCancel = undefined;
        try {
          await client.closeSession(sessionId);
        } catch (error) {
          const code = error instanceof RpcClientError ? error.code : "unknown";
          this.#log({ event: "ptc.session.close_failed", jobId, code });
        }
      },
    };
    this.#sessions.set(session.taskId, tracked);
    return tracked;
  }

  async closeSession(tracked: TrackedSession): Promise<void> {
    if (this.#sessions.get(tracked.session.taskId) === tracked) {
      this.#sessions.delete(tracked.session.taskId);
    }
    await tracked.close();
  }

  /** The session a nested call belongs to, resolved from its parent task only. */
  #sessionForParent(parent: TaskId): PtcSession | undefined {
    return this.#sessions.get(parent)?.session;
  }

  /** Wrap the code mode tool so its whole execution runs inside one bound PTC session. */
  wrapCodemodeTool(tool: ToolRegistration): ToolRegistration {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (args, api, context) => {
        const tracked = await this.openSession(api, context);
        try {
          return await this.#sandbox.bind(tracked.session, () => execute(args, api, context));
        } finally {
          await this.closeSession(tracked);
        }
      },
    };
  }

  /**
   * Route nested `bash`/`read`/`write`/`edit` calls through the session's VM. A model-issued call
   * keeps the environment the host built for it; a nested call always gets the PTC environment or
   * fails closed. File tools run inside the runner, so their paths never resolve on the control plane.
   */
  wrapScriptTools(extension: Extension): Extension {
    if (extension.tools === undefined) return extension;
    return {
      ...extension,
      tools: extension.tools.map((tool) => {
        if (tool.name === "bash") return this.#wrapBash(tool);
        if (NESTED_FILE_TOOLS.has(tool.name)) return this.#wrapNestedFileTool(tool);
        return tool;
      }),
    };
  }

  /** A nested call names its parent task; a model call has no `nested` input and keeps its env. */
  async #resolveNested(
    api: ToolExecutionApi,
    context: Context,
  ): Promise<{ readonly session: PtcSession; readonly callId: number } | undefined> {
    const task = await api.getTask(api.taskId, context);
    const input = task === undefined ? undefined : taskInputRecord(task.input);
    if (input?.kind !== "nested") return undefined;
    const parent = taskIdOrUndefined(input.parent);
    const session = parent === undefined ? undefined : this.#sessionForParent(parent);
    if (session === undefined) {
      throw new Error("No active PTC session for this nested call");
    }
    const callId = parseNestedCallKey(typeof input.key === "string" ? input.key : undefined);
    if (callId === undefined) {
      throw new Error("The nested call key is not a PTC VM call id");
    }
    return { session, callId };
  }

  #executionEnv(api: ToolExecutionApi, session: PtcSession, callId: number): PtcExecutionEnv {
    return new PtcExecutionEnv({
      session,
      callId,
      cwd: PTC_WORKSPACE_PATH,
      defaultTimeoutSeconds: this.#options.defaultTimeoutSeconds,
      maxTimeoutSeconds: this.#options.maxTimeoutSeconds,
      onOutputRef: async (ref, commitContext) => {
        await api.commit(
          async (tx) => await appendPtcOutputInTx(
            tx,
            api.conversationId,
            session.jobId,
            ref as PtcOutputRef,
            this.#now(),
          ),
          commitContext,
        );
      },
    });
  }

  #wrapBash(tool: ToolRegistration): ToolRegistration {
    const execute = tool.execute;
    return {
      ...tool,
      structuredOutputSchema: PTC_BASH_STRUCTURED_OUTPUT_SCHEMA,
      execute: async (args, api, context) => {
        const nested = await this.#resolveNested(api, context);
        if (nested === undefined) return execute(args, api, context);
        const env = this.#executionEnv(api, nested.session, nested.callId);
        const result = await execute(args, { ...api, env }, context);
        return withPtcBashOutput(result, env.outputRef, env.spillTruncated);
      },
    };
  }

  #wrapNestedFileTool(tool: ToolRegistration): ToolRegistration {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (args, api, context) => {
        const nested = await this.#resolveNested(api, context);
        if (nested === undefined) return execute(args, api, context);
        return execute(args, { ...api, env: this.#executionEnv(api, nested.session, nested.callId) }, context);
      },
    };
  }

  /** Close every open session, then the connection this gateway connected (never an injected one). */
  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((tracked) => tracked.close()));
    const client = this.#client;
    const owns = this.#ownsClient;
    this.#client = undefined;
    this.#connecting = undefined;
    this.#ownsClient = false;
    if (owns) await client?.close();
  }
}

function withPtcBashOutput(
  result: ToolExecutionResult,
  outputRef: PtcToolCallResult["outputRef"] | undefined,
  spillTruncated: boolean,
): ToolExecutionResult {
  const structured = result.structuredOutput;
  if (!isPlainRecord(structured)) return result;
  return {
    ...result,
    structuredOutput: {
      ...structured,
      ...(outputRef === undefined ? {} : { outputRef }),
      spillTruncated,
    },
  };
}
