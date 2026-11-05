import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "../errors.js";

/** A stable job identity derived by the control plane: `ptc-` plus 32 hex characters. */
export const PTC_JOB_ID_PATTERN = /^ptc-[a-f0-9]{32}$/;

export type PtcConfig = {
  readonly workspaceRoot: string;
  readonly sharedWorkspace: string | undefined;
  readonly sharedWorkspaceMode: "none" | "ro" | "rw";
  /** Direct RPC bash/file sessions; opt-in because they expose `/shared` to the control plane. */
  readonly directEnabled: boolean;
  /** Root for per-session host `/tmp` directories; never shared between sessions. */
  readonly directTmpRoot: string;
  readonly cgroupRoot: string;
  readonly cgroupMemoryMaxBytes: number;
  readonly cgroupPidsMax: number;
  readonly cgroupCpuMax: string;
  readonly outputChunkBytes: number;
  readonly outputBytesPerSecond: number;
  readonly nestedOutputMaxBytes: number;
  readonly nestedOutputMaxLines: number;
  readonly spillMaxBytes: number;
  readonly allowDegraded: boolean;
  readonly jobRetentionHours: number;
  readonly bwrapPath: string;
  /** Read-only root that holds the runner entry and its `node_modules`. */
  readonly appRoot: string;
  readonly runnerEntry: string;
  readonly nodePath: string;
};

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigurationError(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/** The standard cgroup v2 mount on systemd hosts; `PTC_CGROUP_ROOT` overrides the whole path. */
const CGROUP_MOUNT = "/sys/fs/cgroup";

/**
 * Session cgroups must share a writable ancestor with the agent's own cgroup, which only the
 * systemd-delegated unit subtree provides. The default is therefore `ptc` inside the unit's
 * cgroup, next to the subgroup that runs the agent (`DelegateSubgroup=`). Without that subgroup
 * the unit's cgroup itself holds the agent and cannot take controllers, so there is no usable
 * default: refuse rather than pick a root that fails on first use.
 */
function defaultCgroupRoot(): string {
  let own = "";
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((entry) => entry.startsWith("0::"));
    own = line === undefined ? "" : line.slice("0::".length);
  } catch {
    // Not a Linux cgroup v2 host; the operator must name the root.
  }
  const unit = own.slice(0, own.lastIndexOf("/"));
  const member = own.slice(own.lastIndexOf("/") + 1);
  const inSubgroup = !member.endsWith(".service") && !member.endsWith(".scope") && !member.endsWith(".slice");
  if (own === "" || unit === "" || !inSubgroup) {
    throw new ConfigurationError(
      `PTC_CGROUP_ROOT is required: /proc/self/cgroup shows "${own}", not a delegated unit subgroup`,
    );
  }
  return `${CGROUP_MOUNT}${unit}/ptc`;
}

function absolutePath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] ?? fallback;
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
    throw new ConfigurationError(`${name} must be an absolute path without '..'`);
  }
  return value.replace(/\/+$/, "") || "/";
}

/**
 * PTC is opt-in on the execution agent. The control plane never selects isolation or paths; these
 * values come from the agent's own environment, which the model and gateway cannot influence.
 */
export function readPtcConfig(env: NodeJS.ProcessEnv = process.env): PtcConfig | undefined {
  const enabled = env.PTC_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "0") return undefined;
  if (enabled !== "1") throw new ConfigurationError("PTC_ENABLED must be 0 or 1");

  const mode = env.PTC_SHARED_WORKSPACE_MODE ?? "none";
  if (mode !== "none" && mode !== "ro" && mode !== "rw") {
    throw new ConfigurationError("PTC_SHARED_WORKSPACE_MODE must be none, ro or rw");
  }
  const sharedWorkspace = env.PTC_SHARED_WORKSPACE === undefined || env.PTC_SHARED_WORKSPACE === ""
    ? undefined
    : absolutePath(env, "PTC_SHARED_WORKSPACE", "");
  if (mode !== "none" && sharedWorkspace === undefined) {
    throw new ConfigurationError("PTC_SHARED_WORKSPACE is required when PTC_SHARED_WORKSPACE_MODE is not none");
  }
  const directEnabled = env.PTC_DIRECT_ENABLED === "1";
  if (env.PTC_DIRECT_ENABLED !== undefined && env.PTC_DIRECT_ENABLED !== "0" && !directEnabled) {
    throw new ConfigurationError("PTC_DIRECT_ENABLED must be 0 or 1");
  }
  if (directEnabled && sharedWorkspace === undefined) {
    throw new ConfigurationError("PTC_DIRECT_ENABLED requires PTC_SHARED_WORKSPACE");
  }
  const directTmpRoot = env.PTC_DIRECT_TMP_ROOT === undefined || env.PTC_DIRECT_TMP_ROOT === ""
    ? tmpdir()
    : absolutePath(env, "PTC_DIRECT_TMP_ROOT", "");
  const allowDegraded = env.PTC_ALLOW_DEGRADED === "1";
  if (env.PTC_ALLOW_DEGRADED !== undefined && env.PTC_ALLOW_DEGRADED !== "0" && !allowDegraded) {
    throw new ConfigurationError("PTC_ALLOW_DEGRADED must be 0 or 1");
  }
  const cpuMax = env.PTC_CGROUP_CPU_MAX ?? "200000 100000";
  const cpuParts = cpuMax.trim().split(/\s+/);
  if (cpuParts.length !== 2 || !cpuParts.every((part) => /^[0-9]+$/.test(part))) {
    throw new ConfigurationError('PTC_CGROUP_CPU_MAX must have the form "<quota> <period>"');
  }
  const nodePath = env.PTC_NODE_PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const compiledRunner = fileURLToPath(new URL("./ptc-runner-main.js", import.meta.url));
  const runnerEntry = env.PTC_RUNNER_PATH === undefined || env.PTC_RUNNER_PATH === ""
    ? (existsSync(compiledRunner) ? compiledRunner : compiledRunner.replace(/\.js$/, ".ts"))
    : absolutePath(env, "PTC_RUNNER_PATH", compiledRunner);
  const appRoot = env.PTC_APP_ROOT ?? findAppRoot(runnerEntry);

  return {
    workspaceRoot: absolutePath(env, "PTC_WORKSPACE_ROOT", "/home/aster/jobs"),
    sharedWorkspace,
    sharedWorkspaceMode: mode,
    directEnabled,
    directTmpRoot,
    cgroupRoot: env.PTC_CGROUP_ROOT === undefined || env.PTC_CGROUP_ROOT === ""
      ? defaultCgroupRoot()
      : absolutePath(env, "PTC_CGROUP_ROOT", ""),
    cgroupMemoryMaxBytes: integer(env, "PTC_CGROUP_MEMORY_MAX_BYTES", 512 * 1024 * 1024, 16 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    cgroupPidsMax: integer(env, "PTC_CGROUP_PIDS_MAX", 128, 8, 4_096),
    cgroupCpuMax: `${cpuParts[0]} ${cpuParts[1]}`,
    outputChunkBytes: integer(env, "PTC_OUTPUT_CHUNK_BYTES", 32 * 1024, 1_024, 64 * 1024),
    outputBytesPerSecond: integer(env, "PTC_OUTPUT_BYTES_PER_SECOND", 0, 0, 1_000_000_000),
    nestedOutputMaxBytes: integer(env, "PTC_NESTED_OUTPUT_MAX_BYTES", 32 * 1024, 256, 1024 * 1024),
    nestedOutputMaxLines: integer(env, "PTC_NESTED_OUTPUT_MAX_LINES", 1_000, 1, 100_000),
    spillMaxBytes: integer(env, "PTC_SPILL_MAX_BYTES", 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    allowDegraded,
    jobRetentionHours: integer(env, "PTC_JOB_RETENTION_HOURS", 168, 1, 24 * 365),
    bwrapPath: env.PTC_BWRAP_PATH ?? "bwrap",
    appRoot,
    runnerEntry,
    nodePath,
  };
}

/** The package root that holds `node_modules`; the runner needs both inside the sandbox. */
function findAppRoot(entry: string): string {
  let directory = dirname(entry);
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(directory, "package.json")) || existsSync(join(directory, "node_modules"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return process.cwd();
}
