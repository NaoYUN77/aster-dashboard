import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_RESIDENT_TOOL_BUDGET_TOKENS, type McpFileConfig } from "./mcp-config.js";
import type { ToolRegistry } from "./tools.js";

export type ToolPinConfig = Pick<McpFileConfig, "tools" | "residentToolBudgetTokens">;

/** Apply before the first install: native registry replacements retain their original slots. */
export function orderedMcpExtensions(extensions: readonly Extension[]): Extension[] {
  return [...extensions].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map((extension) => ({ ...extension, tools: extension.tools === undefined ? undefined
      : [...extension.tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }));
}

/** Startup only, while scheduling is paused and health has been replayed. */
export function installMcpTools(
  registry: ToolRegistry,
  extensions: readonly Extension[],
  config: ToolPinConfig = {},
  log: (line: string) => void = console.error,
  recovering?: readonly string[],
): readonly string[] {
  const ordered = orderedMcpExtensions(extensions);
  for (const extension of ordered) registry.install(extension);
  const resident = registry.snapshot().tools().map(({ tool }) => tool)
    .filter((tool) => tool.deferred !== true && (tool.callers === undefined || tool.callers.includes("model")));
  const tokens = (tools: readonly ToolRegistration[]) => estimateTextTokens(JSON.stringify(tools.map(toToolDeclaration)));
  const budget = config.residentToolBudgetTokens ?? DEFAULT_RESIDENT_TOOL_BUDGET_TOKENS;
  const pins = new Set<string>();
  const requested = recovering ?? Object.keys(config.tools ?? {}).filter((name) => config.tools![name]!.pin).sort();
  for (const name of requested) {
    const record = registry.lookup(name);
    if (record?.source.kind !== "mcp") {
      log(`MCP pin ${name} rejected (TOOL_NOT_FOUND)`);
      continue;
    }
    if (record.source.server === "github") {
      log(`MCP pin ${name} rejected (GITHUB_PIN_FORBIDDEN)`);
      continue;
    }
    if (recovering === undefined && record.state !== "available") {
      log(`MCP pin ${name} rejected (TOOL_UNAVAILABLE)`);
      continue;
    }
    const tool = registry.snapshot().tools().find(({ tool }) => tool.name === name)!.tool;
    const total = tokens([...resident, tool]);
    // Recover the settled declaration set; a new budget cannot demote an unfinished run.
    if (recovering === undefined && total > budget) {
      log(`MCP pin ${name} rejected (TOOL_BUDGET_EXCEEDED: ${total} > ${budget} estimated tokens)`);
      continue;
    }
    pins.add(name);
    resident.push(tool);
    log(recovering === undefined ? `MCP pin ${name} accepted (${total}/${budget} estimated tokens)`
      : `MCP pin ${name} retained for recovery (TOOL_PIN_RECOVERY)`);
  }
  for (const extension of ordered) {
    if (!extension.tools?.some((tool) => pins.has(tool.name))) continue;
    registry.install({ ...extension, tools: extension.tools.map((tool) => {
      if (!pins.has(tool.name)) return tool;
      const { deferred: _deferred, ...resident } = tool;
      return resident;
    }) });
  }
  return [...pins];
}
