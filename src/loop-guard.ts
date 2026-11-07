import {
  defineExtension,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { recordLoopGuard } from "./trace.js";

/** The first repeated signature that earns an explicit warning in the tool result. */
export const LOOP_GUARD_WARNING_AT = 3;
/** The repeated signature, or consecutive error count, that ends the run. */
export const LOOP_GUARD_HALT_AT = 6;
/** Upper bound on remembered call IDs; only a much larger replay could forget one. */
const SEEN_CALLS_LIMIT = 4096;

export type LoopGuardHaltReason = "repeated_call" | "consecutive_errors";

/**
 * A recognizable business failure: the run is answered with `AGENT_LOOP_DETECTED` while the durable
 * Session stays healthy, so the user's next request can start a fresh run.
 */
export class AgentLoopDetectedError extends Error {
  readonly code = "AGENT_LOOP_DETECTED";

  constructor(
    readonly reason: LoopGuardHaltReason,
    readonly tool: string,
    readonly count: number,
  ) {
    super(
      reason === "repeated_call"
        ? `Agent loop detected: tool "${tool}" was called ${count} times consecutively with identical arguments`
        : `Agent loop detected: ${count} consecutive tool calls failed (last tool "${tool}")`,
    );
    this.name = "AgentLoopDetectedError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Structural JSON with sorted object keys; JSON formatting whitespace never affects the result. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "undefined";
}

/** Tool name and structural arguments identify a repeated call. */
export function loopSignature(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJSON(args)}`;
}

export type LoopGuard = {
  readonly extension: Extension;
  /** Clear counts and any recorded halt; the call-ID memory survives, so a replay cannot double count. */
  reset(conversationId: ConversationId): void;
  /** The halt recorded by the current run, if any. The run boundary consumes it. */
  takeHalt(conversationId: ConversationId): AgentLoopDetectedError | undefined;
  /**
   * Install the host's run-level cancellation. Called once when a halt is recorded, from inside the
   * hook, which must return promptly; the host stops the run outside the hook.
   */
  setHaltHandler(handler: (error: AgentLoopDetectedError, conversationId: ConversationId) => void): void;
};

/** One conversation's run counters; independent so one bot's loop cannot halt another. */
type RunState = {
  lastSignature: string | undefined;
  identicalCount: number;
  errorCount: number;
  halt: AgentLoopDetectedError | undefined;
};

/**
 * Bounded autonomous loop detection for model-issued tool calls.
 *
 * Consecutive identical signatures warn at 3-5 and halt at 6; six consecutive error results halt
 * regardless of signature. Only top-level model calls contribute to these counters.
 * State is deliberately in memory: a restarted process
 * starts at zero rather than re-counting a transcript, and within one process an already observed
 * `callId` is counted once, so a replay cannot inflate the counters.
 */
export function createLoopGuard(log: (line: string) => void = console.error): LoopGuard {
  const runs = new Map<ConversationId, RunState>();
  let haltHandler: ((error: AgentLoopDetectedError, conversationId: ConversationId) => void) | undefined;
  const seen = new Set<string>();

  function stateOf(conversationId: ConversationId): RunState {
    let state = runs.get(conversationId);
    if (state === undefined) {
      state = { lastSignature: undefined, identicalCount: 0, errorCount: 0, halt: undefined };
      runs.set(conversationId, state);
    }
    return state;
  }

  function audit(code: "LOOP_GUARD_WARNING" | "LOOP_GUARD_HALT", call: ToolHookCall, api: HookApi, count: number, reason?: LoopGuardHaltReason): void {
    log(JSON.stringify({
      event: "loop_guard",
      conversationId: api.conversationId,
      taskId: api.taskId,
      callId: call.id,
      tool: call.name.slice(0, 128),
      count,
      ...(reason === undefined ? {} : { reason }),
      code,
    }));
    recordLoopGuard({
      conversationId: api.conversationId,
      taskId: api.taskId,
      callId: call.id,
      tool: call.name,
      count,
      ...(reason === undefined ? {} : { reason }),
    }, code);
  }

  function observe(call: ToolHookCall, result: ToolExecutionResult, api: HookApi): ToolExecutionResult | undefined {
    // Count only top-level model calls.
    if (call.parent !== undefined) return undefined;
    const key = `${api.conversationId}\u0000${call.id}`;
    if (seen.has(key)) return undefined;
    if (seen.size >= SEEN_CALLS_LIMIT) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.add(key);

    const state = stateOf(api.conversationId);
    const signature = loopSignature(call.name, call.arguments);
    if (signature === state.lastSignature) state.identicalCount += 1;
    else {
      state.lastSignature = signature;
      state.identicalCount = 1;
    }
    state.errorCount = result.isError === true ? state.errorCount + 1 : 0;

    if (state.identicalCount >= LOOP_GUARD_HALT_AT) {
      if (state.halt === undefined) {
        state.halt = new AgentLoopDetectedError("repeated_call", call.name, state.identicalCount);
        audit("LOOP_GUARD_HALT", call, api, state.identicalCount, "repeated_call");
        try {
          haltHandler?.(state.halt, api.conversationId);
        } catch {
          // A host cancellation failure must not turn the tool result into an exception.
        }
      }
      return undefined;
    }
    if (state.errorCount >= LOOP_GUARD_HALT_AT) {
      if (state.halt === undefined) {
        state.halt = new AgentLoopDetectedError("consecutive_errors", call.name, state.errorCount);
        audit("LOOP_GUARD_HALT", call, api, state.errorCount, "consecutive_errors");
        try {
          haltHandler?.(state.halt, api.conversationId);
        } catch {
          // A host cancellation failure must not turn the tool result into an exception.
        }
      }
      return undefined;
    }
    if (state.identicalCount >= LOOP_GUARD_WARNING_AT) {
      audit("LOOP_GUARD_WARNING", call, api, state.identicalCount);
      return {
        ...result,
        output: [
          ...(result.output ?? []),
          {
            type: "text",
            text: `[Loop Guard Warning]: You have made the exact same tool call ${state.identicalCount} times consecutively. Do not repeat identical calls; inspect intermediate state or change your strategy.`,
          },
        ],
      };
    }
    return undefined;
  }

  const extension = defineExtension({
    name: "loop-guard",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result, api) => observe(call, result, api),
      }),
    ],
  });

  return {
    extension,
    reset(conversationId) {
      runs.set(conversationId, {
        lastSignature: undefined,
        identicalCount: 0,
        errorCount: 0,
        halt: undefined,
      });
    },
    takeHalt: (conversationId) => runs.get(conversationId)?.halt,
    setHaltHandler(handler) {
      haltHandler = handler;
    },
  };
}
