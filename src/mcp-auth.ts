import {
  authorizeMcp,
  OAuthCallbackServer,
  OAuthError,
} from "@earendil-works/pi-mcp/oauth";
import { configureEnvProxy, resolveMcpConfigPaths } from "./config.js";
import { createOAuthProvider, mcpAuthFlowOptions, openMcpConnection } from "./mcp.js";
import { readMcpConfig, type McpAuthConfig, type McpServerConfig } from "./mcp-config.js";

// The callback URL is opened in the operator's browser; keep the window short but workable.
const CALLBACK_TIMEOUT_MS = 10 * 60_000;

/**
 * Authorize one remote MCP server. The bot never opens a callback port: it only refreshes and uses
 * tokens stored under DATA_DIR. Run this while the bot is stopped so both processes do not race on
 * the token file.
 */
async function main(): Promise<void> {
  configureEnvProxy();
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run mcp:auth -- <server>");
    process.exitCode = 1;
    return;
  }

  // Same resolution as the bot, so MCP_CONFIG and DATA_DIR are read from one place and cannot disagree.
  const { dataDir, mcpConfigPath, mcpConfigExplicit } = resolveMcpConfigPaths();
  const read = await readMcpConfig(mcpConfigPath, mcpConfigExplicit);
  if (read.error !== undefined) {
    console.error(read.error);
    process.exitCode = 1;
    return;
  }
  for (const warning of read.warnings) console.error(`MCP config: ${warning}`);
  if (read.config === undefined) {
    console.error(`No MCP configuration found at ${mcpConfigPath}.`);
    process.exitCode = 1;
    return;
  }

  const oauthServers = read.config.servers.filter(isOAuthServer);
  const server = oauthServers.find((entry) => entry.name === target);
  if (server === undefined) {
    const available = oauthServers.map((entry) => entry.name);
    console.error(available.length === 0
      ? "No MCP server in the configuration uses OAuth."
      : `No OAuth MCP server named ${target}. Available: ${available.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const auth = server.auth;
  const callbackServer = await OAuthCallbackServer.listen({
    host: "127.0.0.1",
    port: auth.redirectPort,
    timeoutMs: CALLBACK_TIMEOUT_MS,
  });
  try {
    let authorizationUrl: URL | undefined;
    const provider = createOAuthProvider(server, dataDir, (url) => {
      authorizationUrl = url;
    });
    const state = await provider.state();
    const flow = {
      serverUrl: server.url,
      ...(auth.scope === undefined ? {} : { scope: auth.scope }),
      ...mcpAuthFlowOptions(auth),
    };

    const first = await authorizeMcp(provider, flow);
    if (first === "REDIRECT") {
      if (authorizationUrl === undefined) throw new Error("MCP authorization produced no redirect URL");
      console.info(`Open this URL to authorize ${server.name}:`);
      console.info(authorizationUrl.href);
      console.info(`Waiting for the callback on ${provider.redirectUrl} ...`);
      const callback = await callbackServer.waitForCallback(state);
      await authorizeMcp(provider, {
        ...flow,
        authorizationCode: callback.code,
        ...(callback.iss === undefined ? {} : { iss: callback.iss }),
      });
    }

    const connection = await openMcpConnection(server, { dataDir, env: process.env });
    try {
      const tools = await connection.listTools();
      console.info(`MCP server ${server.name} is authorized; ${tools.length} tools available.`);
    } finally {
      await connection.close();
    }
  } finally {
    await callbackServer.close();
  }
}

type OAuthServer = Extract<McpServerConfig, { transport: "http" }> & { auth: McpAuthConfig };

function isOAuthServer(server: McpServerConfig): server is OAuthServer {
  return server.transport === "http" && server.auth !== undefined;
}

try {
  await main();
} catch (error) {
  // Errors can carry URLs and server responses; print the kind, not the payload.
  if (error instanceof OAuthError) {
    console.error(`MCP authorization failed: ${error.code}`);
  } else {
    // A network failure is the common cause and its message is opaque ("fetch failed"); the syscall code
    // (ECONNRESET, ENOTFOUND) says what to check without exposing any endpoint or response body.
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const code = typeof cause?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(cause.code) ? cause.code : undefined;
    console.error(code === undefined ? "MCP authorization failed." : `MCP authorization failed: network error (${code})`);
  }
  process.exitCode = 1;
}
