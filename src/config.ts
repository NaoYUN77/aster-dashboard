import { readFileSync } from "node:fs";
import { setGlobalProxyFromEnv } from "node:http";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { isAbsoluteRemotePath } from "./execution/protocol.js";
import { readRpcClientConfig, type RpcClientConfig } from "./execution/rpc-config.js";
import { isProviderId, PROVIDER_IDS, PROVIDERS } from "./providers.js";
import type { PlatformDependencies } from "./platform-capabilities.js";
import {
  assertSchema,
  eventDate,
  MEMORY_BUDGET_DEFAULTS,
  MemoryBudgetSchema,
  MemoryError,
  type MemoryBudget,
} from "./memory/contracts.js";

export { ConfigurationError };

const VAULT_PLACEHOLDER = /^__vault_[A-Z][A-Z0-9_]*__$/;

/** True when value is a well-formed OpenBao/MITM placeholder (`__vault_<NAME>__`). */
export function isVaultPlaceholder(value: string): boolean {
  return VAULT_PLACEHOLDER.test(value);
}

function assertValidCredentialShape(key: string, value: string): void {
  if (value.includes("__vault_") && !isVaultPlaceholder(value)) {
    throw new ConfigurationError(`${key} has a malformed vault placeholder; expected __vault_${key}__`);
  }
}

/** True when HTTP(S)_PROXY is present in the environment. */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim(),
  );
}

const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;
const MITM_TOKEN_FILE = "ASTER_MITM_TOKEN_FILE";
// Same shape the addon accepts: workable as URL userinfo without percent-encoding surprises.
const MITM_TOKEN_SHAPE = /^[A-Za-z0-9._~-]{16,256}$/;

/**
 * Adds the MITM proxy credentials from ASTER_MITM_TOKEN_FILE to every configured proxy URL. Node
 * sends URL userinfo as `Proxy-Authorization: Basic ...` on CONNECT, so the app satisfies the proxy's
 * token gate without a token in .env, argv, or tool arguments. An unreadable or malformed token is a
 * startup error: connecting without credentials would only earn a 407 later.
 */
export function withProxyToken(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = env[MITM_TOKEN_FILE]?.trim();
  if (!path) return env;
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigurationError(`${MITM_TOKEN_FILE} could not be read`);
  }
  if (!MITM_TOKEN_SHAPE.test(token)) {
    throw new ConfigurationError(`${MITM_TOKEN_FILE} must contain 16-256 characters of [A-Za-z0-9._~-]`);
  }
  const effective: NodeJS.ProcessEnv = { ...env };
  for (const key of PROXY_VARS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const url = new URL(raw);
    url.username = "aster";
    url.password = token;
    effective[key] = url.toString();
  }
  return effective;
}

function validateProxyEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ConfigurationError(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed; trust the MITM CA via NODE_EXTRA_CA_CERTS",
    );
  }
  for (const key of PROXY_VARS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigurationError(`${key} must be a valid HTTP(S) URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigurationError(`${key} must use http: or https:`);
    }
  }
}

/**
 * Enable Node's global HTTP(S) proxy dispatcher from the environment when a proxy variable is set.
 * Needed when HTTPS_PROXY is loaded from --env-file=.env after Node startup; safe alongside NODE_USE_ENV_PROXY=1.
 * With ASTER_MITM_TOKEN_FILE set, the effective URLs carry the proxy credentials and are written back
 * so clients that build their own agent from process.env (TelegramClient, MCP children) use them too.
 */
export function configureEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  validateProxyEnv(env);
  if (!hasProxyEnv(env)) return false;
  const effective = withProxyToken(env);
  for (const key of PROXY_VARS) {
    const value = effective[key];
    if (value) env[key] = value;
  }
  setGlobalProxyFromEnv(effective);
  return true;
}

/**
 * MCP paths without the bot's own requirements, so the authorization CLI resolves the same file as the
 * running service. The default path is optional: a missing file just means no MCP servers. An explicitly
 * configured path must exist.
 */
export function resolveMcpConfigPaths(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = resolve(env.DATA_DIR || "data");
  const mcpConfig = env.MCP_CONFIG?.trim();
  return {
    dataDir,
    mcpConfigPath: mcpConfig ? resolve(mcpConfig) : join(dataDir, "mcp.json"),
    mcpConfigExplicit: Boolean(mcpConfig),
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  validateProxyEnv(env);
  const paths = resolveMcpConfigPaths(env);
  const telegramApiRoot = readTelegramApiRoot(env);
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const telegramEnabled = readTelegramEnabled(env);
  const ownerId = telegramEnabled ? readOwnerId(env) : "console";
  const provider = required("MODEL_PROVIDER");
  if (!isProviderId(provider)) {
    throw new ConfigurationError(`MODEL_PROVIDER must be one of: ${PROVIDER_IDS.join(", ")}`);
  }
  const providerKeyEnv = PROVIDERS[provider].apiKeyEnv;
  const providerKey = required(providerKeyEnv);
  assertValidCredentialShape(providerKeyEnv, providerKey);
  // A console-only deployment has no Telegram identity at all; requiring a token there would be a
  // configuration error the operator cannot satisfy without creating a bot they do not use.
  const token = telegramEnabled ? required("TELEGRAM_BOT_TOKEN") : "";
  if (telegramEnabled) assertValidCredentialShape("TELEGRAM_BOT_TOKEN", token);
  const ccrProfile = env.CCR_PROFILE?.trim();
  if (ccrProfile && (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(ccrProfile))) {
    throw new ConfigurationError("CCR_PROFILE must be a configured profile name or id");
  }
  const ccrCommand = env.CCR_COMMAND?.trim() || "ccr";
  if (ccrCommand.length > 512 || !/^[A-Za-z0-9_./:\\ -]+$/.test(ccrCommand)) {
    throw new ConfigurationError("CCR_COMMAND must be an executable path without shell metacharacters");
  }
  const execution = readExecutionConfig(env);
  const codemode = readCodemodeConfig(env);
  // Remote code mode runs its VM on the execution agent, so the gateway must be configured and
  // reachable. A local deployment keeps the previous codemode shape unchanged.
  const codemodeConfig: CodemodeConfig | undefined = codemode.enabled
    ? {
        ...codemode,
        ...(execution === undefined ? {} : {
          ptc: {
            rpc: readRpcClientConfig(env),
            defaultTimeoutSeconds: execution.defaultTimeoutSeconds,
            maxTimeoutSeconds: execution.maxTimeoutSeconds,
          },
        }),
      }
    : undefined;
  const reminders = readReminderConfig(env);
  const consoleConfig = readConsoleConfig(env);
  return {
    token,
    ownerId,
    telegramEnabled,
    console: consoleConfig,
    provider,
    model: required("MODEL_ID"),
    telegramApiRoot,
    ...(ccrProfile === undefined || ccrProfile === "" ? {} : { ccrProfile, ccrCommand }),
    ...(execution === undefined ? {} : { execution }),
    ...(codemodeConfig === undefined ? {} : { codemode: codemodeConfig }),
    ...paths,
    // Proactive sends need a Telegram identity; a console-only instance stores none.
    ...(reminders.enabled && telegramEnabled ? { reminders } : {}),
    trace: readTraceConfig(env),
    platform: readPlatformConfig(env),
  };
}

/**
 * Host-verified deployment facts for the zero-setup runtime. Nothing here comes from a bot row, a
 * request body or a model parameter. A credential is read once and kept in host configuration: it
 * is never written into a bot row, a tool declaration, a log line or a prompt.
 *
 * `PLATFORM_SANDBOX_VERIFIED=1` is an operator's declaration that this deployment passed the OS
 * isolation acceptance runbook. It is rejected without a configured remote execution transport,
 * because a flag alone cannot turn the host's own bash into an isolated Computer capability.
 */
export type PlatformConfig = {
  readonly facts: PlatformDependencies;
  /** Host-owned Web Search/Fetch credential. Never exposed to the model, a bot row or a log. */
  readonly webApiKey?: string;
};

export function readPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const webApiKey = env.PLATFORM_WEB_SEARCH_API_KEY?.trim() || undefined;
  if (webApiKey !== undefined) assertValidCredentialShape("PLATFORM_WEB_SEARCH_API_KEY", webApiKey);
  const ccrProfile = env.CCR_PROFILE?.trim();
  // Both providers install the same tool names; choosing one silently would hide a config error.
  if (webApiKey !== undefined && ccrProfile) {
    throw new ConfigurationError("Configure either PLATFORM_WEB_SEARCH_API_KEY or CCR_PROFILE, not both");
  }
  const sandboxRaw = env.PLATFORM_SANDBOX_VERIFIED?.trim();
  if (sandboxRaw !== undefined && sandboxRaw !== "" && sandboxRaw !== "0" && sandboxRaw !== "1") {
    throw new ConfigurationError("PLATFORM_SANDBOX_VERIFIED must be 0 or 1");
  }
  const sandboxVerified = sandboxRaw === "1";
  if (sandboxVerified && readExecutionConfig(env) === undefined) {
    throw new ConfigurationError("PLATFORM_SANDBOX_VERIFIED=1 requires EXECUTION_MODE=remote and a verified OS sandbox");
  }
  const facts: PlatformDependencies = Object.freeze({
    memoryEnabled: readMemoryConfig(env).enabled,
    webConfigured: webApiKey !== undefined || Boolean(ccrProfile),
    webViaPlatformCredential: webApiKey !== undefined,
    taskDeliverable: readReminderConfig(env).enabled && readTelegramEnabled(env),
    ptcConfigured: readCodemodeConfig(env).enabled,
    sandboxVerified,
    // No OAuth integration is connected in this phase; the platform never claims one.
    mcpConnected: false,
  });
  return Object.freeze({ facts, ...(webApiKey === undefined ? {} : { webApiKey }) });
}

/**
 * The structural config the agent and protocol adapters need. `platform` is optional here: those
 * modules predate zero-setup and do not need deployment facts, and tests hand-build this shape.
 * `readConfig()` always supplies it, so a real deployment still gets a frozen, host-verified value.
 */
export type RuntimeConfig = Omit<ReturnType<typeof readConfig>, "platform"> & {
  readonly platform?: PlatformConfig;
};

/**
 * Host-only compatibility switch for the pre-zero-setup dashboard acceptance harness. It is read
 * once by the process owner, defaults to off, and is never a browser field or a user capability
 * setting. An invalid value is a configuration error, not a silent fallback.
 */
export function readLegacyCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ALLOW_LEGACY_CATALOG?.trim();
  if (raw !== undefined && raw !== "" && raw !== "0" && raw !== "1") {
    throw new ConfigurationError("ALLOW_LEGACY_CATALOG must be 0 or 1");
  }
  return raw === "1";
}

/** One-time reminders (REMINDERS_*). Enabled by default; limits bound each owner's stored rows. */
export type ReminderConfig = {
  readonly enabled: boolean;
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly horizonDays: number;
};

/**
 * Every reminder bound is validated even when reminders are disabled, so a malformed value cannot
 * silently take effect after the switch is flipped. Time itself is always resolved by the host.
 */
export function readReminderConfig(env: NodeJS.ProcessEnv = process.env): ReminderConfig {
  const enabledRaw = env.REMINDERS_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("REMINDERS_ENABLED must be 0 or 1");
  }
  return {
    enabled: enabledRaw !== "0",
    maxPending: boundedInteger(env, "REMINDERS_MAX_PENDING", 100, 1, 1_000),
    maxPerHour: boundedInteger(env, "REMINDERS_MAX_PER_HOUR", 20, 1, 1_000),
    horizonDays: boundedInteger(env, "REMINDERS_MAX_HORIZON_DAYS", 366, 1, 3_650),
  };
}

/**
 * Langfuse Cloud tracing. Off unless both API keys are configured; `LANGFUSE_TRACING_ENABLED=0`
 * switches it off while keeping the keys in place. Tracing is diagnostics: an absent or incomplete
 * configuration disables it instead of failing startup.
 */
export type TraceConfig = {
  readonly enabled: boolean;
  readonly publicKey?: string;
  readonly secretKey?: string;
  readonly baseUrl?: string;
  /**
   * Upload model-visible content (script, nested tool arguments and results) as observation
   * input/output. Off by default: traces then keep only sizes, counts and error codes.
   */
  readonly captureContent?: boolean;
};

/** Env var names belong to the Langfuse SDK; `LANGFUSE_HOST` is the common self-hosted alias. */
export function readTraceConfig(env: NodeJS.ProcessEnv = process.env): TraceConfig {
  const raw = env.LANGFUSE_TRACING_ENABLED?.trim().toLowerCase();
  if (raw !== undefined && raw !== "" && !["0", "1", "false", "true"].includes(raw)) {
    throw new ConfigurationError("LANGFUSE_TRACING_ENABLED must be 0, 1, false, or true");
  }
  const captureRaw = env.LANGFUSE_CAPTURE_CONTENT?.trim().toLowerCase();
  if (captureRaw !== undefined && captureRaw !== "" && !["0", "1", "false", "true"].includes(captureRaw)) {
    throw new ConfigurationError("LANGFUSE_CAPTURE_CONTENT must be 0, 1, false, or true");
  }
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim();
  const keysConfigured = Boolean(publicKey && secretKey);
  const enabled = (keysConfigured || raw === "1" || raw === "true")
    && raw !== "0"
    && raw !== "false";
  const captureContent = captureRaw === "1" || captureRaw === "true";
  return {
    enabled,
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(captureContent ? { captureContent: true } : {}),
  };
}

/**
 * Tool execution placement. Local is the default. Remote execution picks exactly one transport:
 * `ssh` keeps the legacy broker socket path; `rpc` uses the execution agent's direct sessions, which
 * also carry the file primitives. The control plane never falls back from one to the other.
 */
export type ExecutionConfig = {
  /** Working directory on the execution host. The control plane's DATA_DIR never applies there. */
  readonly remoteCwd: string;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
} & (
  | {
      readonly transport: "ssh";
      /** Private host socket shared with the broker container; never a network address. */
      readonly brokerSocket: string;
      readonly connectTimeoutMs: number;
    }
  | {
      readonly transport: "rpc";
      /** Validated execution agent connection; the agent also runs the direct sandbox. */
      readonly rpc: RpcClientConfig;
    }
);

/**
 * The roots a sandbox exposes to commands: the legacy `/shared` workspace and the per-bot
 * `/workspaces` tree. A per-bot directory is derived inside one of them, never elsewhere.
 */
function isSandboxRootPath(value: string): boolean {
  if (value.includes("\\") || value.split("/").includes("..")) return false;
  return SANDBOX_ROOTS.some((root) => value === root || value.startsWith(`${root}/`));
}

export const SANDBOX_ROOTS = ["/shared", "/workspaces"] as const;

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

/**
 * EXECUTION_MODE=remote selects a remote transport; EXECUTION_REMOTE_TRANSPORT chooses which one
 * (default `ssh`, the legacy broker). Every setting of the selected transport is validated before the
 * process can reach the agent, and settings of the other transport are ignored rather than silently
 * taking effect after a later switch. Ownership of `EXECUTION_REMOTE_CWD` follows the transport: the
 * direct sandbox only exposes `/shared`, so the RPC path confines it there.
 */
export function readExecutionConfig(env: NodeJS.ProcessEnv = process.env): ExecutionConfig | undefined {
  const mode = env.EXECUTION_MODE?.trim() || "local";
  if (mode === "local") return undefined;
  if (mode !== "remote") throw new ConfigurationError("EXECUTION_MODE must be local or remote");
  const transport = env.EXECUTION_REMOTE_TRANSPORT?.trim() || "ssh";
  if (transport !== "ssh" && transport !== "rpc") {
    throw new ConfigurationError("EXECUTION_REMOTE_TRANSPORT must be ssh or rpc");
  }
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const remoteCwd = required("EXECUTION_REMOTE_CWD");
  if (!isAbsoluteRemotePath(remoteCwd)) {
    throw new ConfigurationError("EXECUTION_REMOTE_CWD must be an absolute POSIX path without control characters");
  }
  if (Buffer.byteLength(remoteCwd, "utf8") > 4096) {
    throw new ConfigurationError("EXECUTION_REMOTE_CWD must be at most 4096 bytes");
  }
  if (transport === "rpc" && !isSandboxRootPath(remoteCwd)) {
    throw new ConfigurationError(
      "EXECUTION_REMOTE_CWD must be under /shared or /workspaces for the rpc transport",
    );
  }
  const defaultTimeoutSeconds = boundedInteger(env, "EXECUTION_DEFAULT_TIMEOUT_SECONDS", 300, 1, 86_400);
  const maxTimeoutSeconds = boundedInteger(env, "EXECUTION_MAX_TIMEOUT_SECONDS", 3600, 1, 86_400);
  if (defaultTimeoutSeconds > maxTimeoutSeconds) {
    throw new ConfigurationError("EXECUTION_DEFAULT_TIMEOUT_SECONDS must not exceed EXECUTION_MAX_TIMEOUT_SECONDS");
  }
  if (transport === "rpc") {
    return {
      transport,
      rpc: readRpcClientConfig(env),
      remoteCwd,
      defaultTimeoutSeconds,
      maxTimeoutSeconds,
    };
  }
  const brokerSocket = required("EXECUTION_BROKER_SOCKET");
  if (!isAbsoluteRemotePath(brokerSocket)) {
    throw new ConfigurationError("EXECUTION_BROKER_SOCKET must be an absolute POSIX socket path without control characters");
  }
  return {
    transport,
    brokerSocket,
    remoteCwd,
    connectTimeoutMs: boundedInteger(env, "EXECUTION_BROKER_CONNECT_TIMEOUT_MS", 5_000, 100, 60_000),
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
  };
}

/** PTC / code mode (ADR-0019). Disabled unless explicitly enabled. */
export type CodemodeConfig = {
  readonly enabled: boolean;
  /** When enabled, model-visible file and command tools are hidden behind codemode. */
  readonly scriptFirst: boolean;
  /** Per-script deadline, including time spent in nested tool calls. */
  readonly timeoutMs: number;
  /** Maximum heap the QuickJS instance may allocate. */
  readonly memoryLimitBytes: number;
  /** Present only when execution is remote: the agent that runs the script's VM. */
  readonly ptc?: CodemodePtcConfig;
};

/** The execution agent connection and timeout bounds a remote code mode run needs. */
export type CodemodePtcConfig = {
  readonly rpc: RpcClientConfig;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
};

/**
 * Code mode runs model-written JavaScript in the base's QuickJS sandbox. It is opt-in because the
 * tool adds a prompt section and a write-capable execution path. Both bounds are validated even
 * when disabled so a malformed value cannot silently take effect after the switch is flipped.
 */
export function readCodemodeConfig(env: NodeJS.ProcessEnv = process.env): CodemodeConfig {
  const enabledRaw = env.CODEMODE_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("CODEMODE_ENABLED must be 0 or 1");
  }
  const enabled = enabledRaw === "1";
  const scriptFirstRaw = env.CODEMODE_SCRIPT_FIRST?.trim().toLowerCase();
  if (
    scriptFirstRaw !== undefined &&
    scriptFirstRaw !== "" &&
    scriptFirstRaw !== "0" &&
    scriptFirstRaw !== "1" &&
    scriptFirstRaw !== "false" &&
    scriptFirstRaw !== "true"
  ) {
    throw new ConfigurationError("CODEMODE_SCRIPT_FIRST must be 0, 1, false, or true");
  }
  return {
    enabled,
    // Code mode replaces the model-visible file and command tools by default; an explicit
    // 0/false keeps the previous exposure and remains a one-switch rollback.
    scriptFirst: scriptFirstRaw === undefined || scriptFirstRaw === ""
      ? enabled
      : scriptFirstRaw === "1" || scriptFirstRaw === "true",
    // Keep headroom under the 300 s request wait so the script reports its own timeout first.
    timeoutMs: boundedInteger(env, "CODEMODE_TIMEOUT_MS", 240_000, 1_000, 300_000),
    memoryLimitBytes: boundedInteger(
      env,
      "CODEMODE_MEMORY_LIMIT_BYTES",
      128 * 1024 * 1024,
      16 * 1024 * 1024,
      512 * 1024 * 1024,
    ),
  };
}

/**
 * Optional Telegram Bot API root override (a reverse proxy, e.g. a Cloudflare Worker) for hosts
 * that cannot reach api.telegram.org directly. The value is a URL prefix: the client appends
 * /bot<token>/<method> to it. It must be an https URL without query or fragment; trailing
 * slashes are dropped so the join is exact. Unset means the default api.telegram.org root.
 */
function readTelegramApiRoot(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.TELEGRAM_API_ROOT?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("TELEGRAM_API_ROOT must be a valid URL");
  }
  if (url.protocol !== "https:") throw new ConfigurationError("TELEGRAM_API_ROOT must be an https URL");
  if (url.search || url.hash) throw new ConfigurationError("TELEGRAM_API_ROOT must not contain a query or fragment");
  return url.href.replace(/\/+$/, "");
}

/** Memory wiring (MEM-07): budgets, the compaction reserve, the archive timezone and timeout. */
export type MemoryConfig = {
  readonly enabled: boolean;
  readonly budget: MemoryBudget;
  /** Tokens kept free for the model's answer; the compaction thresholds derive from it. */
  readonly reserveTokens: number;
  /** Zone archive dates are computed in. Default UTC; never the machine's local zone. */
  readonly timezone: string;
  readonly archiveTimeoutMs: number;
};

function memoryInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

/**
 * Every memory parameter is optional; an explicitly set value must be an integer inside its valid
 * range, and the assembled budget must satisfy the one budget schema (MEM-01) plus the rule that a
 * single retrieval fits inside one request's cumulative retrieval budget. Anything else is a
 * startup configuration error naming the variable, never a silent clamp.
 */
export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const enabledRaw = env.MEMORY_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("MEMORY_ENABLED must be 0 or 1");
  }
  const budget: MemoryBudget = {
    backgroundTargetTokens: memoryInteger(env, "MEMORY_BACKGROUND_TARGET_TOKENS", MEMORY_BUDGET_DEFAULTS.backgroundTargetTokens, 1_024, 1_048_576),
    recentVerbatimTokens: memoryInteger(env, "MEMORY_RECENT_VERBATIM_TOKENS", MEMORY_BUDGET_DEFAULTS.recentVerbatimTokens, 512, 1_048_576),
    snapshotTokens: memoryInteger(env, "MEMORY_SNAPSHOT_TOKENS", MEMORY_BUDGET_DEFAULTS.snapshotTokens, 256, 262_144),
    narrativeTokens: memoryInteger(env, "MEMORY_NARRATIVE_TOKENS", MEMORY_BUDGET_DEFAULTS.narrativeTokens, 128, 262_144),
    instructionsTokens: memoryInteger(env, "MEMORY_INSTRUCTIONS_TOKENS", MEMORY_BUDGET_DEFAULTS.instructionsTokens, 256, 1_048_576),
    searchResultTokens: memoryInteger(env, "MEMORY_SEARCH_RESULT_TOKENS", MEMORY_BUDGET_DEFAULTS.searchResultTokens, 128, 65_536),
    requestSearchTokens: memoryInteger(env, "MEMORY_REQUEST_SEARCH_TOKENS", MEMORY_BUDGET_DEFAULTS.requestSearchTokens, 128, 262_144),
    evaluateAfterUserTurns: memoryInteger(env, "MEMORY_EVALUATE_AFTER_USER_TURNS", MEMORY_BUDGET_DEFAULTS.evaluateAfterUserTurns, 1, 1_000),
  };
  if (budget.requestSearchTokens < budget.searchResultTokens) {
    throw new ConfigurationError("MEMORY_REQUEST_SEARCH_TOKENS must be at least MEMORY_SEARCH_RESULT_TOKENS");
  }
  try {
    assertSchema<MemoryBudget>(MemoryBudgetSchema, budget, "invalid-input");
  } catch (error) {
    if (error instanceof MemoryError) throw new ConfigurationError("MEMORY_* budget values do not satisfy the memory budget schema");
    throw error;
  }
  const timezone = env.MEMORY_TIMEZONE?.trim() || "UTC";
  try {
    eventDate(0, timezone);
  } catch {
    throw new ConfigurationError(`MEMORY_TIMEZONE is not a known time zone: ${timezone}`);
  }
  return {
    enabled: enabledRaw !== "0",
    budget,
    reserveTokens: memoryInteger(env, "MEMORY_RESERVE_TOKENS", 16_384, 1, 1_048_576),
    timezone,
    archiveTimeoutMs: memoryInteger(env, "MEMORY_ARCHIVE_TIMEOUT_MS", 60_000, 1, 300_000),
  };
}

/** Telegram long polling is the historical default; a local console replaces it entirely. */
function readTelegramEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TELEGRAM_ENABLED?.trim();
  if (raw !== undefined && raw !== "" && raw !== "0" && raw !== "1") {
    throw new ConfigurationError("TELEGRAM_ENABLED must be 0 or 1");
  }
  return raw !== "0";
}

/**
 * The local console: an in-process HTTP surface for the owner's browser. It is off unless enabled,
 * and it refuses to start without a token: the browser is the only client, but the port is still a
 * listener, so an unauthenticated mode would be an open door rather than a convenience.
 */
export type ConsoleConfig = {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Directory holding the static page; the image copies `dashboard/web` there. */
  readonly webDir: string;
  readonly maxBots: number;
};

export function readConsoleConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig | undefined {
  const enabledRaw = env.CONSOLE_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("CONSOLE_ENABLED must be 0 or 1");
  }
  if (enabledRaw !== "1") return undefined;
  const token = env.WEB_TOKEN?.trim() ?? "";
  if (!/^[\x21-\x7e]{16,256}$/.test(token)) {
    throw new ConfigurationError("WEB_TOKEN must be 16-256 printable characters without spaces");
  }
  const host = env.CONSOLE_HOST?.trim() || "0.0.0.0";
  if (!isIP(host)) throw new ConfigurationError("CONSOLE_HOST must be an IP literal");
  const webDir = resolve(env.CONSOLE_WEB_DIR?.trim() || "dashboard/web");
  return {
    host,
    // 0 asks the OS for an ephemeral port, which the acceptance tests use; a deployment pins one.
    port: boundedInteger(env, "CONSOLE_PORT", 8787, 0, 65_535),
    token,
    webDir,
    maxBots: boundedInteger(env, "CONSOLE_MAX_BOTS", 8, 1, 64),
  };
}

function readOwnerId(env: NodeJS.ProcessEnv): string {
  const ownerId = env.TELEGRAM_OWNER_ID?.trim();
  if (!ownerId) throw new ConfigurationError("Missing configuration: TELEGRAM_OWNER_ID");
  if (!/^[1-9]\d*$/.test(ownerId)) throw new ConfigurationError("TELEGRAM_OWNER_ID must be a positive numeric user ID");
  return ownerId;
}
