// The platform's internal, non-user-configurable capability manifest.
//
// Interface: `buildPlatformManifest()` turns host-verified deployment facts into a frozen manifest
// and the internal catalog switches every zero-setup bot receives. Nothing here reads a bot row, a
// request body or a model parameter. A capability that is not configured is reported as
// `unavailable` with an operator-facing reason; the runtime never converts that into a success.
//
// Errors: invalid dependency shapes fail at composition time, not while a bot is being provisioned.

import { createHash } from "node:crypto";
import { parseCatalogProfile, type CatalogProfile } from "./tool-catalog.js";

export const CAPABILITY_IDS = [
  "core", "memory", "web", "workspace", "computer", "task", "integration",
] as const;
export type CapabilityId = typeof CAPABILITY_IDS[number];
export type CapabilityState = "available" | "unavailable";
/** How the host knows the state; `configured-only` is never presented as a live vendor probe. */
export type CapabilityVerification = "host-verified" | "configured-only" | "not-configured";

export type PlatformCapability = {
  readonly id: CapabilityId;
  readonly state: CapabilityState;
  readonly verification: CapabilityVerification;
  /** Operator-facing text. Must never carry a credential or an endpoint secret. */
  readonly reason: string;
};

export type PlatformManifest = {
  readonly capabilities: readonly PlatformCapability[];
  /** Internal switches applied to every zero-setup bot. Not a user-facing template or pack. */
  readonly defaults: CatalogProfile;
  readonly checkedAt: string;
  /** Stable hash of the manifest; a change invalidates a bot's provisioning claim. */
  readonly fingerprint: string;
};

/** Facts the host itself established at startup. No field comes from the model or the browser. */
export type PlatformDependencies = {
  readonly memoryEnabled: boolean;
  /** A platform credential or a configured CCR profile supplies Web Search/Fetch. */
  readonly webConfigured: boolean;
  /** True when the platform holds the Web credential itself rather than invoking an external CLI. */
  readonly webViaPlatformCredential: boolean;
  /** One-time reminders need a delivery identity; without it the task capability is unavailable. */
  readonly taskDeliverable: boolean;
  readonly ptcConfigured: boolean;
  /**
   * A shared Computer / Execution Host is reachable over the RPC transport. Phase 1 does not
   * require OS-level isolation; the startup health probe is the real, fail-closed verification.
   */
  readonly computerHost: boolean;
  /** True only when an external integration actually reached a connected state. */
  readonly mcpConnected: boolean;
};

function capability(
  id: CapabilityId,
  state: CapabilityState,
  verification: CapabilityVerification,
  reason: string,
): PlatformCapability {
  return Object.freeze({ id, state, verification, reason });
}

/**
 * Platform Defaults are an internal runtime list, not a Bot Template and not a Capability Pack:
 * no browser input selects them. Availability is a ceiling; a switch that is on but unsupported
 * never turns an unconfigured service into a ready one.
 */
export function buildPlatformManifest(
  deps: PlatformDependencies,
  now: () => Date = () => new Date(),
): PlatformManifest {
  const capabilities: PlatformCapability[] = [
    capability("core", "available", "host-verified", "平台内置：时间查询、基础交互、Conversation 与工具发现。"),
    capability("memory", deps.memoryEnabled ? "available" : "unavailable",
      deps.memoryEnabled ? "host-verified" : "not-configured",
      deps.memoryEnabled ? "记忆存储已初始化。" : "MEMORY_ENABLED=0 或记忆系统未初始化。"),
    capability("web", deps.webConfigured ? "available" : "unavailable",
      deps.webConfigured ? "configured-only" : "not-configured",
      deps.webConfigured
        ? (deps.webViaPlatformCredential
            ? "平台凭据已配置；供应商连通性按调用时错误上报，不做实时探测。"
            : "CCR profile 已配置；依赖应用运行环境内的 CCR 与 Claude Code CLI。")
        : "未配置平台 Web 凭据或 CCR profile；Web Search/Fetch 不可用。"),
    capability("workspace", "available", "host-verified", "每个 bot 的持久化工作目录由宿主创建并校验。"),
    capability("computer", deps.computerHost ? "available" : "unavailable",
      deps.computerHost ? "configured-only" : "not-configured",
      deps.computerHost
        ? "共享 CVM 执行主机已配置；启动时由 RPC health.check 验证 Bash 与文件原语，工作区由执行面按需创建。"
        : "未配置共享执行主机；Bash / Read / Write / Edit 不可用。"),
    capability("task", deps.taskDeliverable ? "available" : "unavailable",
      deps.taskDeliverable ? "host-verified" : "not-configured",
      deps.taskDeliverable ? "提醒存储与投递身份可用。" : "一次性提醒需要 Telegram 投递身份；当前部署未启用。"),
    capability("integration", "available", "host-verified",
      "授权请求与连接状态查询可用；OAuth 连接建立尚未实现，不会返回已连接。"),
  ];
  const defaults = parseCatalogProfile({
    core: true,
    shell: deps.computerHost,
    files: true,
    web: deps.webConfigured,
    // Phase 1 migrates Bash / Read / Write / Edit to the shared execution host. Codemode and the
    // other tool families follow later; they are not granted just because CODEMODE_ENABLED is set.
    ptc: false,
    memory: deps.memoryEnabled,
    reminders: deps.taskDeliverable,
    // External integrations are never open just because a bot was created.
    mcp: deps.mcpConnected,
  });
  const checkedAt = now().toISOString();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ capabilities, defaults }))
    .digest("hex");
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    defaults,
    checkedAt,
    fingerprint,
  });
}

export function capabilityById(manifest: PlatformManifest, id: CapabilityId): PlatformCapability {
  const found = manifest.capabilities.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Unknown platform capability: ${id}`);
  return found;
}

export function unavailableCapabilities(manifest: PlatformManifest): readonly PlatformCapability[] {
  return manifest.capabilities.filter((entry) => entry.state === "unavailable");
}
