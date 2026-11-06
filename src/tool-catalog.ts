import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolRecord } from "./tools.js";

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

export const CATALOG_GROUPS = ["core", "shell", "files", "web", "ptc", "memory", "reminders", "mcp"] as const;
type ToolGroup = typeof CATALOG_GROUPS[number];

/** Independent tool-group switches; every field is required. */
export type CatalogProfile = { readonly [Group in ToolGroup]: boolean };

export function parseCatalogProfile(value: unknown): CatalogProfile {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input) as unknown; } catch { throw new Error("Bot catalog profile is invalid JSON"); }
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Bot catalog profile must be an object");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !CATALOG_GROUPS.includes(key as ToolGroup))) throw new Error("Bot catalog profile has unknown fields");
  for (const group of CATALOG_GROUPS) {
    if (!Object.hasOwn(raw, group) || typeof raw[group] !== "boolean") throw new Error(`Bot catalog profile ${group} must be a boolean`);
  }
  return Object.freeze(Object.fromEntries(CATALOG_GROUPS.map((group) => [group, raw[group]])) as CatalogProfile);
}

export function serializeCatalogProfile(profile: CatalogProfile): string {
  return JSON.stringify(parseCatalogProfile(profile));
}

/** Explicit initial switches for the bootstrap bot and the console's creation form. */
export const DEFAULT_CATALOG_PROFILE: CatalogProfile = Object.freeze({
  core: true, shell: true, files: true, web: false, ptc: false,
  memory: true, reminders: true, mcp: true,
});

/** Preserve the legacy capability projection for older clients; deployment availability is a ceiling. */
export function legacyCapabilitiesForProfile(
  profile: CatalogProfile,
  deployment: { readonly ptc: boolean; readonly web: boolean },
): string {
  return [
    ...(profile.shell ? ["bash"] : []),
    ...(profile.files ? ["files"] : []),
    ...(profile.ptc && deployment.ptc ? ["ptc"] : []),
    ...(profile.web && deployment.web ? ["web"] : []),
  ].join(",");
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
  // Integration status and authorization requests are platform core, not external capabilities.
  if (name === "current_time" || name === "tool_search" || name.startsWith("integration_")) return "core";
  return undefined;
}

/**
 * Adapt the runtime registry (including tools/list declarations) into the effective catalog.
 * Unknown host tools are closed by default until assigned a catalog group.
 */
export function catalogFor(
  registrations: readonly { readonly tool: ToolRegistration; readonly record?: ToolRecord }[],
  profileInput: CatalogProfile,
  scopeInput: ToolScope,
): { readonly definitions: readonly ToolDefinition[]; readonly names: ReadonlySet<string> } {
  const profile = parseCatalogProfile(profileInput);
  const scope = parseToolScope(scopeInput);
  const allowed = new Set<string>();
  const definitions: ToolDefinition[] = [];
  for (const { tool, record } of registrations) {
    if (!scopeAllows(scope, profile, tool.name, record)) continue;
    allowed.add(tool.name);
    definitions.push(Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
  }
  return { definitions: Object.freeze(definitions), names: allowed };
}

export function scopeAllows(scope: ToolScope, profile: CatalogProfile, name: string, record?: ToolRecord): boolean {
  const group = groupFor(name, record);
  if (group === undefined || !profile[group]) return false;
  if (scope.allow.length > 0 && !scope.allow.includes(name)) return false;
  return !scope.deny.includes(name);
}
