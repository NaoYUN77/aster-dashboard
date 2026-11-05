import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { BotRole } from "./inbox.js";
import type { ToolRecord } from "./tools.js";

export type CatalogProfileId = "research" | "chief" | "programmer";
export type ToolScope = {
  /** Optional exact-name allowlist; empty means the profile defaults remain intact. */
  readonly allow: readonly string[];
  /** Exact-name denials, always applied after profile defaults and allow. */
  readonly deny: readonly string[];
};

/** The provider-neutral declaration shape shared by native and discovered MCP tools. */
export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

type ToolGroup = "core" | "shell" | "files" | "web" | "ptc" | "memory" | "reminders" | "mcp";

export type CatalogProfile = {
  readonly id: CatalogProfileId;
  /** Group selectors also cover tools discovered later through MCP tools/list. */
  readonly defaultTools: readonly ToolGroup[];
};

export const CATALOG_PROFILES: Readonly<Record<CatalogProfileId, CatalogProfile>> = Object.freeze({
  research: Object.freeze({ id: "research", defaultTools: ["core", "shell", "files", "web", "memory", "reminders", "mcp"] as const }),
  chief: Object.freeze({ id: "chief", defaultTools: ["core", "shell", "files", "memory", "reminders", "mcp"] as const }),
  programmer: Object.freeze({ id: "programmer", defaultTools: ["core", "shell", "files", "ptc", "memory", "reminders", "mcp"] as const }),
});

/** Existing roles are persisted as profiles; this is the single compatibility mapping. */
export function profileForRole(role: BotRole): CatalogProfileId {
  if (role === "researcher") return "research";
  if (role === "programmer") return "programmer";
  return "chief";
}

/** Preserve the legacy capability projection consumed by configureBot and older console clients. */
export function legacyCapabilitiesForRole(
  role: BotRole,
  deployment: { readonly ptc: boolean; readonly web: boolean },
): string {
  const names = ["bash", "files"];
  const profile = profileForRole(role);
  if (profile === "programmer" && deployment.ptc) names.push("ptc");
  if (profile === "research" && deployment.web) names.push("web");
  return names.join(",");
}

export function parseToolScope(value: unknown): ToolScope {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input) as unknown; } catch { throw new Error("Bot tool scope is invalid JSON"); }
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Bot tool scope must be an object");
  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "allow" && key !== "deny")) throw new Error("Bot tool scope has unknown fields");
  const names = (key: "allow" | "deny"): string[] => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || value.length > 256 || value.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name))) {
      throw new Error(`Bot tool scope ${key} must be a list of tool names`);
    }
    return [...new Set(value as string[])].sort();
  };
  const allow = names("allow");
  const deny = names("deny");
  return Object.freeze({ allow: Object.freeze(allow), deny: Object.freeze(deny) });
}

export function serializeToolScope(scope: ToolScope): string {
  return JSON.stringify(parseToolScope(scope));
}

function groupFor(name: string, record?: ToolRecord): ToolGroup | undefined {
  if (record?.source.kind === "mcp") return "mcp";
  if (name === "codemode") return "ptc";
  if (name === "web_search" || name === "web_fetch") return "web";
  if (name === "bash") return "shell";
  if (name === "read" || name === "write" || name === "edit") return "files";
  if (name.startsWith("memory_") || name.startsWith("working_")) return "memory";
  if (name.startsWith("reminder_")) return "reminders";
  if (name === "current_time" || name === "tool_search") return "core";
  return undefined;
}

/**
 * Adapt the runtime registry (including tools/list declarations) into catalog definitions and the
 * effective exact-name set. Unknown host tools are closed by default until assigned a catalog group.
 */
export function catalogFor(
  registrations: readonly { readonly tool: ToolRegistration; readonly record?: ToolRecord }[],
  profile: CatalogProfileId,
  scopeInput: ToolScope,
): { readonly definitions: readonly ToolDefinition[]; readonly names: ReadonlySet<string> } {
  const scope = parseToolScope(scopeInput);
  const groups = new Set(CATALOG_PROFILES[profile].defaultTools);
  const defaults = new Set<string>();
  const definitions: ToolDefinition[] = [];
  for (const { tool, record } of registrations) {
    const group = groupFor(tool.name, record);
    if (group === undefined || !groups.has(group)) continue;
    defaults.add(tool.name);
    definitions.push(Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
  }
  const allowed = new Set(scope.allow.length === 0 ? defaults : scope.allow.filter((name) => defaults.has(name)));
  for (const name of scope.deny) allowed.delete(name);
  return { definitions: Object.freeze(definitions), names: allowed };
}

export function scopeAllows(scopeInput: ToolScope, profile: CatalogProfileId, name: string, record?: ToolRecord): boolean {
  const scope = parseToolScope(scopeInput);
  const group = groupFor(name, record);
  if (group === undefined || !CATALOG_PROFILES[profile].defaultTools.includes(group)) return false;
  if (scope.allow.length > 0 && !scope.allow.includes(name)) return false;
  return !scope.deny.includes(name);
}

/** Legacy configureBot callers are mapped from capabilities; explicit profiles take precedence. */
export function profileForCapabilities(capabilities: readonly string[]): CatalogProfileId {
  if (capabilities.includes("ptc")) return "programmer";
  if (capabilities.includes("web")) return "research";
  return "chief";
}
