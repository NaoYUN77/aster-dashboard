// Entry point of the `aster-sandbox` container: the RPC execution agent the app connects to over a
// Unix socket, with the container itself as the sandbox.
//
// Interface: reads `ASTER_SANDBOX_*` from the environment and serves the same RPC protocol as
// `rpc-main` — sessions, bash, file primitives and (when enabled) the PTC runner.
//
// Inputs: the socket path, the mounted `/workspaces` root, a tmp root, and the concurrency bound.
// It never reads the control plane's database or secrets; the only thing it shares is the socket
// volume and the workspaces mount.
//
// Errors: an unusable mount, socket or PTC runtime stops the process at startup. Once listening,
// every failure is answered per request; the agent never falls back to unconfined execution.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigurationError } from "../errors.js";
import { ContainerDirectHost, ensureWorkspace, containerWorkspacePath } from "./container-executor.js";
import { runnerEnvironment } from "./ptc-bwrap.js";
import { readPtcConfig, type PtcConfig } from "./ptc-config.js";
import { PtcExecutor, type ContainerPtcRuntime } from "./ptc-executor.js";
import { PtcHostError } from "./ptc-host.js";
import { PTC_OUTPUT_DIRECTORY } from "./ptc-workspace.js";
import { startRpcAgent } from "./rpc-server.js";
import { listenUnixRpc } from "./rpc-transport.js";

const USAGE = `Usage: node dist/src/execution/sandbox-main.js [--check]

Reads ASTER_SANDBOX_* from the environment:
  ASTER_SANDBOX_SOCKET        Unix socket to listen on (required)
  ASTER_SANDBOX_WORKSPACES    mounted workspace root (default /workspaces)
  ASTER_SANDBOX_TMP_ROOT      root for per-session private /tmp (default /tmp/aster-sessions)
  ASTER_SANDBOX_CONCURRENCY   concurrent bash/PTC executions (default 3)
  ASTER_SANDBOX_MAX_SESSIONS  live sessions per connection (default 32)
  ASTER_SANDBOX_PTC           0 disables the code mode sandbox (default 1)
  ASTER_SANDBOX_EXECUTION_ID  16 lowercase hex characters (default derived from the socket)
  ASTER_SANDBOX_SHELL         shell for commands (default /bin/sh)
  ASTER_SANDBOX_PATH          PATH inside the sandbox (default /usr/local/bin:/usr/bin:/bin)
Compose mounts /data/workspaces at ASTER_SANDBOX_WORKSPACES; no other host path is visible.
`;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing configuration: ${name}`);
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
    throw new ConfigurationError(`${name} must be an absolute path without '..'`);
  }
  return value.replace(/\/+$/, "") || "/";
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function booleanFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new ConfigurationError(`${name} must be 0 or 1`);
}

/** The container layout, validated before anything listens. */
type SandboxConfig = {
  readonly socketPath: string;
  readonly workspacesRoot: string;
  readonly tmpRoot: string;
  readonly concurrency: number;
  readonly maxSessions: number;
  readonly ptc: boolean;
  readonly executionId: string;
  readonly shellPath: string;
  readonly path: string;
};

function readSandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
  const socketPath = required(env, "ASTER_SANDBOX_SOCKET");
  const workspacesRoot = required(env, "ASTER_SANDBOX_WORKSPACES");
  const tmpRoot = required(env, "ASTER_SANDBOX_TMP_ROOT");
  const shellPath = required(env, "ASTER_SANDBOX_SHELL");
  const configuredId = env.ASTER_SANDBOX_EXECUTION_ID?.trim();
  if (configuredId !== undefined && configuredId !== "" && !/^[a-f0-9]{16}$/.test(configuredId)) {
    throw new ConfigurationError("ASTER_SANDBOX_EXECUTION_ID must be 16 lowercase hexadecimal characters");
  }
  return {
    socketPath,
    workspacesRoot,
    tmpRoot,
    concurrency: integer(env, "ASTER_SANDBOX_CONCURRENCY", 3, 1, 16),
    maxSessions: integer(env, "ASTER_SANDBOX_MAX_SESSIONS", 32, 1, 1_024),
    ptc: booleanFlag(env, "ASTER_SANDBOX_PTC", true),
    executionId: configuredId === undefined || configuredId === ""
      ? createHash("sha256").update(`sandbox:${socketPath}`).digest("hex").slice(0, 16)
      : configuredId,
    shellPath,
    path: env.ASTER_SANDBOX_PATH?.trim() || "/usr/local/bin:/usr/bin:/bin",
  };
}

/** PTC inside the container: the bot's own directory is the workspace, `/tmp` is per session. */
function containerPtc(config: PtcConfig, sandbox: SandboxConfig): ContainerPtcRuntime {
  return {
    async open({ sessionId, cwd, workspaceReady }) {
      const hostPath = containerWorkspacePath(sandbox.workspacesRoot, cwd);
      const existed = await stat(hostPath).then(() => true).catch(() => false);
      if (workspaceReady && !existed) {
        throw new PtcHostError(
          "workspace_missing",
          "the workspace is gone although workspaceReady was committed; refusing to start with an empty directory",
          "not_started",
        );
      }
      await ensureWorkspace(sandbox.workspacesRoot, hostPath);
      const tmpPath = await mkdtemp(join(sandbox.tmpRoot, `ptc-${sessionId.slice(0, 8)}-`));
      await mkdir(join(hostPath, ...PTC_OUTPUT_DIRECTORY.split("/")), { recursive: true, mode: 0o700 });
      return {
        hostPath,
        tmpPath,
        workspace: { path: "/workspace", created: !existed, reused: existed },
      };
    },
    command({ hostPath, tmpPath }) {
      return {
        file: process.execPath,
        args: [...runnerArgs(config.runnerEntry)],
        env: {
          ...runnerEnvironment(config, hostPath, { tmpPath }),
          PTC_RUNNER_SHELL: sandbox.shellPath,
          HOME: hostPath,
          TMPDIR: tmpPath,
          PATH: config.nodePath,
          LANG: "C.UTF-8",
          PTC_INSIDE_SANDBOX: "1",
        },
      };
    },
  };
}

/** The runner is plain JavaScript in the deployment image and TypeScript in development. */
function runnerArgs(entry: string): string[] {
  return entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const sandbox = readSandboxConfig(process.env);
  const info = await stat(sandbox.workspacesRoot).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new ConfigurationError(`${sandbox.workspacesRoot} must be a mounted directory`);
  }
  await mkdir(sandbox.tmpRoot, { recursive: true, mode: 0o700 });
  await mkdir(dirname(sandbox.socketPath), { recursive: true });

  let ptc: PtcExecutor | undefined;
  let ptcConfig: PtcConfig | undefined;
  if (sandbox.ptc) {
    ptcConfig = readPtcConfig({
      ...process.env,
      PTC_ENABLED: "1",
      PTC_ISOLATION: "container",
      PTC_WORKSPACE_ROOT: sandbox.workspacesRoot,
      PTC_DIRECT_TMP_ROOT: sandbox.tmpRoot,
    });
    if (ptcConfig === undefined) throw new ConfigurationError("PTC_ENABLED must be 1 in the sandbox");
    ptc = new PtcExecutor({ config: ptcConfig, container: containerPtc(ptcConfig, sandbox) });
  }
  const direct = new ContainerDirectHost({
    workspacesRoot: sandbox.workspacesRoot,
    tmpRoot: sandbox.tmpRoot,
    path: sandbox.path,
    shellPath: sandbox.shellPath,
    outputChunkBytes: ptcConfig?.outputChunkBytes ?? 32 * 1024,
    outputBytesPerSecond: ptcConfig?.outputBytesPerSecond ?? 0,
  });
  const checks = { direct: await direct.preflight(), ...(ptc === undefined ? {} : { ptc: await ptc.preflight() }) };
  if (process.argv.includes("--check")) {
    process.stdout.write(`${JSON.stringify({ status: "sandbox-check", ...sandbox, checks }, null, 2)}\n`);
    return;
  }

  const server = await listenUnixRpc(sandbox.socketPath);
  const agent = startRpcAgent({
    server,
    executionId: sandbox.executionId,
    transport: "unix",
    maxSessions: sandbox.maxSessions,
    // Bash and PTC share this bound; the app holds one connection, so it is the deployment's
    // global concurrency limit rather than a per-bot one.
    maxConcurrent: sandbox.concurrency,
    testExecutorEnabled: false,
    direct,
    ...(ptc === undefined ? {} : { ptc }),
  });
  console.info(`Sandbox listening on unix ${sandbox.socketPath}; executionId ${sandbox.executionId}`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    agent.close()
      .then(() => direct.closeAll())
      .then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await main();
} catch (error) {
  console.error("Sandbox stopped:",
    error instanceof ConfigurationError ? error.message : "SANDBOX_FAILED");
  process.exitCode = 1;
}
