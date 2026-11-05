import {
  defineExtension,
  hook,
  ToolTask,
  type Extension,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
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

function normalizeScript(code: string): string {
  return code.trim().replace(/\s+/g, " ");
}

/**
 * `(toolName, canonical arguments)`. Only the code mode script gets its source whitespace normalized,
 * because reformatting the same script is the same call; other arguments are compared as given.
 */
export function loopSignature(name: string, args: unknown): string {
  const normalized = name === CODEMODE_TOOL_NAME
    && args !== null
    && typeof args === "object"
    && !Array.isArray(args)
    && typeof (args as { code?: unknown }).code === "string"
    ? { ...(args as Record<string, unknown>), code: normalizeScript((args as { code: string }).code) }
    : args;
  return `${name}\u0000${canonicalJSON(normalized)}`;
}

export type LoopGuard = {
  readonly extension: Extension;
  /** Clear counts and any recorded halt; the call-ID memory survives, so a replay cannot double count. */
  reset(): void;
  /** The halt recorded by the current run, if any. The run boundary consumes it. */
  takeHalt(): AgentLoopDetectedError | undefined;
  /**
   * Install the host's run-level cancellation. Called once when a halt is recorded, from inside the
   * hook, which must return promptly; the host stops the run outside the hook.
   */
  setHaltHandler(handler: (error: AgentLoopDetectedError) => void): void;
};

/**
 * Bounded autonomous loop detection for model-issued tool calls.
 *
 * Consecutive identical signatures warn at 3-5 and halt at 6; six consecutive error results halt
 * regardless of signature. Nested calls belong to the code mode script and are excluded (its own
 * guard runs inside `serializeNestedCalls`). State is deliberately in memory: a restarted process
 * starts at zero rather than re-counting a transcript, and within one process an already observed
 * `callId` is counted once, so a replay cannot inflate the counters.
 */
export function createLoopGuard(log: (line: string) => void = console.error): LoopGuard {
  let lastSignature: string | undefined;
  let identicalCount = 0;
  let errorCount = 0;
  let halt: AgentLoopDetectedError | undefined;
  let haltHandler: ((error: AgentLoopDetectedError) => void) | undefined;
  const seen = new Set<string>();

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
    // A nested call is the script's control flow; the inner guard bounds it at its own boundary.
    if (call.parent !== undefined) return undefined;
    const key = `${api.conversationId}\u0000${call.id}`;
    if (seen.has(key)) return undefined;
    if (seen.size >= SEEN_CALLS_LIMIT) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.add(key);

    const signature = loopSignature(call.name, call.arguments);
    if (signature === lastSignature) identicalCount += 1;
    else {
      lastSignature = signature;
      identicalCount = 1;
    }
    errorCount = result.isError === true ? errorCount + 1 : 0;

    if (identicalCount >= LOOP_GUARD_HALT_AT) {
      if (halt === undefined) {
        halt = new AgentLoopDetectedError("repeated_call", call.name, identicalCount);
        audit("LOOP_GUARD_HALT", call, api, identicalCount, "repeated_call");
        try {
          haltHandler?.(halt);
        } catch {
          // A host cancellation failure must not turn the tool result into an exception.
        }
      }
      return undefined;
    }
    if (errorCount >= LOOP_GUARD_HALT_AT) {
      if (halt === undefined) {
        halt = new AgentLoopDetectedError("consecutive_errors", call.name, errorCount);
        audit("LOOP_GUARD_HALT", call, api, errorCount, "consecutive_errors");
        try {
          haltHandler?.(halt);
        } catch {
          // A host cancellation failure must not turn the tool result into an exception.
        }
      }
      return undefined;
    }
    if (identicalCount >= LOOP_GUARD_WARNING_AT) {
      audit("LOOP_GUARD_WARNING", call, api, identicalCount);
      return {
        ...result,
        output: [
          ...(result.output ?? []),
          {
            type: "text",
            text: `[Loop Guard Warning]: You have made the exact same tool call ${identicalCount} times consecutively. Do not repeat identical calls; inspect intermediate state or change your strategy.`,
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
    reset() {
      lastSignature = undefined;
      identicalCount = 0;
      errorCount = 0;
      halt = undefined;
    },
    takeHalt: () => halt,
    setHaltHandler(handler) {
      haltHandler = handler;
    },
  };
}
