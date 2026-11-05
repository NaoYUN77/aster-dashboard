import { stripTypeScriptTypes } from "node:module";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox, type CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import { CODEMODE_OPTIONS_PREFIX } from "@earendil-works/pi-codemode/source";
import type { CodemodeConfig } from "./config.js";
import type { RpcExecutionClient } from "./execution/rpc-client.js";
import { loopSignature } from "./loop-guard.js";
import { PtcGateway, SessionBoundCodemodeSandbox } from "./ptc-gateway.js";
import { argumentBytes, nestedToolResultContent, stringBytes, traceChild } from "./trace.js";

/**
 * The script's result is the only thing that enters the conversation, so cap it well below the
 * base tool's 4 MiB. The tail keeps a script's final summary and errors.
 */
export const CODEMODE_OUTPUT_LIMITS = { maxBytes: 32 * 1024, maxLines: 1_000, retain: "tail" } as const;

/** File tools are usable inside scripts only when the execution environment is local. */
export const LOCAL_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);
/** Remote execution exposes the same tools; file primitives run inside the PTC sandbox. */
export const REMOTE_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

/** The nested loop that ends one script; it never reaches the 240 s sandbox deadline. */
export const NESTED_LOOP_LIMIT = 6;

/** Returned when a successful script never produced model-visible output. */
export const NO_TEXT_OUTPUT =
  "[Script finished with no text() output. In script-first mode, return values and raw console logs are not sent to context—call text(summary) explicitly to output your filtered result.]";

/** A rejected nested call is classified by its host code, never by its message text. */
function nestedErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.slice(0, 128);
  }
  return error instanceof Error && error.name === "AbortError" ? "ABORTED" : "TOOL_ERROR";
}

function nestedResultCode(result: { readonly details?: unknown; readonly diagnostics: readonly { readonly code?: string }[] }): string {
  const details = result.details;
  if (details !== null && typeof details === "object") {
    const code = (details as { code?: unknown }).code;
    if (typeof code === "string") return code.slice(0, 128);
  }
  for (const diagnostic of result.diagnostics) {
    if (typeof diagnostic.code === "string") return diagnostic.code.slice(0, 128);
  }
  return "TOOL_ERROR";
}

/** Wrapper markers used only to let Node parse a script that starts with top-level `return`. */
const TYPES_PREFIX = "async function __aster_types__() {\n";
const TYPES_SUFFIX = "\n}";

export type CodemodeHost = {
  readonly extension: Extension;
  /** Prove the remote agent is usable before accepting work; a no-op in local mode. */
  start(): Promise<void>;
  /** Apply host tool wrappers; remote mode routes nested bash calls through the session's VM. */
  wrapScriptTools(extension: Extension): Extension;
  close(): Promise<void>;
};

/**
 * Hide every tool outside the script allowlist from scripts without removing it from the model.
 * A tools-only tool is closed to both callers instead of being promoted to the model by accident.
 */
export function restrictScriptTools(extension: Extension, allowed: ReadonlySet<string>): Extension {
  if (extension.tools === undefined) return extension;
  return {
    ...extension,
    tools: extension.tools.map((tool) => {
      if (allowed.has(tool.name)) return tool;
      const callers: readonly ("model" | "tools")[] = tool.callers ?? ["model", "tools"];
      return { ...tool, callers: callers.includes("model") ? ["model"] as const : [] as const };
    }),
  };
}

function splitOptions(code: string): { readonly options: string | undefined; readonly body: string } {
  const newline = code.indexOf("\n");
  const firstLine = (newline === -1 ? code : code.slice(0, newline)).replace(/\r$/, "");
  if (!firstLine.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX)) return { options: undefined, body: code };
  return { options: firstLine, body: newline === -1 ? "" : code.slice(newline + 1) };
}

/**
 * Strip TypeScript annotations while keeping the first-line `// @options` directive. A script's
 * top-level `return` is legal inside the code mode executor but not to the TypeScript parser, so
 * the body is stripped inside a function wrapper and its exact inner text is taken back out.
 * Any failure (including module `import`/`export`, which the wrapper deliberately leaves in place)
 * falls back to the original source so QuickJS reports the real syntax error.
 */
export function stripCodemodeTypes(code: string): string {
  const { options, body } = splitOptions(code);
  if (/(^|\n)[ \t]*(?:import|export)\b/.test(body)) return code;
  try {
    const stripped = stripTypeScriptTypes(`${TYPES_PREFIX}${body}${TYPES_SUFFIX}`, { mode: "strip" });
    const middle = stripped.slice(TYPES_PREFIX.length, stripped.length - TYPES_SUFFIX.length);
    return options === undefined ? middle : `${options}\n${middle}`;
  } catch {
    return code;
  }
}

/**
 * Discard a successful script's top-level `return` value. The result formatter would otherwise
 * append it to the model-visible output; in script-first mode `text()` is the only summary exit.
 * `exit()` and images remain explicit outputs.
 */
export function discardTopLevelReturn(code: string): string {
  const { options, body } = splitOptions(code);
  return `${options === undefined ? "" : `${options}\n`}await (async () => {\n${body}\n})();\n`;
}

/** Prepare model-written source before the base parser and QuickJS see it. */
export function prepareCodemodeScript(code: string, textOnly: boolean): string {
  const stripped = stripCodemodeTypes(code);
  return textOnly ? discardTopLevelReturn(stripped) : stripped;
}

const CONSOLE_BLOCK = /\n?<console_output>\n[\s\S]*?\n<\/console_output>/g;

function withoutConsole(output: NonNullable<ToolExecutionResult["output"]>): NonNullable<ToolExecutionResult["output"]> {
  const kept: NonNullable<ToolExecutionResult["output"]>[number][] = [];
  for (const item of output) {
    if (item.type !== "text") {
      kept.push(item);
      continue;
    }
    const text = item.text.replace(CONSOLE_BLOCK, "");
    if (text !== "") kept.push({ ...item, text });
  }
  return kept;
}

/**
 * On success, only `text()` and `image()` reach the model: console blocks and the implicit return
 * value are dropped, and a script with no explicit output gets the guidance message. A failed
 * script keeps everything staged before the error, plus the error stack, so the model can repair it.
 */
function applyTextOnlyContract(result: ToolExecutionResult): ToolExecutionResult {
  if (result.isError === true || result.output === undefined) return result;
  const [header, ...rest] = result.output;
  const content = withoutConsole(rest);
  if (content.length > 0) {
    return { ...result, output: header === undefined ? content : [header, ...content] };
  }
  return { ...result, output: [{ type: "text", text: NO_TEXT_OUTPUT }] };
}

/** Rewrite only the code mode tool's `code`; every other tool and argument shape is untouched. */
function prepareArgs(tool: ToolRegistration, args: unknown, textOnly: boolean): unknown {
  if (tool.name !== CODEMODE_TOOL_NAME || args === null || typeof args !== "object") return args;
  const code = (args as { code?: unknown }).code;
  if (typeof code !== "string") return args;
  const prepared = prepareCodemodeScript(code, textOnly);
  return prepared === code ? args : { ...(args as Record<string, unknown>), code: prepared };
}

/**
 * The trace name for one nested tool call. Tool names are already registry identifiers; replacing
 * anything else keeps an unexpected script-supplied name from becoming free-form span text.
 */
export function nestedToolObservationName(tool: string): string {
  const label = tool.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return `tool.${label.length === 0 ? "unknown" : label}`;
}

/**
 * Nested calls are tools, and ADR-0009 keeps tools in one round sequential. The QuickJS sandbox
 * starts every call as soon as the script makes it, so this wrapper queues them; `Promise.all`
 * still works, but the calls run one after another. The sandbox's own timeout ends the script
 * without aborting the request, so a call still running or waiting when the codemode call settles
 * is cancelled here instead of continuing after the script has ended.
 *
 * A script that issues six identical nested calls in a row (for example `while (true) await
 * tools.read(...)`) is rejected on the sixth call with a clear error, so the script ends at once
 * instead of waiting for the sandbox deadline. The code also carries the script-first output
 * contract when `textOnly` is set.
 */
export function serializeNestedCalls(
  tool: ToolRegistration,
  options: { readonly textOnly?: boolean } = {},
): ToolRegistration {
  const execute = tool.execute;
  const textOnly = options.textOnly === true;
  return {
    ...tool,
    execute: async (args, api, context) => {
      const script = new AbortController();
      let queue: Promise<unknown> = Promise.resolve();
      let lastSignature: string | undefined;
      let identicalCount = 0;
      try {
        const prepared = prepareArgs(tool, args, textOnly) as typeof args;
        // The codemode observation's input is the model's raw argument. Record what preprocessing
        // actually handed to QuickJS as a separate child so the two scripts are never conflated.
        if (tool.name === CODEMODE_TOOL_NAME && args !== null && typeof args === "object") {
          const raw = (args as { code?: unknown }).code;
          const executed = prepared !== null && typeof prepared === "object"
            ? (prepared as { code?: unknown }).code
            : undefined;
          if (typeof raw === "string" && typeof executed === "string") {
            const scriptSpan = traceChild("codemode.prepared", {
              scriptBytes: stringBytes(executed),
              scriptChanged: executed !== raw,
            }, "span", { code: executed });
            scriptSpan?.end("ok");
          }
        }
        const result = await execute(prepared, {
          ...api,
          executeTool: (name, nestedArgs, nestedContext, options) => {
            const signature = loopSignature(name, nestedArgs);
            if (signature === lastSignature) identicalCount += 1;
            else {
              lastSignature = signature;
              identicalCount = 1;
            }
            // The trace observes the call boundary: name, argument size, item count and error code.
            // With content capture enabled it also carries the arguments and result, after redaction.
            const span = traceChild(nestedToolObservationName(name), {
              tool: name.slice(0, 128),
              argsBytes: argumentBytes(nestedArgs),
            }, "tool", { tool: name, arguments: nestedArgs });
            if (identicalCount >= NESTED_LOOP_LIMIT) {
              span?.end("error", { errorCode: "NESTED_LOOP_DETECTED" }, {
                isError: true,
                code: "NESTED_LOOP_DETECTED",
              });
              return Promise.reject(new Error(
                `Nested tool loop detected: tool "${name}" called ${NESTED_LOOP_LIMIT} times consecutively with identical arguments`,
              ));
            }
            const start = queue.then(() => {
              nestedContext.abortSignal?.throwIfAborted();
              script.signal.throwIfAborted();
              return span === undefined
                ? api.executeTool(name, nestedArgs, withAbortSignal(script.signal, nestedContext), options)
                : span.run(() => api.executeTool(name, nestedArgs, withAbortSignal(script.signal, nestedContext), options));
            });
            const observed = start.then(
              (result) => {
                const errorCode = result.isError ? nestedResultCode(result) : undefined;
                span?.end(result.isError ? "error" : "ok", {
                  isError: result.isError,
                  structuredBytes: stringBytes(result.structuredOutput),
                  diagnosticCount: result.diagnostics.length,
                  ...(errorCode === undefined ? {} : { errorCode }),
                }, nestedToolResultContent(result));
                return result;
              },
              (error: unknown) => {
                const errorCode = nestedErrorCode(error);
                span?.end("error", { errorCode }, { isError: true, code: errorCode });
                throw error;
              },
            );
            queue = observed.then(() => undefined, () => undefined);
            return observed;
          },
        }, context);
        return textOnly && tool.name === CODEMODE_TOOL_NAME ? applyTextOnlyContract(result) : result;
      } finally {
        script.abort(new Error("The code mode script ended"));
      }
    },
  };
}

/**
 * The base's code mode tool plus its QuickJS WASM sandbox. Scripts see only `tools.*`,
 * `ALL_TOOLS`, `text`/`image`/`exit`, `console`, `store`/`load`, and the discovery globals; no
 * filesystem, network, timers, or modules are exposed to the VM.
 *
 * Remote execution uses `SessionBoundCodemodeSandbox`: the VM runs on the execution agent and every
 * nested tool call is bridged back to the host through one PTC session per code mode call. `client`
 * lets the agent share its already connected RPC client; the gateway then never closes it.
 */
export function createCodemodeHost(config: CodemodeConfig, client?: RpcExecutionClient): CodemodeHost {
  let sandbox: CodemodeSandboxBase;
  let gateway: PtcGateway | undefined;
  if (config.ptc === undefined) {
    sandbox = new CodemodeSandbox({
      timeoutMs: config.timeoutMs,
      memoryLimitBytes: config.memoryLimitBytes,
    });
  } else {
    const bound = new SessionBoundCodemodeSandbox({
      timeoutMs: config.timeoutMs,
      memoryLimitBytes: config.memoryLimitBytes,
    });
    sandbox = bound;
    gateway = new PtcGateway({
      rpc: config.ptc.rpc,
      sandbox: bound,
      defaultTimeoutSeconds: config.ptc.defaultTimeoutSeconds,
      maxTimeoutSeconds: config.ptc.maxTimeoutSeconds,
      ...(client === undefined ? {} : { client }),
    });
  }
  const base = createCodemodeExtension({ sandbox, models: false });
  const extension = defineExtension({
    ...base,
    tools: (base.tools ?? []).map((tool) => {
      if (tool.name !== CODEMODE_TOOL_NAME) return tool;
      const serialized = serializeNestedCalls(
        { ...tool, outputLimits: CODEMODE_OUTPUT_LIMITS },
        { textOnly: config.scriptFirst },
      );
      return gateway === undefined ? serialized : gateway.wrapCodemodeTool(serialized);
    }),
  });
  let closing: Promise<void> | undefined;
  return {
    extension,
    start: async () => {
      await gateway?.start();
    },
    wrapScriptTools: (target) => gateway === undefined ? target : gateway.wrapScriptTools(target),
    close() {
      closing ??= (async () => {
        const results = await Promise.allSettled([
          sandbox.close(),
          gateway === undefined ? Promise.resolve() : gateway.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return closing;
    },
  };
}
