import { ConfigurationError } from "../errors.js";
import { MAX_TIMEOUT_SECONDS } from "./protocol.js";

/** SSH baseline for the host-side broker: explicit target, key and known-hosts paths, no agent assumptions. */
export type SshConfig = {
  readonly binary: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  /** Replaces the per-user SSH config; absent means `/dev/null` so host aliases cannot change the target silently. */
  readonly configPath?: string;
  readonly keyPath?: string;
  readonly knownHostsPath: string;
  readonly connectTimeoutSeconds: number;
};

export type BrokerConfig = {
  readonly socketPath: string;
  readonly ssh: SshConfig;
  readonly maxConcurrent: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  readonly requestTimeoutMs: number;
};

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/i;
/** Paths become SSH option values; whitespace would change option parsing. */
const SAFE_PATH = /^\/[^\0\r\n \t]*$/;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
  return value;
}

function optionalPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  if (!SAFE_PATH.test(value)) {
    throw new ConfigurationError(`${key} must be an absolute path without whitespace or control characters`);
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

export function readBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const socketPath = required(env, "EXECUTION_BROKER_SOCKET");
  if (!SAFE_PATH.test(socketPath)) {
    throw new ConfigurationError("EXECUTION_BROKER_SOCKET must be an absolute path without whitespace or control characters");
  }
  const host = required(env, "EXECUTION_SSH_HOST");
  if (!HOST_PATTERN.test(host)) {
    throw new ConfigurationError("EXECUTION_SSH_HOST must be a host name or address without shell metacharacters");
  }
  const user = required(env, "EXECUTION_SSH_USER");
  if (!USER_PATTERN.test(user)) {
    throw new ConfigurationError("EXECUTION_SSH_USER must be a POSIX user name");
  }
  const port = integer(env, "EXECUTION_SSH_PORT", 22, 1, 65_535);
  const connectTimeoutSeconds = integer(env, "EXECUTION_SSH_CONNECT_TIMEOUT_SECONDS", 10, 1, 120);
  const knownHostsPath = optionalPath(env, "EXECUTION_SSH_KNOWN_HOSTS_PATH");
  if (knownHostsPath === undefined) {
    // Without a pinned known-hosts file, StrictHostKeyChecking would either trust nothing or trust too much.
    throw new ConfigurationError("Missing configuration: EXECUTION_SSH_KNOWN_HOSTS_PATH");
  }
  const configPath = optionalPath(env, "EXECUTION_SSH_CONFIG_PATH");
  const keyPath = optionalPath(env, "EXECUTION_SSH_KEY_PATH");
  return {
    socketPath,
    ssh: {
      binary: env.EXECUTION_SSH_BIN?.trim() || "ssh",
      host,
      user,
      port,
      ...(configPath === undefined ? {} : { configPath }),
      ...(keyPath === undefined ? {} : { keyPath }),
      knownHostsPath,
      connectTimeoutSeconds,
    },
    maxConcurrent: integer(env, "EXECUTION_BROKER_MAX_CONCURRENT", 4, 1, 32),
    maxOutputBytes: integer(env, "EXECUTION_BROKER_MAX_OUTPUT_BYTES", 4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    maxOutputLines: integer(env, "EXECUTION_BROKER_MAX_OUTPUT_LINES", 100_000, 1, 1_000_000),
    requestTimeoutMs: integer(env, "EXECUTION_BROKER_REQUEST_TIMEOUT_MS", 15_000, 1_000, 60_000),
  };
}

/** A dry-run summary an operator can check without opening a socket or executing SSH. */
export function describeBrokerConfig(config: BrokerConfig): Record<string, unknown> {
  return {
    status: "execution-broker-check",
    socket: config.socketPath,
    ssh: {
      binary: config.ssh.binary,
      host: config.ssh.host,
      user: config.ssh.user,
      port: config.ssh.port,
      configPath: config.ssh.configPath ?? null,
      keyPath: config.ssh.keyPath ?? null,
      knownHostsPath: config.ssh.knownHostsPath,
      connectTimeoutSeconds: config.ssh.connectTimeoutSeconds,
    },
    maxConcurrent: config.maxConcurrent,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  };
}
