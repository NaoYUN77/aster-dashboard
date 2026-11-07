// External-integration state and the authorization request interface for the zero-setup phase.
//
// Interface: `IntegrationRegistry` owns the five third-party services the product may later
// connect. `request()` records an authorization request and returns an explicit pending result;
// `complete()` deliberately does not exist as a success path. `createIntegrationExtension()`
// exposes two read-only-ish tools so a model that needs GitHub can ask the user for authorization
// instead of inventing a connection.
//
// Errors: unknown service names, malformed request ids and any attempt to mark a service connected
// are host errors. No path in this module returns `connected: true` in this phase.
//
// Security: the registry never holds, reads or returns a credential. Connection state is durable
// host state, not a model parameter and not a tool parameter that can grant itself access.

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { StateError } from "./errors.js";
import type { GovernedTool } from "./tools.js";

export const INTEGRATION_IDS = ["github", "gmail", "google_calendar", "notion", "slack"] as const;
export type IntegrationId = typeof INTEGRATION_IDS[number];
export type IntegrationState = "disconnected" | "authorization_pending" | "connected";

export type IntegrationRow = {
  readonly service: IntegrationId;
  readonly state: IntegrationState;
  readonly reason: string;
  readonly requestId: string | null;
  readonly requestedAt: string | null;
  readonly updatedAt: string | null;
};

export type IntegrationView = {
  readonly service: IntegrationId;
  readonly state: IntegrationState;
  readonly reason: string;
  readonly requestId: string | null;
  readonly requestedAt: string | null;
  readonly authorization: {
    readonly implemented: false;
    readonly note: string;
  };
};

export type AuthorizationRequest = {
  readonly requestId: string;
  readonly service: IntegrationId;
  readonly state: "authorization_pending";
  readonly connected: false;
  readonly implementation: "not_implemented";
  readonly message: string;
};

/** Persistence boundary owned by Inbox; the registry holds no SQLite handle of its own. */
export interface IntegrationStore {
  integrations(): readonly IntegrationRow[];
  setIntegration(row: IntegrationRow): void;
}

const NOT_IMPLEMENTED = "本阶段未接入 OAuth 集成；授权请求只登记状态，不会建立或伪造连接。";

function parseService(value: unknown): IntegrationId {
  if (typeof value !== "string" || !INTEGRATION_IDS.includes(value as IntegrationId)) {
    throw new StateError("Unknown external integration");
  }
  return value as IntegrationId;
}

export class IntegrationRegistry {
  readonly #store: IntegrationStore;

  constructor(store: IntegrationStore) {
    this.#store = store;
  }

  /** Every service is present, including disconnected ones; the product never hides a gap. */
  list(): readonly IntegrationView[] {
    const rows = new Map(this.#store.integrations().map((row) => [row.service, row]));
    return Object.freeze(INTEGRATION_IDS.map((service) => {
      const row = rows.get(service);
      return Object.freeze({
        service,
        state: row?.state ?? "disconnected",
        reason: row?.reason ?? (service === "github"
          ? "GitHub 需要外部授权；目前未连接。"
          : "外部服务需要 OAuth 授权；目前未连接。"),
        requestId: row?.requestId ?? null,
        requestedAt: row?.requestedAt ?? null,
        authorization: Object.freeze({ implemented: false as const, note: NOT_IMPLEMENTED }),
      });
    }));
  }

  state(service: IntegrationId): IntegrationState {
    return this.list().find((entry) => entry.service === service)?.state ?? "disconnected";
  }

  /** No service is connected in this phase, so no MCP integration tool can be opened by default. */
  connectedServices(): ReadonlySet<IntegrationId> {
    return new Set(this.list().filter((entry) => entry.state === "connected").map((entry) => entry.service));
  }

  /**
   * Record one authorization request. The host generates the id (a stable downstream idempotency
   * key); the same request id always maps to the same row. It never returns `connected`.
   */
  request(service: unknown, now: () => Date = () => new Date()): AuthorizationRequest {
    const id = parseService(service);
    const requestId = `integration:${id}:${randomUUID()}`;
    const at = now().toISOString();
    this.#store.setIntegration({
      service: id,
      state: "authorization_pending",
      reason: `等待用户完成 ${id} 授权；${NOT_IMPLEMENTED}`,
      requestId,
      requestedAt: at,
      updatedAt: at,
    });
    return Object.freeze({
      requestId,
      service: id,
      state: "authorization_pending",
      connected: false,
      implementation: "not_implemented",
      message: `需要 ${id} 授权才能继续。${NOT_IMPLEMENTED} 请在平台完成带外授权后重试原任务；本次请求未连接任何外部服务。`,
    });
  }

  /** Fail closed: there is no implemented OAuth flow to complete in this phase. */
  complete(service: unknown): never {
    parseService(service);
    throw new StateError(`OAuth integration is not implemented: ${NOT_IMPLEMENTED}`);
  }
}

/**
 * Model-facing integration tools. They belong to the `core` catalog group, are always read-safe
 * in effect (one records a pending request), and never accept or return a credential.
 */
export function createIntegrationExtension(registry: IntegrationRegistry): Extension {
  const status = Object.assign(defineTool({
    name: "integration_status",
    description: "Check whether an external service (GitHub, Gmail, Google Calendar, Notion, Slack) is connected. Returns a durable host state, never a claim of success.",
    parameters: Type.Object({
      service: Type.Optional(Type.Union(INTEGRATION_IDS.map((id) => Type.Literal(id)))),
    }, { additionalProperties: false }),
    replay: "safe",
    execute: async (args) => {
      const service = args.service;
      const views = registry.list().filter((view) => service === undefined || view.service === service);
      return { output: [{ type: "text", text: JSON.stringify({ ok: true, integrations: views }) }] };
    },
  }), {
    governance: {
      source: { kind: "builtin" as const, extension: "integrations" },
      trust: "trusted" as const,
      authz: "read" as const,
    },
  }) satisfies GovernedTool;

  const request = Object.assign(defineTool({
    name: "integration_request",
    description: "Ask the user to authorize an external service before continuing a task. Only records an authorization request; it cannot connect the service.",
    parameters: Type.Object({
      service: Type.Union(INTEGRATION_IDS.map((id) => Type.Literal(id))),
      reason: Type.Optional(Type.String({ maxLength: 200 })),
    }, { additionalProperties: false }),
    replay: "unsafe",
    execute: async (args) => {
      const result = registry.request(args.service);
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  }), {
    governance: {
      source: { kind: "builtin" as const, extension: "integrations" },
      trust: "trusted" as const,
      authz: "write" as const,
    },
  }) satisfies GovernedTool;

  return defineExtension({ name: "integrations", tools: [status, request] });
}
