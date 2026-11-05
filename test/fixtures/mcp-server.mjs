// Minimal MCP server over stdio for the integration test. One JSON-RPC message per line.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  const id = message.id;
  switch (message.method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      } };
    case "notifications/initialized":
      return undefined;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [
        {
          name: "echo",
          description: "Echo the given text back.",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
        {
          name: "env",
          description: "Read one child-process environment variable.",
          inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        },
        {
          // A remote schema that cannot be an argument object; the adapter must skip this tool.
          name: "bad_schema",
          inputSchema: { type: "array", items: { type: "string" } },
        },
      ] } };
    case "tools/call": {
      // Test-only fault injection; intentionally absent from tools/list.
      if (message.params?.name === "exit") process.exit(23);
      const args = message.params?.arguments ?? {};
      if (message.params?.name === "echo") {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } };
      }
      if (message.params?.name === "env") {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: process.env[args.key] ?? "" }] } };
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } };
    }
    default:
      return id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } };
  }
}

for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("unparseable message\n");
    continue;
  }
  const response = handle(message);
  if (response !== undefined) send(response);
}
