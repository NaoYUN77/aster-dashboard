// Host composition seams for the zero-setup runtime. These turn host-verified deployment facts
// into a frozen manifest, an integration registry, the model-facing integration tools, and the
// provisioning runtime's real health checks.
//
// Interface: `buildPlatformCapabilities()` is called once at startup BEFORE `openAgent()`, because
// its extension must be installed into the governed registry before the harness opens.
// `buildProvisioningRuntime()` is called after `openAgent()` when the registry and conversations
// exist. `createProvisioningStore()` adapts Inbox's durable claim/finish methods.
//
// Errors: an unverifiable workspace or transcript is a failed health check with an operator-facing
// reason, never a success. Credentials never appear in a reason or a log line.
//
// Security: the model's integration tools can only read connection state or record an authorization
// request; they cannot grant access. Tool execution still goes through the governed registry.

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import {
  IntegrationRegistry, createIntegrationExtension, type IntegrationStore,
} from "./integrations.js";
import {
  buildPlatformManifest, type PlatformDependencies, type PlatformManifest,
} from "./platform-capabilities.js";
import type {
  HealthCheck, HealthReport, ProvisioningRecord, ProvisioningRuntime,
  ProvisioningSettlement, ProvisioningStore,
} from "./bot-provisioner.js";
import type { ToolRegistry } from "./tools.js";
import type { CatalogProfile, ToolScope } from "./tool-catalog.js";

/** Host-derived deployment facts. `readConfig()` is the only producer. */
export type PlatformFacts = PlatformDependencies;

/**
 * The narrow agent surface provisioning needs. Declared here so the provisioner does not depend on
 * `openAgent`'s full return type; `main.ts` passes the real agent.
 */
export interface PlatformAgent {
  configureBot(input: {
    readonly botId: string;
    readonly conversationId?: string;
    readonly cwd: string;
    readonly channel?: "console";
    readonly prompt: string;
    readonly catalogProfile: CatalogProfile;
    readonly toolScope: ToolScope;
    readonly capabilityReasons?: ReadonlyMap<string, string>;
  }): Promise<{ readonly conversationId: string; readonly tools: readonly string[] }>;
  /** Reading a conversation's history proves the durable transcript exists and is readable. */
  history(conversationId: string, limit: number): Promise<unknown>;
}

/** Inbox implements these with `BEGIN IMMEDIATE`; the provisioner never opens a database itself. */
export interface ProvisioningPersistence {
  claimProvisioning(botId: string, fingerprint: string, startedAt: string): ProvisioningRecord;
  finishProvisioning(botId: string, result: ProvisioningSettlement): ProvisioningRecord;
  provisioning(botId: string): ProvisioningRecord | undefined;
  provisioningRecords(): readonly ProvisioningRecord[];
}

export function createProvisioningStore(db: ProvisioningPersistence): ProvisioningStore {
  return Object.freeze({
    claim: (botId: string, fingerprint: string, startedAt: string) =>
      db.claimProvisioning(botId, fingerprint, startedAt),
    finish: (botId: string, result: ProvisioningSettlement) =>
      db.finishProvisioning(botId, result),
    record: (botId: string) => db.provisioning(botId),
    records: () => db.provisioningRecords(),
  });
}

/**
 * The result of `openAgent`'s real startup health probe of a remote execution face. A local
 * deployment needs none; an unverified face must never be presented as a working workspace.
 */
export type ExecutionProbe = {
  readonly mode: "ssh" | "rpc";
  readonly protocol: number | null;
  readonly executionId: string | null;
  readonly directBash: boolean | null;
  readonly fileTools: boolean | null;
  readonly sharedMode: "none" | "ro" | "rw" | null;
};

export type WorkspaceCheck = (cwd: string) => Promise<{ readonly ok: boolean; readonly reason: string }>;

/** A real local check: the directory exists and the host can write to it. */
export async function localWorkspaceCheck(cwd: string): Promise<{ readonly ok: boolean; readonly reason: string }> {
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) return { ok: false, reason: "工作区路径不是目录" };
    await access(cwd, constants.W_OK);
    return { ok: true, reason: "目录存在且可写" };
  } catch (error) {
    return { ok: false, reason: `工作区不可访问：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Fail-closed placeholder for a deployment that cannot probe a remote workspace. Supplying this
 * keeps a bot from ever claiming Ready on an unverified execution environment; the wiring must
 * replace it with a real execution-side probe before enabling a remote deployment.
 */
export async function unverifiableWorkspaceCheck(cwd: string): Promise<{ readonly ok: boolean; readonly reason: string }> {
  return {
    ok: false,
    reason: `远端工作区 ${cwd} 尚未接入执行面探针，无法校验；未判定为 Ready。`,
  };
}

/**
 * A remote deployment's workspace is a virtual path owned by the execution side. `openAgent()`
 * connects to that side and validates its `health.check` before returning; this check verifies the
 * recorded probe instead of trusting a configuration flag. A broker/ssh deployment has no file
 * primitives or writable shared workspace to verify, so it stays fail-closed and retryable.
 */
export function verifiedRemoteWorkspaceCheck(probe: ExecutionProbe | undefined): WorkspaceCheck {
  return async (cwd) => {
    if (probe === undefined || probe.mode !== "rpc") return unverifiableWorkspaceCheck(cwd);
    if (probe.protocol !== 1 || probe.directBash !== true || probe.fileTools !== true || probe.sharedMode !== "rw") {
      return {
        ok: false,
        reason: "远端执行面的启动健康检查不满足工作区要求（协议版本、命令执行、文件原语或可写共享区）；未判定为 Ready。",
      };
    }
    return {
      ok: true,
      reason: `执行面 ${probe.mode} 已通过启动健康检查；工作区 ${cwd} 由执行面按需创建。`,
    };
  };
}

export type PlatformCapabilities = {
  readonly manifest: PlatformManifest;
  readonly integrations: IntegrationRegistry;
  /** Install into the governed registry so `integration_*` is a core, catalog-filtered group. */
  readonly integrationExtension: Extension;
};

/** No browser or model input reaches this function; `facts` come from `readConfig()`. */
export function buildPlatformCapabilities(options: {
  readonly facts: PlatformFacts;
  readonly integrations: IntegrationStore;
  readonly now?: () => Date;
}): PlatformCapabilities {
  const manifest = buildPlatformManifest(options.facts, options.now);
  const integrations = new IntegrationRegistry(options.integrations);
  return Object.freeze({
    manifest,
    integrations,
    integrationExtension: createIntegrationExtension(integrations),
  });
}

const CORE_TOOLS: readonly string[] = Object.freeze(["current_time"]);

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export type ProvisioningRuntimeOptions = {
  readonly agent: PlatformAgent;
  readonly registry: ToolRegistry;
  readonly workspaceCheck: WorkspaceCheck;
  /** The bootstrap bot's durable root conversation id, for health verification after a restart. */
  readonly rootConversationId?: string;
  /** Host hook: persist the conversation id returned by configureBot onto the bot row. */
  readonly onConfigured?: (botId: string, conversationId: string) => void;
};

/**
 * Real checks, not a configuration echo: the workspace is present and writable, the durable
 * transcript is readable, and the core tools are available. A host that cannot verify one of these
 * must return ok:false with a reason instead of claiming success.
 */
export function buildProvisioningRuntime(options: ProvisioningRuntimeOptions): ProvisioningRuntime {
  const health = async (input: {
    readonly conversationId: string;
    readonly cwd: string;
  }): Promise<HealthReport> => {
    const checks: HealthCheck[] = [];

    if (!isAbsolute(input.cwd)) {
      checks.push({ name: "workspace", ok: false, reason: "工作区路径不是绝对路径" });
    } else {
      let result: { readonly ok: boolean; readonly reason: string };
      try {
        result = await options.workspaceCheck(input.cwd);
      } catch (error) {
        result = { ok: false, reason: `工作区校验异常：${reason(error)}` };
      }
      checks.push({ name: "workspace", ok: result.ok, reason: result.reason });
    }

    if (!/^[1-9]\d*$/.test(input.conversationId)) {
      checks.push({ name: "conversation", ok: false, reason: "缺少有效的持久会话 id" });
    } else {
      try {
        await options.agent.history(input.conversationId, 1);
        checks.push({ name: "conversation", ok: true, reason: "持久会话可读" });
      } catch (error) {
        checks.push({ name: "conversation", ok: false, reason: `持久会话不可读：${reason(error)}` });
      }
    }

    const missing = CORE_TOOLS.filter((name) => options.registry.lookup(name)?.state !== "available");
    checks.push({
      name: "core",
      ok: missing.length === 0,
      reason: missing.length === 0 ? "核心工具已注册且可用" : `核心工具不可用：${missing.join(", ")}`,
    });

    return Object.freeze({
      ok: checks.every((check) => check.ok),
      checks: Object.freeze(checks),
    });
  };

  return Object.freeze({
    configure: async (input: Parameters<ProvisioningRuntime["configure"]>[0]) => {
      // The root transcript is addressed by the literal "root" in configureBot, but its durable
      // numeric id is what a health check must read. Only the host performs this translation.
      const conversationId = input.conversationId !== undefined
        && input.conversationId === options.rootConversationId
        ? "root"
        : input.conversationId;
      const configured = await options.agent.configureBot({
        botId: input.botId,
        ...(conversationId === undefined ? {} : { conversationId }),
        cwd: input.cwd,
        channel: input.channel,
        prompt: input.prompt,
        catalogProfile: input.catalogProfile,
        toolScope: input.toolScope,
        capabilityReasons: input.capabilityReasons,
      });
      options.onConfigured?.(input.botId, configured.conversationId);
      return Object.freeze({
        conversationId: configured.conversationId,
        tools: Object.freeze([...configured.tools]),
      });
    },
    health,
  });
}
