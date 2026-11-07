import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { ConfigurationError } from "../errors.js";
import { RPC_MAX_FRAME_BYTES } from "./rpc-protocol.js";

export type RpcClientConfig =
  | {
      readonly transport: "unix";
      readonly socketPath: string;
      readonly connectTimeoutMs: number;
      readonly requestTimeoutMs: number;
      readonly maxFrameBytes: number;
      readonly maxBufferedBytes: number;
    }
  | {
      readonly transport: "tls";
      readonly host: string;
      readonly port: number;
      readonly servername?: string;
      readonly caPath: string;
      readonly certPath: string;
      readonly keyPath: string;
      readonly connectTimeoutMs: number;
      readonly requestTimeoutMs: number;
      readonly maxFrameBytes: number;
      readonly maxBufferedBytes: number;
    };

export type RpcAgentConfig = {
  readonly transport: "unix" | "tls";
  readonly socketPath?: string;
  readonly bind?: string;
  readonly port?: number;
  readonly certPath?: string;
  readonly keyPath?: string;
  readonly caPath?: string;
  readonly clientCertName?: string;
  readonly executionId: string;
  readonly maxSessions: number;
  readonly maxConcurrent: number;
  readonly sessionTtlMs: number;
  readonly heartbeatMs: number;
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly testExecutorEnabled: boolean;
};

export type TlsMaterial = {
  readonly ca: Buffer;
  readonly cert: Buffer;
  readonly key: Buffer;
};

const TLS_PORT_DEFAULT = 9443;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function pathValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key);
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new ConfigurationError(`${key} must not contain control characters`);
  }
  return value;
}

function optionalPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = optional(env, key);
  if (value === undefined) return undefined;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new ConfigurationError(`${key} must not contain control characters`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

function booleanFlag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ConfigurationError(`${key} must be 0, 1, true, or false`);
}

/** Accept `host:port` and `[ipv6]:port`; hostnames are rejected so the bind address is explicit. */
export function parseAddress(value: string): { readonly host: string; readonly port: number } {
  const trimmed = value.trim();
  let host: string;
  let portText: string;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1 || trimmed[end + 1] !== ":") {
      throw new ConfigurationError("address must be [ipv6]:port");
    }
    host = trimmed.slice(1, end);
    portText = trimmed.slice(end + 2);
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0) throw new ConfigurationError("address must be host:port");
    host = trimmed.slice(0, colon);
    portText = trimmed.slice(colon + 1);
  }
  if (isIP(host) === 0) throw new ConfigurationError("address host must be an IP literal");
  if (!/^\d+$/.test(portText)) throw new ConfigurationError("address port must be an integer");
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("address port must be in 1..65535");
  }
  return { host, port };
}

/** A client host token: the name is resolved by the connection itself, so no path or space slips in. */
const CLIENT_HOST = /^[A-Za-z0-9._-]{1,253}$/;

/**
 * A client endpoint may name the agent by DNS; only the agent's own bind address has to be an IP
 * literal, because that is the value an operator can audit. Certificate identity is still checked
 * against the CA and the expected server name, so a name here never widens trust.
 */
export function parseClientAddress(value: string): { readonly host: string; readonly port: number } {
  const trimmed = value.trim();
  let host: string;
  let portText: string;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1 || trimmed[end + 1] !== ":") {
      throw new ConfigurationError("address must be [ipv6]:port");
    }
    host = trimmed.slice(1, end);
    portText = trimmed.slice(end + 2);
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0) throw new ConfigurationError("address must be host:port");
    host = trimmed.slice(0, colon);
    portText = trimmed.slice(colon + 1);
  }
  if (isIP(host) === 0 && !CLIENT_HOST.test(host)) {
    throw new ConfigurationError("address host must be an IP literal or a hostname");
  }
  if (!/^\d+$/.test(portText)) throw new ConfigurationError("address port must be an integer");
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("address port must be in 1..65535");
  }
  return { host, port };
}

function isPrivateOrLoopback(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0]!;
    const second = octets[1]!;
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254);
  }
  if (family === 6) {
    const normalized = host.toLowerCase();
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

function commonClient(env: NodeJS.ProcessEnv): Pick<
  Extract<RpcClientConfig, { transport: "tls" }>,
  "connectTimeoutMs" | "requestTimeoutMs" | "maxFrameBytes" | "maxBufferedBytes"
> {
  return {
    connectTimeoutMs: integer(env, "EXECUTION_RPC_CONNECT_TIMEOUT_MS", 5_000, 100, 60_000),
    requestTimeoutMs: integer(env, "EXECUTION_RPC_REQUEST_TIMEOUT_MS", 30_000, 1, 3_600_000),
    maxFrameBytes: integer(env, "EXECUTION_RPC_MAX_FRAME_BYTES", RPC_MAX_FRAME_BYTES, 1024, 16 * 1024 * 1024),
    maxBufferedBytes: integer(env, "EXECUTION_RPC_MAX_BUFFERED_BYTES", 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  };
}

export function readRpcClientConfig(env: NodeJS.ProcessEnv = process.env): RpcClientConfig {
  const transport = (optional(env, "EXECUTION_RPC_TRANSPORT") ?? "tls") as "unix" | "tls";
  if (transport !== "unix" && transport !== "tls") {
    throw new ConfigurationError("EXECUTION_RPC_TRANSPORT must be unix or tls");
  }
  const common = commonClient(env);
  if (transport === "unix") {
    return { transport, socketPath: pathValue(env, "EXECUTION_RPC_SOCKET"), ...common };
  }
  const address = parseClientAddress(required(env, "EXECUTION_RPC_ADDRESS"));
  const servername = optional(env, "EXECUTION_RPC_SERVER_NAME");
  return {
    transport,
    host: address.host,
    port: address.port,
    ...(servername === undefined ? {} : { servername }),
    caPath: pathValue(env, "EXECUTION_RPC_CA_PATH"),
    certPath: pathValue(env, "EXECUTION_RPC_CERT_PATH"),
    keyPath: pathValue(env, "EXECUTION_RPC_KEY_PATH"),
    ...common,
  };
}

function deriveExecutionId(transport: "unix" | "tls", target: string): string {
  return createHash("sha256").update(`rpc:${transport}:${target}`).digest("hex").slice(0, 16);
}

export function readRpcAgentConfig(env: NodeJS.ProcessEnv = process.env): RpcAgentConfig {
  const socketPath = optionalPath(env, "EXECUTION_AGENT_UNIX_SOCKET");
  const transport: "unix" | "tls" = socketPath === undefined ? "tls" : "unix";
  const bind = transport === "tls" ? required(env, "EXECUTION_AGENT_BIND") : undefined;
  if (bind !== undefined) {
    if (bind === "0.0.0.0" || bind === "::" || bind === "0:0:0:0:0:0:0:0") {
      throw new ConfigurationError("EXECUTION_AGENT_BIND must not be a wildcard address");
    }
    if (isIP(bind) === 0) {
      throw new ConfigurationError("EXECUTION_AGENT_BIND must be an IP literal");
    }
    if (!isPrivateOrLoopback(bind)) {
      throw new ConfigurationError("EXECUTION_AGENT_BIND must be a private or loopback address");
    }
  }
  const port = transport === "tls" ? integer(env, "EXECUTION_AGENT_PORT", TLS_PORT_DEFAULT, 1, 65_535) : undefined;
  let certPath: string | undefined;
  let keyPath: string | undefined;
  let caPath: string | undefined;
  let clientCertName: string | undefined;
  if (transport === "tls") {
    certPath = pathValue(env, "EXECUTION_AGENT_TLS_CERT_PATH");
    keyPath = pathValue(env, "EXECUTION_AGENT_TLS_KEY_PATH");
    caPath = pathValue(env, "EXECUTION_AGENT_TLS_CA_PATH");
    clientCertName = required(env, "EXECUTION_AGENT_CLIENT_CERT_CN");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientCertName)) {
      throw new ConfigurationError("EXECUTION_AGENT_CLIENT_CERT_CN must be 1..128 safe characters");
    }
    if (!booleanFlag(env, "EXECUTION_AGENT_REQUIRE_CLIENT_CERT", true)) {
      throw new ConfigurationError("EXECUTION_AGENT_REQUIRE_CLIENT_CERT must be 1; mTLS is required");
    }
  }
  const target = transport === "unix" ? socketPath! : `${bind}:${port}`;
  const configuredId = optional(env, "EXECUTION_AGENT_ID");
  if (configuredId !== undefined && !/^[a-f0-9]{16}$/.test(configuredId)) {
    throw new ConfigurationError("EXECUTION_AGENT_ID must be 16 lowercase hexadecimal characters");
  }
  return {
    transport,
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(bind === undefined ? {} : { bind }),
    ...(port === undefined ? {} : { port }),
    ...(certPath === undefined ? {} : { certPath }),
    ...(keyPath === undefined ? {} : { keyPath }),
    ...(caPath === undefined ? {} : { caPath }),
    ...(clientCertName === undefined ? {} : { clientCertName }),
    executionId: configuredId ?? deriveExecutionId(transport, target),
    maxSessions: integer(env, "EXECUTION_AGENT_MAX_SESSIONS", 16, 1, 1024),
    maxConcurrent: integer(env, "EXECUTION_AGENT_MAX_CONCURRENT", 4, 1, 256),
    sessionTtlMs: integer(env, "EXECUTION_AGENT_SESSION_TTL_MS", 270_000, 1_000, 24 * 60 * 60 * 1_000),
    heartbeatMs: integer(env, "EXECUTION_AGENT_HEARTBEAT_MS", 15_000, 100, 300_000),
    maxFrameBytes: integer(env, "EXECUTION_AGENT_MAX_FRAME_BYTES", RPC_MAX_FRAME_BYTES, 1024, 16 * 1024 * 1024),
    maxBufferedBytes: integer(env, "EXECUTION_AGENT_MAX_BUFFERED_BYTES", 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    testExecutorEnabled: booleanFlag(env, "EXECUTION_AGENT_TEST_EXECUTOR", true),
  };
}

/** Operator-facing summary; certificate contents and private keys are never included. */
export function describeRpcAgentConfig(config: RpcAgentConfig): Record<string, unknown> {
  return {
    status: "execution-agent-check",
    transport: config.transport,
    ...(config.transport === "unix"
      ? { socketPath: config.socketPath }
      : {
          bind: config.bind,
          port: config.port,
          certPath: config.certPath,
          keyPath: config.keyPath,
          caPath: config.caPath,
          requireClientCert: true,
          clientCertName: config.clientCertName,
        }),
    executionId: config.executionId,
    maxSessions: config.maxSessions,
    maxConcurrent: config.maxConcurrent,
    sessionTtlMs: config.sessionTtlMs,
    heartbeatMs: config.heartbeatMs,
    maxFrameBytes: config.maxFrameBytes,
    maxBufferedBytes: config.maxBufferedBytes,
    testExecutorEnabled: config.testExecutorEnabled,
  };
}

export async function readTlsMaterial(config: {
  readonly caPath: string;
  readonly certPath: string;
  readonly keyPath: string;
}): Promise<TlsMaterial> {
  const [ca, cert, key] = await Promise.all([
    readFile(config.caPath),
    readFile(config.certPath),
    readFile(config.keyPath),
  ]);
  return { ca, cert, key };
}
