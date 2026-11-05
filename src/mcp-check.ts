import { configureEnvProxy, resolveMcpConfigPaths } from "./config.js";
import { mcpErrorCode, openMcpConnection } from "./mcp.js";
import { readMcpConfig } from "./mcp-config.js";
import { openGithubGate } from "./github-gate.js";

/**
 * Connect every configured MCP server, list its tools, and close. This is the deployment smoke test:
 * it exercises the same command, environment, network, and token paths as the bot without Telegram or a
 * model. Run it as the service user so the sandbox and file ownership match the service.
 */
async function main(): Promise<void> {
  configureEnvProxy();
  // Same resolution as the bot, so MCP_CONFIG and DATA_DIR are read from one place and cannot disagree.
  const { dataDir, mcpConfigPath: configPath, mcpConfigExplicit } = resolveMcpConfigPaths();
  const read = await readMcpConfig(configPath, mcpConfigExplicit);
  if (read.error !== undefined) {
    console.error(read.error);
    process.exitCode = 1;
    return;
  }
  for (const warning of read.warnings) console.error(`MCP config: ${warning}`);
  if (read.config === undefined) {
    console.error(`No MCP configuration found at ${configPath}.`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  await Promise.all(read.config.servers.map(async (server) => {
    try {
      const connection = await openMcpConnection(server, { dataDir, env: process.env });
      try {
        const tools = await connection.listTools();
        if (server.transport === "http" && server.githubPolicy) {
          await openGithubGate(connection, server.githubPolicy, tools, dataDir);
          console.info(`${server.name}: declaration approval verified; read operations and PAT permissions are not exercised by this check`);
        }
        console.info(`${server.name} (${server.transport}): ${tools.length} tools`);
        for (const tool of tools) console.info(`  ${printable(tool.name)}`);
      } finally {
        await connection.close();
      }
    } catch (error) {
      failed++;
      console.error(`${server.name}: unavailable (${mcpErrorCode(error)})`);
    }
  }));
  if (failed > 0) process.exitCode = 1;
}

// Tool names come from the server; keep terminal output free of control sequences.
function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?");
}

try {
  await main();
} catch {
  // The error may carry a URL or server response; report the failure without the payload.
  console.error("MCP check failed.");
  process.exitCode = 1;
}
