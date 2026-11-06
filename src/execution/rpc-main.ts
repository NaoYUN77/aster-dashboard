import { mkdir, stat } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { ConfigurationError } from "../errors.js";
import { describeRpcAgentConfig, readRpcAgentConfig, readTlsMaterial } from "./rpc-config.js";
import { probePtcRuntime, type PtcRuntimeProbe } from "./ptc-cgroup.js";
import { readPtcConfig, type PtcConfig } from "./ptc-config.js";
import { DirectExecutor } from "./direct-executor.js";
import { PtcExecutor } from "./ptc-executor.js";
import {
  assertNotRoot, describeSharedHostConfig, readSharedHostConfig, SharedHostDirectHost,
} from "./shared-host.js";
import { startRpcAgent } from "./rpc-server.js";
import { listenTlsRpc, listenUnixRpc, type RpcServer } from "./rpc-transport.js";

const USAGE = `Usage: node dist/src/execution/rpc-main.js [--check]

Reads EXECUTION_AGENT_* from the environment. --check validates the bind address, limits, and
TLS material without listening or executing anything. TCP mode requires a private or loopback IP
and mutual TLS; Unix mode is intended for local tests or same-host deployments.

Phase 1 shared host (single-user MVP): EXECUTION_AGENT_SHARED_HOST=1 serves Bash / Read / Write /
Edit on one shared Computer / Execution Host with no OS-level isolation. It must run as a dedicated
non-root user and does not start bwrap, cgroups or PTC. EXECUTION_AGENT_WORKSPACES (default: none,
required), EXECUTION_AGENT_TMP_ROOT, EXECUTION_AGENT_SHELL and EXECUTION_AGENT_PATH configure it.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = readRpcAgentConfig();
  const shared = readSharedHostConfig();
  if (shared !== undefined) assertNotRoot();
  let ptcConfig: PtcConfig | undefined;
  if (shared !== undefined) {
    const ptcRaw = process.env.PTC_ENABLED?.trim();
    if (ptcRaw !== undefined && ptcRaw !== "" && ptcRaw !== "0") {
      throw new ConfigurationError(
        "shared host mode is Phase 1 (Bash / Read / Write / Edit only); set PTC_ENABLED=0",
      );
    }
  } else {
    ptcConfig = readPtcConfig();
  }
  let ptc: PtcExecutor | undefined;
  let direct: DirectExecutor | SharedHostDirectHost | undefined;
  let ptcChecks: Record<string, boolean | null> | undefined;
  let directChecks: Record<string, boolean | null> | undefined;
  let probe: PtcRuntimeProbe | undefined;
  if (ptcConfig !== undefined) {
    probe = await probePtcRuntime(ptcConfig);
    ptc = new PtcExecutor({ config: ptcConfig, probe });
    ptcChecks = await ptc.preflight();
    // Direct sessions share the PTC runtime probe; they are only advertised when isolation,
    // `/shared` and the per-session tmp root are all usable.
    direct = new DirectExecutor({ config: ptcConfig, probe });
    directChecks = await direct.preflight();
  } else if (shared !== undefined) {
    const info = await stat(shared.workspacesRoot).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      throw new ConfigurationError(`${shared.workspacesRoot} must be an existing directory owned by the execution user`);
    }
    await mkdir(shared.tmpRoot, { recursive: true, mode: 0o700 });
    direct = new SharedHostDirectHost(shared);
    directChecks = await direct.preflight();
  }
  const checkReport = (): string => `${JSON.stringify({
    ...describeRpcAgentConfig(config),
    // The cgroup reason is the operator's only clue when the unit's delegation is wrong; the
    // booleans alone cannot say whether the root, the controllers or the migration was refused.
    ...(ptcChecks === undefined ? {} : {
      ptc: probe?.cgroupReason === undefined ? ptcChecks : { ...ptcChecks, cgroupReason: probe.cgroupReason },
    }),
    ...(shared === undefined ? {} : { sharedHost: describeSharedHostConfig(shared) }),
    ...(directChecks === undefined ? {} : { direct: directChecks }),
  }, null, 2)}\n`;
  let server: RpcServer;
  let transport: "unix" | "tls" = config.transport;
  if (config.transport === "unix") {
    if (config.socketPath === undefined) throw new ConfigurationError("EXECUTION_AGENT_UNIX_SOCKET is required");
    if (process.argv.includes("--check")) {
      process.stdout.write(checkReport());
      return;
    }
    server = await listenUnixRpc(config.socketPath, {
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
    });
  } else {
    if (config.bind === undefined || config.port === undefined
      || config.certPath === undefined || config.keyPath === undefined || config.caPath === undefined
      || config.clientCertName === undefined) {
      throw new ConfigurationError("TCP mode requires EXECUTION_AGENT_BIND, EXECUTION_AGENT_PORT, and TLS paths");
    }
    const material = await readTlsMaterial({
      certPath: config.certPath,
      keyPath: config.keyPath,
      caPath: config.caPath,
    });
    // Fail before listening if a PEM file is unreadable or does not form a usable context.
    createSecureContext({ cert: material.cert, key: material.key, ca: material.ca });
    if (process.argv.includes("--check")) {
      process.stdout.write(checkReport());
      return;
    }
    server = await listenTlsRpc({
      host: config.bind,
      port: config.port,
      cert: material.cert,
      key: material.key,
      ca: material.ca,
      requireClientCert: true,
      allowedClientNames: [config.clientCertName],
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
    });
    transport = "tls";
  }
  if (ptc !== undefined && !ptc.enabled) {
    // Refusing to listen is the only fail-closed answer: a host that cannot isolate must not
    // advertise the Phase 1 surface at all.
    throw new ConfigurationError(
      "PTC is enabled but this host cannot provide bwrap, user namespaces and cgroup v2 (or an explicitly allowed degraded fallback)"
        + (probe?.cgroupReason === undefined ? "" : `: ${probe.cgroupReason}`),
    );
  }
  if (direct !== undefined && ptcConfig?.directEnabled === true && !direct.enabled) {
    // A gateway would otherwise open direct sessions that fail per request; refuse to advertise it.
    throw new ConfigurationError(
      "PTC_DIRECT_ENABLED is set but this host cannot provide bwrap, user namespaces, cgroup v2, a readable shared workspace and a writable tmp root"
        + (probe?.cgroupReason === undefined ? "" : `: ${probe.cgroupReason}`),
    );
  }
  const agent = startRpcAgent({
    server,
    executionId: config.executionId,
    transport,
    maxSessions: config.maxSessions,
    maxConcurrent: config.maxConcurrent,
    sessionTtlMs: config.sessionTtlMs,
    heartbeatMs: config.heartbeatMs,
    // The shared host is a Phase 1 production surface: no Phase 0 test executor is advertised.
    testExecutorEnabled: shared === undefined ? config.testExecutorEnabled : false,
    ...(ptc === undefined ? {} : { ptc }),
    ...(direct === undefined ? {} : { direct }),
  });
  const address = server.address();
  const target = "path" in address ? address.path : `${address.host}:${address.port}`;
  console.info(`Execution agent listening on ${transport} ${target}; executionId ${config.executionId}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    agent.close()
      .then(() => direct?.closeAll())
      .then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await main();
} catch (error) {
  // Operator-facing messages are limited to configuration errors. TLS/library errors may contain
  // paths or other host details, so they are reported with a fixed code only.
  console.error("Execution agent stopped:",
    error instanceof ConfigurationError ? error.message : "AGENT_FAILED");
  process.exitCode = 1;
}
