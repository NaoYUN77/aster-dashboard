import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
  McpAbortError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type CallToolResult,
  type LlmContent,
  type McpFetch,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  discoverOAuthServerInfo,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthProviderOptions,
  type OAuthDiscoveryState,
} from "@earendil-works/pi-mcp/oauth";
import { Compile } from "typebox/compile";
import type { McpAuthConfig, McpFileConfig, McpHttpServerConfig, McpServerConfig } from "./mcp-config.js";
import { FileOAuthStateStore } from "./mcp-oauth-store.js";
import type { GovernedTool, ToolAvailability, ToolGovernance } from "./tools.js";
import type { ToolPinConfig } from "./tool-pins.js";
import { openGithubGate, persistGithubDisabled, type GithubGate } from "./github-gate.js";
import { assertGithubProxy, githubFetch, type GithubHttpScope } from "./github-transport.js";
import { GITHUB_ENDPOINT, GITHUB_TOOL_NAMES, githubRegisteredName } from "./github-policy.js";

const CLIENT_NAME = "personal-agent-base-durable";
const CLIENT_VERSION = "0.1.0";
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_PAGES = 10;
// Total time one server may spend on tools/list, independent of how many pages it returns.
const MAX_DISCOVERY_MS = 30_000;
const MAX_TOOL_NAME = 64;
const MAX_DESCRIPTION = 4 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_LINES = 1_000;
// The output bound only covers text; an image block would otherwise enter the durable transcript at any
// size. base64 is ASCII, so character count is a cheap upper bound on bytes.
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 2_000;

export type McpToolInfo = Pick<McpTool, "name" | "description" | "inputSchema"> & Record<string, unknown>;

/** The part of a connected server the tool adapter and tests need. */
export interface McpConnection {
  readonly serverName: string;
  listTools(options?: { readonly signal?: AbortSignal }): Promise<McpToolInfo[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
  /** Synchronously reports current availability, then observed connection changes. */
  subscribeAvailability(listener: (state: ToolAvailability) => void): () => void;
  subscribeDeclarationChanges?(listener: () => void): () => void;
}

export type McpConnectContext = {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** The bot refuses redirects; the authorization CLI captures the URL instead. */
  readonly onOAuthRedirect?: (url: URL) => void | Promise<void>;
  /** Safe status lines only: server name, counts, and error codes. */
  readonly log?: (line: string) => void;
};

export type McpConnector = (server: McpServerConfig, context: McpConnectContext) => Promise<McpConnection>;

export type McpHost = {
  readonly extensions: readonly Extension[];
  readonly pins?: ToolPinConfig;
  /** Replays every discovered server's state before returning. */
  subscribeAvailability(listener: (server: string, state: ToolAvailability) => void): () => void;
  close(): Promise<void>;
};

/** Connect one server and return the wrapper used by the tool adapter. */
export async function openMcpConnection(server: McpServerConfig, context: McpConnectContext): Promise<McpConnection> {
  const client = new McpClient({
    name: CLIENT_NAME,
    version: CLIENT_VERSION,
    requestTimeoutMs: server.timeoutMs,
  });

  if (server.transport === "stdio") {
    const transport = new StdioTransport({
      command: server.command,
      args: [...server.args],
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      env: childEnvironment(server, context.env),
      inheritEnv: false,
      stderr: "pipe",
      // Server stderr may contain credentials or user data; keep a bound, never log it.
      maxStderrBytes: MAX_STDERR_BYTES,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
    });
    try {
      await connectWithTimeout(client, transport, server.connectTimeoutMs, context.signal);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return wrapConnection(client, server, context.log);
  }

  const provider = server.auth === undefined
    ? undefined
    : createOAuthProvider(server, context.dataDir, context.onOAuthRedirect ?? (() => {
      throw new McpOAuthAuthorizationRequiredError();
    }));
  let githubScope: GithubHttpScope | undefined;
  if (server.name === "github") assertGithubProxy(context.env);
  const transport = new StreamableHttpTransport({
    url: server.url,
    headers: { ...server.headers },
    // The transport bounds SSE events but reads a JSON response whole, so bound those here too.
    fetch: server.name === "github" ? githubFetch(() => githubScope) : boundedFetch,
    ...(server.name === "github" ? { reconnect: { maxRetries: 0 } } : {}),
    maxMessageBytes: MAX_MESSAGE_BYTES,
    ...(provider === undefined ? {} : { authProvider: adaptOAuthProvider(provider) }),
  });
  try {
    await connectWithTimeout(client, transport, server.connectTimeoutMs, context.signal);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return wrapConnection(client, server, context.log, (scope) => { githubScope = scope; });
}

/** Flow options shared by the CLI and the runtime, so an authorization done once applies to both. */
export function mcpAuthFlowOptions(auth: McpAuthConfig): { authorizationServerMetadataUrl?: URL } {
  return auth.authorizationServerMetadataUrl === undefined
    ? {}
    : { authorizationServerMetadataUrl: new URL(auth.authorizationServerMetadataUrl) };
}

/**
 * The runtime's 401 recovery goes through `adaptOAuthProvider`, which runs its own flow without options,
 * so a configured authorization server metadata URL is supplied through the discovery state it reads
 * first. Without this, the CLI would authorize against the configured server while the bot rediscovered
 * from the MCP server and landed somewhere else.
 */
class ConfiguredDiscoveryProvider extends McpOAuthProvider {
  readonly #serverUrl: URL;
  readonly #metadataUrl: URL;

  constructor(options: McpOAuthProviderOptions, serverUrl: URL, metadataUrl: URL) {
    super(options);
    this.#serverUrl = serverUrl;
    this.#metadataUrl = metadataUrl;
  }

  override async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    // Always use the configured document, so changing it takes effect without deleting stored state.
    // The flow runs only on a 401, and concurrent 401s share one flow. If it cannot be loaded, fall back
    // to the stored discovery rather than failing the recovery outright.
    return await discoverOAuthServerInfo(this.#serverUrl, { authorizationServerMetadataUrl: this.#metadataUrl })
      .catch(() => super.discoveryState());
  }
}

export function createOAuthProvider(
  server: McpHttpServerConfig,
  dataDir: string,
  onRedirect: (url: URL) => void | Promise<void>,
): McpOAuthProvider {
  const auth = server.auth;
  if (auth === undefined) throw new Error(`MCP server ${server.name} has no OAuth configuration`);
  const options: McpOAuthProviderOptions = {
    serverUrl: server.url,
    redirectUrl: `http://127.0.0.1:${auth.redirectPort}/callback`,
    // The configured scope is also the runtime's fallback when a 401 challenge names none, so a
    // refresh or reauthorization asks for the same grant the CLI obtained.
    clientMetadata: { client_name: CLIENT_NAME, ...(auth.scope === undefined ? {} : { scope: auth.scope }) },
    ...(auth.clientId === undefined ? {} : { clientId: auth.clientId }),
    ...(auth.clientSecret === undefined ? {} : { clientSecret: auth.clientSecret }),
    store: new FileOAuthStateStore(join(dataDir, "mcp-oauth", `${server.name}.json`)),
    onRedirect,
  };
  return auth.authorizationServerMetadataUrl === undefined
    ? new McpOAuthProvider(options)
    : new ConfiguredDiscoveryProvider(options, new URL(server.url), new URL(auth.authorizationServerMetadataUrl));
}

function wrapConnection(
  client: McpClient,
  server: McpServerConfig,
  log: ((line: string) => void) | undefined,
  setScope?: (scope: GithubHttpScope | undefined) => void,
): McpConnection {
  let closed = false;
  async function scoped<T>(signal: AbortSignal | undefined, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const effective = signal ? AbortSignal.any([signal, deadline]) : deadline;
    setScope?.({ signal: effective, received: 0 });
    try { return await run(effective); } finally { setScope?.(undefined); }
  }
  return {
    serverName: server.name,
    listTools: (options) => server.name === "github"
      ? scoped(options?.signal, 10_000, (signal) => listToolsBounded(client, 10_000, signal, log, true))
      : listToolsBounded(client, server.timeoutMs, options?.signal, log),
    callTool: (name, args, options) => server.name === "github"
      ? scoped(options.signal, options.timeoutMs, (signal) => client.callTool(name, args, { signal, timeoutMs: options.timeoutMs }))
      : client.callTool(name, args, { ...(options.signal === undefined ? {} : { signal: options.signal }), timeoutMs: options.timeoutMs }),
    subscribeDeclarationChanges(listener) {
      const notification = client.onNotification("notifications/tools/list_changed", listener);
      const error = client.onError(() => listener());
      return () => { notification(); error(); };
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
    subscribeAvailability(listener) {
      const unsubscribe = client.onClose(() => listener("unavailable"));
      // onClose is not replayed by the SDK; discovery may already have observed a closure.
      listener(client.connectionState === "connected" ? "available" : "unavailable");
      return unsubscribe;
    },
  };
}

/**
 * List tools with our own page, count, and time bounds. `McpClient.listTools()` follows every page, so a
 * misbehaving server could make it allocate or stall without limit. Truncation is reported so the operator
 * can see that a server offers more than was registered.
 */
export async function listToolsBounded(
  client: Pick<McpClient, "request">,
  timeoutMs: number,
  signal?: AbortSignal,
  log: (line: string) => void = () => {},
  strict = false,
): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  // The deadline covers the whole listing: per-page timeouts alone would let 10 slow pages take 10 minutes.
  const discovery = new AbortController();
  const timer = setTimeout(() => discovery.abort(new McpTimeoutError(MAX_DISCOVERY_MS)), MAX_DISCOVERY_MS);
  const requestSignal = signal === undefined ? discovery.signal : AbortSignal.any([signal, discovery.signal]);
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.request<unknown>(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        { timeoutMs, signal: requestSignal },
      ).catch((error: unknown) => {
        // The client reports its own abort, but the cause here is the discovery deadline.
        if (discovery.signal.aborted && !signal?.aborted) throw discovery.signal.reason;
        throw error;
      });
      const parsed = parseToolList(result, strict);
      tools.push(...parsed.tools);
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        if (strict) throw coded("GitHub discovery count limit", "GITHUB_DISCOVERY_INCOMPLETE");
        log(`MCP tool list truncated at ${MAX_TOOLS_PER_SERVER} tools`);
        return tools.slice(0, MAX_TOOLS_PER_SERVER);
      }
      cursor = parsed.nextCursor;
      if (cursor === undefined) return tools;
    }
    if (strict) throw coded("GitHub discovery page limit", "GITHUB_DISCOVERY_INCOMPLETE");
    log(`MCP tool list truncated at ${MAX_TOOL_PAGES} pages (${tools.length} tools)`);
    return tools;
  } finally {
    clearTimeout(timer);
  }
}

function parseToolList(value: unknown, strict = false): { tools: McpToolInfo[]; nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value.tools)) throw new McpError(-32600, "Invalid MCP tools/list result");
  if (strict && value.tools.some((tool) => !isMcpTool(tool))) throw coded("Invalid GitHub tool declaration", "GITHUB_DISCOVERY_INCOMPLETE");
  const tools = value.tools.filter(isMcpTool).map((tool) => strict ? { ...tool } : ({
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
  }));
  const cursor = value.nextCursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw new McpError(-32600, "Invalid MCP tools/list cursor");
  }
  return { tools, ...(typeof cursor === "string" && cursor ? { nextCursor: cursor } : {}) };
}

function isMcpTool(value: unknown): value is McpTool {
  return isRecord(value) && typeof value.name === "string" && isRecord(value.inputSchema);
}

/**
 * Connect every configured server in parallel, build one extension per server, and install the
 * tool-search extension when at least one tool is available. A failed server is skipped; it never
 * prevents the agent from starting.
 */
export async function connectMcp(
  config: McpFileConfig | undefined,
  options: {
    readonly dataDir: string;
    readonly reserved: ReadonlySet<string>;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly connect?: McpConnector;
    readonly log?: (line: string) => void;
  },
): Promise<McpHost> {
  const log = options.log ?? ((line: string) => console.error(line));
  const connect = options.connect ?? openMcpConnection;
  const context: McpConnectContext = {
    dataDir: options.dataDir,
    env: options.env ?? process.env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    log,
  };

  const servers = config?.servers ?? [];
  const results = await Promise.all(servers.map(async (server) => {
    try {
      if (server.name === "github" && (server.transport !== "http" || !server.githubPolicy || server.url !== GITHUB_ENDPOINT
        || server.auth !== undefined || server.headers.Authorization !== "Bearer __vault_GITHUB_MCP_TOKEN__"
        || server.headers["X-MCP-Readonly"] !== "true" || server.headers["X-MCP-Tools"] !== GITHUB_TOOL_NAMES.join(","))) {
        throw coded("Invalid GitHub host configuration", "GITHUB_CONFIG_REJECTED");
      }
      const connection = await connect(server, context);
      try {
        const tools = await connection.listTools({ signal: options.signal });
        const gate = server.name === "github" && server.transport === "http" && server.githubPolicy
          ? await openGithubGate(connection, server.githubPolicy, tools, options.dataDir) : undefined;
        return { server, connection, tools: gate?.effective ?? tools, gate };
      } catch (error) {
        if (server.transport === "http" && server.githubPolicy && !mcpErrorCode(error).startsWith("GITHUB_")) {
          await persistGithubDisabled(server.githubPolicy, options.dataDir, "GITHUB_DISCOVERY_FAILED");
        }
        await connection.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      return { server, error };
    }
  }));

  const used = new Set(options.reserved);
  const extensions: Extension[] = [];
  const live: { connection: McpConnection; unsubscribe: () => void }[] = [];
  const availability = new Map<string, ToolAvailability>();
  const listeners = new Set<(server: string, state: ToolAvailability) => void>();
  const update = (server: string, state: ToolAvailability) => {
    if (availability.get(server) === state) return;
    availability.set(server, state);
    for (const listener of [...listeners]) listener(server, state);
  };
  const summary: string[] = [];

  for (const result of results) {
    if ("error" in result) {
      log(`MCP server ${result.server.name} unavailable (${mcpErrorCode(result.error)})`);
      continue;
    }
    const { server, connection, gate } = result;
    // Every member of a sanitized-name collision group gets its identity-derived name. Otherwise a
    // newly discovered raw name that sorts first could take the old bare name and inherit its config.
    const tools = [...result.tools].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const nameCounts = new Map<string, number>();
    for (const info of tools) {
      const base = mcpToolNameBase(server.name, info.name);
      nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1);
    }
    const registrations: ToolRegistration[] = [];
    for (const info of tools) {
      const base = mcpToolNameBase(server.name, info.name);
      const name = gate ? (used.has(githubRegisteredName(info.name)) ? undefined : githubRegisteredName(info.name))
        : mcpToolName(server.name, info.name, used, nameCounts.get(base)! > 1);
      if (name === undefined) {
        log(`MCP server ${server.name}: tool skipped (name collision)`);
        continue;
      }
      const tool = buildMcpTool(server, connection, info, name, gate ? "read" : config?.tools?.[name]?.authz, gate);
      if (tool === undefined) {
        log(`MCP server ${server.name}: tool skipped (unsupported schema)`);
        continue;
      }
      used.add(name);
      registrations.push(tool);
    }
    if (gate && registrations.length !== GITHUB_TOOL_NAMES.length) {
      await gate.disable("GITHUB_REGISTRATION_REJECTED");
      await connection.close().catch(() => {});
      log("MCP server github unavailable (GITHUB_REGISTRATION_REJECTED)");
      continue;
    }
    if (registrations.length === 0) {
      await connection.close().catch(() => {});
      log(`MCP server ${server.name} provides no usable tools`);
      continue;
    }
    let blocked = false;
    const disabled = gate?.subscribeDisabled(() => { blocked = true; update(server.name, "unavailable"); });
    const changed = gate ? connection.subscribeDeclarationChanges?.(() => {
      void gate.disable().catch(() => { blocked = true; update(server.name, "unavailable"); });
    }) : undefined;
    const health = connection.subscribeAvailability((state) => {
      const previous = availability.get(server.name);
      update(server.name, blocked ? "unavailable" : state);
      if (previous !== state && (previous !== undefined || state === "unavailable")) {
        log(`MCP server ${server.name} ${state === "available" ? "reconnected" : "disconnected"}`);
      }
    });
    live.push({ connection, unsubscribe: () => { health(); disabled?.(); changed?.(); } });
    // Installing an extension with an existing name replaces it, so the server-derived names must never
    // coincide with the summary extension below. SERVER_NAME allows "info", and the prefix differs.
    extensions.push(defineExtension({ name: `mcp-server-${server.name}`, tools: registrations }));
    summary.push(`${server.name} (${registrations.length})`);
  }

  if (summary.length > 0) {
    extensions.push(defineExtension({
      name: "mcp-servers",
      sections: [{
        key: "mcp",
        render: () => `MCP servers connected: ${summary.join(", ")}. Their tools are loaded on demand: call tool_search with a task or tool name before calling one.`,
      }],
    }));
    extensions.push(createToolSearchExtension());
  }

  let closed = false;
  return {
    extensions,
    pins: { tools: config?.tools, residentToolBudgetTokens: config?.residentToolBudgetTokens },
    subscribeAvailability(listener) {
      listeners.add(listener);
      for (const [server, state] of availability) listener(server, state);
      return () => { listeners.delete(listener); };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const record of live) {
        record.unsubscribe();
        update(record.connection.serverName, "unavailable");
      }
      listeners.clear();
      await Promise.all(live.map(async (record) => {
        await record.connection.close().catch(() => {});
      }));
    },
  };
}

/**
 * A provider-safe, deterministic name. The name depends only on the server and raw tool name, so a
 * durable call finds the same tool after a restart. `used` only decides whether a name is available;
 * callers must assign names in a stable order for the bare name to go to the same raw tool.
 */
function mcpToolNameBase(serverName: string, rawToolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(rawToolName) || "tool"}`;
}

export function mcpToolName(
  serverName: string,
  rawToolName: string,
  used: ReadonlySet<string>,
  forceHashed = false,
): string | undefined {
  const base = mcpToolNameBase(serverName, rawToolName);
  const suffix = `_${createHash("sha256").update(`${serverName}\0${rawToolName}`).digest("hex").slice(0, 8)}`;
  const hashed = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
  // Collision groups force every member to its raw-identity-derived candidate. For ordinary tools,
  // retain the readable bare name and use the hash only when it conflicts with a reserved name.
  for (const candidate of forceHashed ? [hashed] : [base, hashed]) {
    if (candidate.length <= MAX_TOOL_NAME && !used.has(candidate)) return candidate;
  }
  return undefined;
}

export function buildMcpTool(
  server: McpServerConfig,
  connection: McpConnection,
  info: McpToolInfo,
  name: string,
  authz: ToolGovernance["authz"] = "write",
  github?: GithubGate,
): GovernedTool | undefined {
  if (server.name === "github" && !github) return undefined;
  const schema = normalizeSchema(info.inputSchema);
  if (schema === undefined) return undefined;
  const governance: ToolGovernance = {
    source: { kind: "mcp", server: server.name },
    trust: "untrusted",
    authz,
    ...(github ? { githubApproval: github.fingerprint } : {}),
  };
  return Object.assign(defineTool({
    name,
    description: sanitizeDescription(info.description, info.name),
    parameters: Type.Unsafe<Record<string, unknown>>(schema),
    replay: "unsafe",
    deferred: true,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES, retain: "head" },
    execute: async (args, _api, context): Promise<ToolExecutionResult> => {
      let result: CallToolResult;
      try {
        result = github ? await github.call(info.name, args, context.abortSignal, server.timeoutMs) : await connection.callTool(info.name, args, {
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          timeoutMs: server.timeoutMs,
        });
      } catch (error) {
        if (github) {
          // Cancellation belongs to the base's tool task. Preserve it instead of reporting a
          // GitHub business failure when the caller stopped waiting.
          if (error instanceof McpAbortError || context.abortSignal?.aborted) throw error;
          const code = isRecord(error) && typeof error.code === "string" && /^GITHUB_[A-Z_]+$/.test(error.code) ? error.code : mcpErrorCode(error);
          const sent = code.startsWith("GITHUB_") ? "not_sent" : "possibly_sent";
          const message = `${code}: GitHub ${sent === "not_sent" ? "business call was not sent" : "call failed; remote completion may be unknown"}. ${code === "MCP_HTTP_401" ? "Ask the owner to check the PAT; OAuth is disabled." : "No automatic retry; ask the owner to inspect the connection or approval."}`;
          return { isError: true, output: [{ type: "text", text: message }], details: { code, stage: sent, approval: github.fingerprint }, diagnostics: [{ severity: "error", code, message }] };
        }
        throw mapMcpToolError(error, server.name);
      }
      if (github && (byteLength(result) > MAX_MESSAGE_BYTES || !Array.isArray(result.content)
        || result.content.some((block) => !isRecord(block) || block.type !== "text"))) {
        return { isError: true, output: [{ type: "text", text: "GITHUB_RESULT_REJECTED: response exceeds the budget or contains unsupported content; no links or resources were fetched." }], details: { code: "GITHUB_RESULT_REJECTED", stage: "sent_result_rejected" } };
      }
      return {
        output: boundedLlmContent(toLlmContent(result), info.name),
        isError: result.isError === true,
        details: { server: server.name, tool: info.name },
      };
    },
  }), { governance });
}

/**
 * The harness bounds text only, and an image becomes part of the durable transcript and every later
 * request, so images are dropped here instead of being stored at whatever size the server sent.
 */
function boundedLlmContent(content: LlmContent[], toolName: string): LlmContent[] {
  return content.flatMap((block) => {
    if (block.type !== "image" || block.data.length <= MAX_IMAGE_CHARS) return [block];
    return [{ type: "text", text: `[image from ${toolName} omitted: ${block.mimeType} exceeds the output limit]` }];
  });
}

/**
 * Bound the HTTP response body the transport reads as JSON; the transport bounds SSE events but reads a
 * JSON response whole. Event streams are left alone: they are long-lived and bounded per event, so a
 * total-byte limit would cut a healthy stream off.
 */
const boundedFetch: McpFetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.body === null || response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    return response;
  }
  const tooLarge = () => new McpError(-32603, `MCP response exceeds ${MAX_MESSAGE_BYTES} bytes`);
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_MESSAGE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw tooLarge();
  }
  let received = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_MESSAGE_BYTES) {
        controller.error(tooLarge());
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

function normalizeSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== undefined && value.type !== "object") return undefined;
  if (value.properties !== undefined && !isRecord(value.properties)) return undefined;
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string"))) return undefined;
  if (!scanSchema(value)) return undefined;
  const normalized = {
    ...value,
    type: "object",
    properties: isRecord(value.properties) ? value.properties : {},
  };
  try {
    Compile(normalized as TSchema);
  } catch {
    return undefined;
  }
  return normalized;
}

function sanitizeDescription(description: unknown, fallback: string): string {
  const text = typeof description === "string" && description.trim() ? description : fallback;
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_DESCRIPTION);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function childEnvironment(server: Extract<McpServerConfig, { transport: "stdio" }>, env: NodeJS.ProcessEnv): Record<string, string> {
  if (server.inheritEnv) return { ...env, ...server.env } as Record<string, string>;
  const names = [
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "NPM_CONFIG_CACHE", "npm_config_cache",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS",
    "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  ];
  const inherited: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, ...server.env };
}

async function connectWithTimeout(
  client: McpClient,
  transport: McpTransport,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("MCP connection aborted");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  // A typed error, so the log reports MCP_TIMEOUT instead of a generic connect failure.
  const timer = setTimeout(() => controller.abort(new McpTimeoutError(timeoutMs)), timeoutMs);
  const stop = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(controller.signal.reason ?? new Error("MCP connection aborted"));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  try {
    await Promise.race([client.connect(transport), stop]);
  } catch (error) {
    // connect() has no signal option; closing the client is what stops the child process or fetch.
    await client.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Safe code for logs; never includes a message, URL, header, or server stderr. */
export function mcpErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && /^GITHUB_[A-Z_]+$/.test(error.code)) return error.code;
  if (error instanceof McpOAuthAuthorizationRequiredError) return "MCP_AUTH_REQUIRED";
  if (error instanceof McpTimeoutError) return "MCP_TIMEOUT";
  if (error instanceof McpConnectionClosedError) return "MCP_CLOSED";
  if (error instanceof McpHttpError) return `MCP_HTTP_${error.status}`;
  if (error instanceof McpError) return "MCP_PROTOCOL";
  if (error instanceof McpAbortError) return "MCP_ABORTED";
  return "MCP_CONNECT_FAILED";
}

function mapMcpToolError(error: unknown, serverName: string): Error {
  // Cancellation belongs to the base's tool task; do not turn it into a business failure.
  if (error instanceof McpAbortError) return error;
  if (error instanceof McpOAuthAuthorizationRequiredError) {
    return coded(`MCP server ${serverName} requires authorization. Run: npm run mcp:auth -- ${serverName}`, "MCP_AUTH_REQUIRED");
  }
  if (error instanceof McpTimeoutError) return coded(`MCP server ${serverName} timed out`, "MCP_TIMEOUT");
  if (error instanceof McpConnectionClosedError) return coded(`MCP server ${serverName} is not connected`, "MCP_CLOSED");
  if (error instanceof McpHttpError) return coded(`MCP server ${serverName} returned HTTP ${error.status}`, `MCP_HTTP_${error.status}`);
  if (error instanceof McpError) return coded(`MCP server ${serverName} returned a protocol error`, "MCP_PROTOCOL");
  return coded(`MCP server ${serverName} call failed`, "MCP_FAILED");
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Bound the untrusted server schema before TypeBox compiles it. The depth walk runs first: JSON.stringify
 * is recursive, so measuring the byte size of a deeply nested document would throw before any bound applied.
 * The walk is iterative for the same reason. References are rejected because the harness validates
 * arguments against this document alone.
 */
function scanSchema(root: Record<string, unknown>): boolean {
  let propertyCount = 0;
  const stack: { value: unknown; level: number }[] = [{ value: root, level: 0 }];
  while (stack.length > 0) {
    const { value, level } = stack.pop()!;
    if (level > MAX_SCHEMA_DEPTH) return false;
    if (Array.isArray(value)) {
      for (const entry of value) stack.push({ value: entry, level: level + 1 });
      continue;
    }
    if (!isRecord(value)) continue;
    if (Object.hasOwn(value, "$ref")) return false;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "properties" && isRecord(entry)) {
        propertyCount += Object.keys(entry).length;
        if (propertyCount > MAX_SCHEMA_PROPERTIES) return false;
      }
      stack.push({ value: entry, level: level + 1 });
    }
  }
  return byteLength(root) <= MAX_SCHEMA_BYTES;
}

/** Byte size of the schema as it would be sent; the depth bound above has already made this safe. */
function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    // Unserializable values (a cycle, or nesting deeper than the walk allowed) are not a usable schema.
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
