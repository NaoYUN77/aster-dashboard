import { ConfigurationError, readConfig } from "./config.js";
import { readMcpConfig } from "./mcp-config.js";
import { createProviderModels, requireModel } from "./providers.js";

// Offline configuration check for an Aster image. Exits non-zero when a required
// setting is missing, the provider is unknown, or MODEL_ID is absent from the provider catalog.
try {
  const config = readConfig();
  requireModel(createProviderModels(config.provider), config.provider, config.model);
  const mcp = await readMcpConfig(config.mcpConfigPath, config.mcpConfigExplicit);
  // Match the runtime: a broken optional default file disables MCP instead of blocking startup, so it
  // must not block deployment preflight either. Only an explicitly configured file is required.
  if (mcp.error !== undefined) {
    if (config.mcpConfigExplicit) throw new ConfigurationError(mcp.error);
    console.error(`MCP config invalid; MCP would be disabled: ${mcp.error}`);
  }
  for (const warning of mcp.warnings) console.error(`MCP config warning: ${warning}`);
  const servers = mcp.config?.servers.length ?? 0;
  console.info(`Configuration OK: MODEL_PROVIDER=${config.provider} MODEL_ID=${config.model} MCP_SERVERS=${servers}`);
} catch (error) {
  // ConfigurationError messages contain variable names only, never credential values.
  console.error(error instanceof ConfigurationError ? error.message : "Configuration check failed");
  process.exitCode = 1;
}
