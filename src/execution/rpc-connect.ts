import { RpcExecutionClient } from "./rpc-client.js";
import { readTlsMaterial, type RpcClientConfig } from "./rpc-config.js";
import { tlsRpcTransport, unixRpcTransport, type RpcClientTransport } from "./rpc-transport.js";

/**
 * Build and connect the gateway-side RPC client for a validated configuration. Connecting is a
 * startup dependency: a gateway that cannot reach its agent must fail closed instead of letting the
 * model plan work that can never run.
 */
export async function connectRpcClient(config: RpcClientConfig): Promise<RpcExecutionClient> {
  let transport: RpcClientTransport;
  if (config.transport === "unix") {
    transport = unixRpcTransport(config.socketPath, {
      connectTimeoutMs: config.connectTimeoutMs,
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
    });
  } else {
    const material = await readTlsMaterial(config);
    transport = tlsRpcTransport({
      host: config.host,
      port: config.port,
      ...(config.servername === undefined ? {} : { servername: config.servername }),
      ca: material.ca,
      cert: material.cert,
      key: material.key,
      connectTimeoutMs: config.connectTimeoutMs,
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
    });
  }
  const client = new RpcExecutionClient({
    transport,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  await client.connect();
  return client;
}
