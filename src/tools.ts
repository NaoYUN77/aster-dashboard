import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, GenerationTask, hook, type Extension, type Registry, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { argumentBytes, beginTrace, recordGeneration, recordRegistryDecision } from "./trace.js";
import { parseCatalogProfile, parseToolScope, scopeAllows, type CatalogProfile, type ToolScope } from "./tool-catalog.js";

export const currentTime = defineTool({
  name: "current_time",
  description: "Return the current time as an ISO 8601 UTC timestamp.",
  parameters: Type.Object({}, { additionalProperties: false }),
  replay: "safe",
  execute: async () => ({
    output: [{ type: "text", text: new Date().toISOString() }],
  }),
});

export const personalTools = defineExtension({
  name: "personal-tools",
  tools: [currentTime],
});

export type ToolSource =
  | { readonly kind: "builtin"; readonly extension: string }
  | { readonly kind: "mcp"; readonly server: string }
  | { readonly kind: "plugin"; readonly plugin: string };

/** Host metadata; never part of the model's tool parameters or declaration. */
export type ToolGovernance = {
  readonly source: ToolSource;
  readonly trust: "trusted" | "untrusted";
  readonly authz: "read" | "write";
  /** Canonical approved GitHub baseline fingerprint, including its approval version. */
  readonly githubApproval?: string;
};

export type GovernedTool = ToolRegistration & { readonly governance?: ToolGovernance };

export type ToolAvailability = "available" | "unavailable";

export type ToolRecord = ToolGovernance & {
  readonly name: string;
  readonly tier: 1 | 2;
  readonly replay: "safe" | "unsafe";
  readonly schemaHash: string;
  readonly state: ToolAvailability | "disabled";
};

/** Fixed by the host for one agent instance, including its recovered and nested calls. */
export type ToolAuthority = "owner" | "restricted";
export type ToolRegistryOptions = {
  readonly authority?: ToolAuthority;
  readonly log?: (line: string) => void;
};

export interface ToolRegistry extends Registry {
  /** Immutable registration metadata. Unknown/uninstalled names return undefined. */
  lookup(name: string): ToolRecord | undefined;
  records(): readonly ToolRecord[];
  setMcpAvailability(server: string, state: ToolAvailability): void;
  /** Bind the profile-resolved catalog to one durable conversation. */
  setConversationCatalog(
    conversationId: number,
    profile: CatalogProfile,
    scope: ToolScope,
    names: ReadonlySet<string>,
    /** Exact-name reasons for tools closed by an unavailable platform capability. */
    reasons?: ReadonlyMap<string, string>,
  ): void;
  /** Host-only switch; disabling does not remove declarations or alter replay policy. */
  setDisabled(name: string, disabled: boolean): void;
}

const READ_TOOLS = new Set(["read", "current_time", "working_read", "memory_search", "memory_read", "tool_search", "reminder_list"]);

function registration(extension: Extension, tool: GovernedTool): ToolRecord {
  const governance = tool.governance ?? {
    source: { kind: "builtin" as const, extension: extension.name },
    trust: "trusted" as const,
    authz: READ_TOOLS.has(tool.name) ? "read" as const : "write" as const,
  };
  // Object key order is not a schema change; array order is retained. TypeBox symbols are
  // deliberately excluded, just as they are from the JSON schema sent to the provider.
  const schema = JSON.stringify(tool.parameters, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return Object.freeze({
    name: tool.name,
    source: Object.freeze({ ...governance.source }),
    tier: tool.deferred ? 2 : 1,
    trust: governance.trust,
    replay: tool.replay ?? "unsafe",
    authz: governance.authz,
    ...(governance.githubApproval === undefined ? {} : { githubApproval: governance.githubApproval }),
    schemaHash: createHash("sha256").update(schema).digest("hex"),
    state: "available",
  });
}

function exposesToModel(tool: ToolRegistration): boolean {
  return tool.callers === undefined || tool.callers.includes("model");
}

export function createToolRegistry(
  extensions: readonly Extension[] = [CodingTools, personalTools],
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const registry = createRegistry();
  const authority = options.authority ?? "owner";
  const log = options.log ?? console.error;
  let records = new Map<string, ToolRecord>();
  let registrations = new Map<string, object>();
  // Whether the model surface currently declares the tool; a hidden tool stays registered for scripts.
  let modelCallable = new Map<string, boolean>();
  const availability = new Map<string, ToolAvailability>();
  const conversationCatalogs = new Map<number, {
    readonly profile: CatalogProfile;
    readonly scope: ToolScope;
    readonly names: ReadonlySet<string>;
    readonly reasons: ReadonlyMap<string, string>;
  }>();
  const disabled = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  type CallIdentity = Pick<ToolExecutionApi, "conversationId" | "taskId" | "callId">;
  function audit(name: string, call: CallIdentity, code: string, record?: ToolRecord) {
    log(JSON.stringify({ event: "tool_review", ...call, tool: name.slice(0, 128), authority,
      authz: record?.authz, state: record?.state, decision: code === "TOOL_ALLOWED" ? "allow" : "deny", code }));
    recordRegistryDecision({
      tool: name,
      decision: code === "TOOL_ALLOWED" ? "allow" : "deny",
      code,
      authority,
      conversationId: call.conversationId,
      taskId: call.taskId,
      ...(record?.authz === undefined ? {} : { authz: record.authz }),
      ...(record?.state === undefined ? {} : { state: record.state }),
    });
  }
  function review(name: string, call: CallIdentity, registration?: object): ToolExecutionResult | undefined {
    const record = records.get(name);
    const catalog = conversationCatalogs.get(call.conversationId);
    let code: string;
    let message: string;
    if (record === undefined) {
      code = "TOOL_NOT_FOUND";
      message = `Tool ${name} is not registered. Use an exact registered name from tool_search.`;
    } else if (registration !== undefined && registrations.get(name) !== registration) {
      code = "TOOL_REGISTRATION_CHANGED";
      message = `Tool ${name} changed after this call was admitted; the old implementation was not executed. Retry the request.`;
    } else if (catalog !== undefined && (!catalog.names.has(name) || !scopeAllows(catalog.scope, catalog.profile, name, record))) {
      const reason = catalog.reasons.get(name);
      code = reason === undefined ? "TOOL_SCOPE_DENIED" : "TOOL_CAPABILITY_UNAVAILABLE";
      message = reason ?? `Tool ${name} is outside this bot's catalog profile and tool scope; this call was not executed.`;
    } else if (record.state === "disabled") {
      code = "TOOL_DISABLED";
      message = `Tool ${name} is disabled; this call was not sent. Ask the owner to enable it.`;
    } else if (record.state === "unavailable") {
      code = "TOOL_UNAVAILABLE";
      const source = record.source.kind === "mcp" ? `MCP server ${record.source.server}` : `Tool ${name}`;
      message = `${source} is unavailable; this call was not sent. Restore the service and restart to reconnect.`;
    } else if (authority !== "owner" && record.authz !== "read") {
      code = "TOOL_AUTHZ_DENIED";
      message = `Tool ${name} requires ${record.authz} authority; this restricted agent permits read tools only. Ask the owner to perform this action.`;
    } else {
      audit(name, call, "TOOL_ALLOWED", record);
      return undefined;
    }
    audit(name, call, code, record);
    return {
      isError: true,
      output: [{ type: "text", text: message }],
      details: { code, ...(record?.source.kind === "mcp" ? { server: record.source.server } : {}), tool: name },
      diagnostics: [{ severity: "error", code, message }],
    };
  }
  // Unknown model calls never get a ToolTask in 1.3.0. Put the observer on every selectable
  // extension so an explicit extension list cannot accidentally remove the host review boundary.
  // The same response runs through each selected extension, so observe its object only once.
  const observed = new WeakSet<object>();
  const observer = hook(GenerationTask, {
    afterResponse(message, api) {
      if (observed.has(message)) return;
      observed.add(message);
      // One LLM generation per terminal provider message, attached to the active agent request.
      recordGeneration(message, api);
      if (message.stopReason !== "toolUse") return;
      for (const call of message.content) {
        if (call.type !== "toolCall") continue;
        const identity = { conversationId: api.conversationId, taskId: api.taskId, callId: call.id };
        if (!records.has(call.name)) review(call.name, identity);
        else if (modelCallable.get(call.name) === false) {
          // Registered but not declared to the model: leave the result to the base's
          // `tool_unavailable` settlement and record why the call could not run.
          audit(call.name, identity, "TOOL_NOT_EXPOSED", records.get(call.name));
        }
      }
    },
  });
  function executionTool(tool: GovernedTool, registration: object): ToolRegistration {
    return {
      ...tool,
      execute: async (args, api, context) => {
        context.abortSignal?.throwIfAborted();
        // The root trace starts before authorization so a denied codemode call is still observable.
        // The model's raw `code` argument is captured only when content capture is enabled; the script
        // actually handed to QuickJS is recorded separately under `codemode.prepared`.
        const script = args !== null && typeof args === "object"
          ? (args as { code?: unknown }).code
          : undefined;
        const root = tool.name === CODEMODE_TOOL_NAME
          ? beginTrace({
              conversationId: api.conversationId,
              taskId: api.taskId,
              callId: api.callId,
              name: "codemode",
              fields: { scriptBytes: argumentBytes(args) },
              ...(typeof script === "string" ? { input: { code: script } } : {}),
            })
          : undefined;
        const run = async () => {
          const rejected = review(tool.name, { conversationId: api.conversationId, taskId: api.taskId, callId: api.callId }, registration);
          if (rejected !== undefined) return rejected;
          return tool.execute(args, {
            ...api,
            executeTool: (name, args, context, options) => {
              // Native resolution rejects missing nested names before hooks or an executor can run.
              if (!records.has(name)) review(name, { conversationId: api.conversationId, taskId: api.taskId, callId: api.callId });
              return api.executeTool(name, args, context, options);
            },
            ...(tool.name === TOOL_SEARCH_TOOL_NAME ? {
              agent: async (context: Parameters<ToolExecutionApi["agent"]>[0]) => {
                const agent = await api.agent(context);
                const policy = conversationCatalogs.get(api.conversationId);
                return { ...agent, deferred: agent.deferred.filter(({ name }) =>
                  records.get(name)?.state === "available" && (policy === undefined || policy.names.has(name))) };
              },
            } : {}),
          }, context);
        };
        return root === undefined ? run() : root.run(run);
      },
    };
  }
  const result: ToolRegistry = {
    snapshot: () => registry.snapshot(),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    install(extension) {
      if (extension.wraps?.some((wrap) => "tool" in wrap)) {
        throw new Error(`Tool wrappers are not supported by the governed registry: ${extension.name}`);
      }
      const next = new Map<string, ToolRecord>();
      const nextRegistrations = new Map<string, object>();
      const nextModelCallable = new Map<string, boolean>();
      for (const installed of registry.snapshot().installed()) {
        if (installed.name === extension.name) continue;
        for (const tool of installed.tools ?? []) {
          next.set(tool.name, records.get(tool.name)!);
          nextRegistrations.set(tool.name, registrations.get(tool.name)!);
          nextModelCallable.set(tool.name, modelCallable.get(tool.name) ?? exposesToModel(tool));
        }
      }
      const installedTools: ToolRegistration[] = [];
      for (const tool of extension.tools ?? []) {
        // pi-durable permits shadowing across extensions; this application requires unique names.
        if (next.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
        const record = registration(extension, tool);
        const state = disabled.has(tool.name) ? "disabled"
          : record.source.kind === "mcp" ? availability.get(record.source.server) ?? "available" : "available";
        next.set(tool.name, state === record.state ? record : Object.freeze({ ...record, state }));
        const identity = {};
        nextRegistrations.set(tool.name, identity);
        nextModelCallable.set(tool.name, exposesToModel(tool));
        installedTools.push(executionTool(tool, identity));
      }
      registry.install({ ...extension, tools: installedTools, hooks: [...extension.hooks ?? [], observer] });
      records = next;
      registrations = nextRegistrations;
      modelCallable = nextModelCallable;
      notify();
    },
    uninstall(extension) {
      if (registry.snapshot().extension(extension.name) === undefined) return;
      const removed = registry.snapshot().extension(extension.name)!;
      registry.uninstall(extension);
      for (const tool of removed.tools ?? []) {
        records.delete(tool.name);
        registrations.delete(tool.name);
        modelCallable.delete(tool.name);
      }
      notify();
    },
    setConversationCatalog(conversationId, profile, scope, names, reasons) {
      conversationCatalogs.set(conversationId, {
        profile: parseCatalogProfile(profile),
        scope: parseToolScope(scope),
        names: new Set(names),
        reasons: new Map(reasons ?? []),
      });
    },
    setMcpAvailability(server, state) {
      availability.set(server, state);
      let changed = false;
      for (const [name, record] of records) {
        if (record.source.kind !== "mcp" || record.source.server !== server || disabled.has(name) || record.state === state) continue;
        records.set(name, Object.freeze({ ...record, state }));
        changed = true;
      }
      if (changed) notify();
    },
    setDisabled(name, value) {
      const record = records.get(name);
      if (record === undefined) throw new Error(`Tool ${name} is not registered`);
      if (value) disabled.add(name);
      else disabled.delete(name);
      const state = value ? "disabled"
        : record.source.kind === "mcp" ? availability.get(record.source.server) ?? "available" : "available";
      if (record.state === state) return;
      records.set(name, Object.freeze({ ...record, state }));
      notify();
    },
    lookup: (name) => records.get(name),
    records: () => Object.freeze(registry.snapshot().tools().map(({ tool }) => records.get(tool.name)!)),
  };
  const extensionNames = new Set<string>();
  for (const extension of extensions) {
    if (extensionNames.has(extension.name)) throw new Error(`Duplicate extension name: ${extension.name}`);
    extensionNames.add(extension.name);
    result.install(extension);
  }
  return result;
}
