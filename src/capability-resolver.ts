// Capability Resolver: turn platform facts into the catalog switches one bot may actually use.
//
// Interface: `resolveCatalog()` is the single decision point between "a tool is registered" and
// "this bot may call it". It combines the platform manifest (defaults + availability), external
// integration state and the host's optional compatibility override, then returns a CatalogProfile,
// a ToolScope and exact-name denial reasons. `catalogFor()` and the registry's execution review
// remain the declaration and enforcement mechanisms; this module never executes a tool.
//
// Errors: an invalid override is rejected by parseCatalogProfile/parseToolScope. An unavailable
// capability is never silently promoted to available.
//
// Security: the override is host-only (tests and internal compatibility callers). The browser's
// zero-setup path never supplies it. A registered tool is not the same as an authorized tool.

import { parseCatalogProfile, parseToolScope, type CatalogProfile, type ToolScope } from "./tool-catalog.js";
import { capabilityById, type CapabilityId, type PlatformManifest } from "./platform-capabilities.js";
import type { IntegrationRegistry } from "./integrations.js";

type GroupName = "core" | "shell" | "files" | "web" | "ptc" | "memory" | "reminders" | "mcp";

const GROUP_CAPABILITY: Readonly<Record<GroupName, CapabilityId>> = Object.freeze({
  core: "core", shell: "computer", files: "workspace", web: "web", ptc: "computer",
  memory: "memory", reminders: "task", mcp: "integration",
});

/** Representative exact names, used only to give a caller a precise reason for a denial. */
const GROUP_TOOLS: Readonly<Record<GroupName, readonly string[]>> = Object.freeze({
  core: [], shell: ["bash"], files: [], web: ["web_search", "web_fetch"], ptc: ["codemode"],
  memory: ["memory_search", "memory_read", "working_read", "working_update"],
  reminders: ["reminder_create", "reminder_list", "reminder_cancel"],
  mcp: [],
});

export type ResolvedCatalog = {
  readonly profile: CatalogProfile;
  readonly scope: ToolScope;
  /** Exact-name reasons for tools closed by an unavailable platform capability. */
  readonly reasons: ReadonlyMap<string, string>;
  /** Capabilities reported as unavailable, for the console and the provisioning health check. */
  readonly unavailableCapabilities: readonly CapabilityId[];
};

export type ResolveInput = {
  readonly manifest: PlatformManifest;
  readonly integrations: IntegrationRegistry;
  /** Host-internal compatibility override; never accepted from the browser zero-setup path. */
  readonly override?: {
    readonly profile?: CatalogProfile;
    readonly scope?: ToolScope;
  };
};

export function resolveCatalog(input: ResolveInput): ResolvedCatalog {
  const manifest = input.manifest;
  const connected = input.integrations.connectedServices().size > 0;
  // Zero-setup defaults are internal: no browser field selects them. An external integration can
  // only widen the catalog after a real connection, which this phase never reports.
  const base = parseCatalogProfile({ ...manifest.defaults, mcp: manifest.defaults.mcp && connected });
  const override = input.override;
  const profile = parseCatalogProfile(override?.profile === undefined ? base : { ...base, ...override.profile });
  const scope = parseToolScope(override?.scope ?? { allow: [], deny: [] });

  const reasons = new Map<string, string>();
  const groups: GroupName[] = ["core", "shell", "files", "web", "ptc", "memory", "reminders", "mcp"];
  for (const group of groups) {
    if (profile[group]) continue;
    const capability = capabilityById(manifest, GROUP_CAPABILITY[group]);
    const reason = capability.state === "unavailable"
      ? `能力 ${capability.id} 不可用：${capability.reason}`
      : `平台默认未启用 ${group} 能力；该调用未执行。`;
    for (const name of GROUP_TOOLS[group]) reasons.set(name, reason);
  }

  return Object.freeze({
    profile,
    scope,
    reasons: new Map(reasons),
    unavailableCapabilities: Object.freeze(
      manifest.capabilities.filter((entry) => entry.state === "unavailable").map((entry) => entry.id),
    ),
  });
}
