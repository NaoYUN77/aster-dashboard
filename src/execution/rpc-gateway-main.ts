// Entrypoint for the host-network execution gateway container.
//
// The app container is restricted to the internal MITM network and reaches the execution VPS only
// through this process: the app connects to a Unix socket (EXECUTION_RPC_TRANSPORT=unix) and the
// gateway relays the same RPC stream over private TCP with the `aster-gateway` mTLS certificate.
// The client key stays in this container; the app container never receives it.

import { ConfigurationError } from "../errors.js";
import { readRpcClientConfig, readTlsMaterial } from "./rpc-config.js";
import { startRpcGateway, type RpcGatewayLogEvent } from "./rpc-gateway.js";
import { connectTlsSocket } from "./rpc-transport.js";

const USAGE = `Usage: node dist/src/execution/rpc-gateway-main.js [--check]

Reads EXECUTION_RPC_GATEWAY_* plus the TLS client settings (EXECUTION_RPC_ADDRESS,
EXECUTION_RPC_SERVER_NAME, EXECUTION_RPC_CA_PATH, EXECUTION_RPC_CERT_PATH, EXECUTION_RPC_KEY_PATH).
The gateway listens on EXECUTION_RPC_GATEWAY_SOCKET and relays each accepted Unix connection to the
agent over private TCP with mutual TLS. --check validates the configuration and reads the TLS
material without listening or connecting.
`;

function requiredPath(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value === "") throw new ConfigurationError(`Missing configuration: ${key}`);
  if (!value.startsWith("/") || /[\u0000-\u001f]/.test(value) || value.includes("\\")) {
    throw new ConfigurationError(`${key} must be an absolute POSIX path without control characters`);
  }
  return value;
}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

type GatewayConfig = {
  readonly socketPath: string;
  readonly maxConnections: number;
  readonly upstream: Extract<ReturnType<typeof readRpcClientConfig>, { transport: "tls" }>;
};

function readGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const socketPath = requiredPath(env, "EXECUTION_RPC_GATEWAY_SOCKET");
  const maxConnections = boundedInteger(env, "EXECUTION_RPC_GATEWAY_MAX_CONNECTIONS", 4, 1, 64);
  const upstream = readRpcClientConfig(env);
  if (upstream.transport !== "tls") {
    throw new ConfigurationError("EXECUTION_RPC_TRANSPORT must be tls for the RPC gateway");
  }
  return { socketPath, maxConnections, upstream };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = readGatewayConfig();
  const material = await readTlsMaterial(config.upstream);
  if (process.argv.includes("--check")) {
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      transport: "tls",
      upstream: `${config.upstream.host}:${config.upstream.port}`,
      servername: config.upstream.servername ?? null,
      socketPath: config.socketPath,
      maxConnections: config.maxConnections,
      caPath: config.upstream.caPath,
      certPath: config.upstream.certPath,
      keyPath: config.upstream.keyPath,
    }, null, 2)}\n`);
    return;
  }
  const log = (event: RpcGatewayLogEvent): void => {
    console.error(JSON.stringify(event));
  };
  const gateway = await startRpcGateway({
    socketPath: config.socketPath,
    maxConnections: config.maxConnections,
    connectUpstream: async () => {
      const socket = await connectTlsSocket({
        host: config.upstream.host,
        port: config.upstream.port,
        ...(config.upstream.servername === undefined ? {} : { servername: config.upstream.servername }),
        ca: material.ca,
        cert: material.cert,
        key: material.key,
        connectTimeoutMs: config.upstream.connectTimeoutMs,
      });
      socket.setNoDelay(true);
      return socket;
    },
    log,
  });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log({ event: "rpc-gateway-stopping", signal });
    gateway.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  // The listening server keeps the event loop alive until the signal handler closes it.
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigurationError
    ? error.message
    : error instanceof Error && error.message.startsWith("refusing to replace") ? error.message : "gateway startup failed";
  process.stderr.write(`${JSON.stringify({ event: "rpc-gateway-failed", error: message })}\n`);
  process.exitCode = 1;
});
