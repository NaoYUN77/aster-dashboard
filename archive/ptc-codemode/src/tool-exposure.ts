import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type EntryId,
  type Extension,
  type Harness,
  type TaskInspection,
} from "@earendil-works/pi-durable";

/**
 * Tools the model must reach through codemode when script-first exposure is enabled. Scripts keep
 * their existing allowlist from `restrictScriptTools`; this set only governs model visibility.
 */
export const SCRIPT_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

/**
 * Narrow the model surface for the named tools. Only a tool whose callers already include
 * `"tools"` is changed, so hiding can never grant a new script capability, and a tool that is
 * already tools-only is left untouched.
 */
export function hideFromModel(extension: Extension, hiddenTools: ReadonlySet<string>): Extension {
  if (extension.tools === undefined) return extension;
  let changed = false;
  const tools = extension.tools.map((tool) => {
    if (!hiddenTools.has(tool.name)) return tool;
    const callers = tool.callers ?? ["model", "tools"];
    if (!callers.includes("tools")) return tool;
    if (callers.length === 1 && callers[0] === "tools") return tool;
    changed = true;
    return { ...tool, callers: ["tools"] as const };
  });
  return changed ? { ...extension, tools } : extension;
}

type ModelToolTaskInput = {
  readonly kind: "model";
  readonly assistant: EntryId;
  readonly callId: string;
};

function isModelToolInput(input: unknown): input is ModelToolTaskInput {
  if (input === null || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return value.kind === "model"
    && typeof value.assistant === "string"
    && typeof value.callId === "string";
}

/**
 * True while a live model-issued call to one of `names` is still unfinished. Such a call was
 * admitted under the previous tool exposure; hiding its tool now would turn a recoverable
 * interruption into `tool_unavailable`, so the caller keeps the old visibility for this run.
 */
export async function hasUnfinishedModelToolCalls(
  harness: Pick<Harness, "commit">,
  tasks: readonly Pick<TaskInspection, "record">[],
  names: ReadonlySet<string>,
  context: Context,
): Promise<boolean> {
  const matchingTasks = tasks.filter(({ record }) =>
    record.kind === "pi.tool" && isModelToolInput(record.input));
  if (matchingTasks.length === 0) return false;
  return harness.commit(async (tx) => {
    for (const { record } of matchingTasks) {
      const input = record.input;
      if (!isModelToolInput(input)) continue;
      const entry = await tx.entry(AssistantEntry, input.assistant);
      const message = entry?.model?.[0];
      if (message?.role !== "assistant") continue;
      const unfinished = message.content.some((item) =>
        item.type === "toolCall" && item.id === input.callId && names.has(item.name));
      if (unfinished) return true;
    }
    return false;
  }, context);
}
