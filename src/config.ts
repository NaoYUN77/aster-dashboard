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
 * so clients that build their own agent from process.env (MCP children) use them too.
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
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const provider = required("MODEL_PROVIDER");
  if (!isProviderId(provider)) {
    throw new ConfigurationError(`MODEL_PROVIDER must be one of: ${PROVIDER_IDS.join(", ")}`);
  }
  const providerKeyEnv = PROVIDERS[provider].apiKeyEnv;
  const providerKey = required(providerKeyEnv);
  assertValidCredentialShape(providerKeyEnv, providerKey);
  const ccrProfile = env.CCR_PROFILE?.trim();
  if (ccrProfile && (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(ccrProfile))) {
    throw new ConfigurationError("CCR_PROFILE must be a configured profile name or id");
  }
  const ccrCommand = env.CCR_COMMAND?.trim() || "ccr";
  if (ccrCommand.length > 512 || !/^[A-Za-z0-9_./:\\ -]+$/.test(ccrCommand)) {
    throw new ConfigurationError("CCR_COMMAND must be an executable path without shell metacharacters");
  }
  const execution = readExecutionConfig(env);
  const consoleConfig = readConsoleConfig(env);
  return {
    // The dashboard console is the only ingress; its optional config is resolved by the host.
    console: consoleConfig,
    provider,
    model: required("MODEL_ID"),
    ...(ccrProfile === undefined || ccrProfile === "" ? {} : { ccrProfile, ccrCommand }),
    ...(execution === undefined ? {} : { execution }),
    ...paths,
    trace: readTraceConfig(env),
    platform: readPlatformConfig(env),
  };
}

/**
 * Host-verified deployment facts for the zero-setup runtime. Nothing here comes from a bot row, a
 * request body or a model parameter. A credential is read once and kept in host configuration: it
 * is never written into a bot row, a tool declaration, a log line or a prompt.
 *
 * Phase 1's Computer capability comes from a configured RPC execution face: one shared CVM
 * Computer / Execution Host for all bots (single-user MVP, no OS-level isolation). No OS-isolation
 * declaration is needed; the startup RPC `health.check` and each bot's workspace probe stay
 * fail-closed, so an unreachable or incomplete execution face never produces a Ready bot.
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
  const execution = readExecutionConfig(env);
  const facts: PlatformDependencies = Object.freeze({
    memoryEnabled: readMemoryConfig(env).enabled,
    webConfigured: webApiKey !== undefined || Boolean(ccrProfile),
    webViaPlatformCredential: webApiKey !== undefined,
    // A rpc transport owns Bash and the file primitives; ssh only carries shell commands.
    computerHost: execution?.transport === "rpc",
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
   * Upload model-visible content (tool arguments and results) as observation input/output.
   * Off by default: traces then keep only sizes, counts and error codes.
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
      /** Validated execution agent connection; the agent runs the shared Phase 1 execution host. */
      readonly rpc: RpcClientConfig;
    }
);

/**
 * The workspace roots the Phase 1 shared execution host exposes to commands: the legacy
 * `/shared` workspace and the per-bot `/workspaces` tree. A per-bot directory is derived
 * inside one of them, never elsewhere.
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
 * shared execution host only exposes `/shared`, so the RPC path confines it there.
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

/**
 * The local console: an in-process HTTP surface for the owner's browser. It is off unless enabled.
 * Authentication is the fail-closed default (`WEB_AUTH=token`); `WEB_AUTH=off` is an explicit host
 * decision for a deployment whose only reachable ingress is already a loopback or tunnel boundary.
 * The static page is always served so the browser can ask for a token when one is required.
 */
export type ConsoleConfig = {
  readonly host: string;
  readonly port: number;
  /** `null` only when the host explicitly disabled authentication with `WEB_AUTH=off`. */
  readonly token: string | null;
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
  // The browser is still a listener client. Token authentication stays the default; turning it off
  // must be an explicit host decision and is only appropriate behind a loopback/tunnel boundary.
  const auth = env.WEB_AUTH?.trim() || "token";
  if (auth !== "token" && auth !== "off") {
    throw new ConfigurationError("WEB_AUTH must be token or off");
  }
  const token = auth === "off" ? null : (env.WEB_TOKEN?.trim() ?? "");
  if (token !== null && !/^[\x21-\x7e]{16,256}$/.test(token)) {
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
