import { dirname } from "node:path";
import type { RpcBashExecutePayload } from "./rpc-protocol.js";
import type { PtcConfig } from "./ptc-config.js";

/** Read-only roots a normal command needs; missing ones are skipped so a minimal image still works. */
const READ_ONLY_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"] as const;

/** The fixed sandbox environment; nothing from the agent's process leaks in. */
function baseEnvironment(config: PtcConfig, home: string): Array<[string, string]> {
  return [
    ["HOME", home],
    ["TMPDIR", "/tmp"],
    ["PATH", config.nodePath],
    ["LANG", "C.UTF-8"],
    ["PTC_INSIDE_SANDBOX", "1"],
  ];
}

/** Environment the runner process needs; the sandbox gets nothing else from the host. */
export function runnerEnvironment(
  config: PtcConfig,
  workspacePath: string,
  mounts: { readonly sharedPath?: string; readonly tmpPath?: string } = {},
): Record<string, string> {
  return {
    PTC_RUNNER_WORKSPACE: workspacePath,
    PTC_RUNNER_SHELL: "/bin/bash",
    PTC_RUNNER_OUTPUT_MAX_BYTES: String(config.nestedOutputMaxBytes),
    PTC_RUNNER_OUTPUT_MAX_LINES: String(config.nestedOutputMaxLines),
    PTC_RUNNER_OUTPUT_BYTES_PER_SECOND: String(config.outputBytesPerSecond),
    PTC_RUNNER_SPILL_MAX_BYTES: String(config.spillMaxBytes),
    PTC_RUNNER_JOB_RETENTION_MS: String(config.jobRetentionHours * 3_600_000),
    PTC_RUNNER_SHARED_MODE: config.sharedWorkspaceMode,
    ...(mounts.sharedPath === undefined ? {} : { PTC_RUNNER_SHARED: mounts.sharedPath }),
    ...(mounts.tmpPath === undefined ? {} : { PTC_RUNNER_TMP: mounts.tmpPath }),
  };
}

function sharedMountArgs(config: PtcConfig): string[] {
  if (config.sharedWorkspace === undefined || config.sharedWorkspaceMode === "none") return [];
  return config.sharedWorkspaceMode === "rw"
    ? ["--bind-try", config.sharedWorkspace, "/shared"]
    : ["--ro-bind-try", config.sharedWorkspace, "/shared"];
}

function readOnlyRootArgs(config: PtcConfig, includeApp: boolean): string[] {
  const args: string[] = [];
  for (const root of READ_ONLY_ROOTS) args.push("--ro-bind-try", root, root);
  if (includeApp) {
    // The runner entry and its dependencies must be visible read-only at the same path.
    args.push("--ro-bind-try", config.appRoot, config.appRoot);
  }
  const nodeDirectory = dirname(process.execPath);
  if (nodeDirectory !== "/usr" && nodeDirectory !== "/usr/bin" && nodeDirectory !== "/bin") {
    args.push("--ro-bind-try", nodeDirectory, nodeDirectory);
  }
  return args;
}

/**
 * bwrap argv for one job. Every sharing flag is explicit: no `--unshare-all`, no whole-root
 * read-only bind, and no network. The workspace is the only writable persistent mount; `/tmp` is
 * a private tmpfs, so it can never hold state that a replay would miss. `/shared` follows the
 * agent's configured mode and is read-only unless the operator chose `rw`.
 *
 * There is no `--no-new-privs` flag: bubblewrap is not even started without `PR_SET_NO_NEW_PRIVS`
 * (its `main` calls `prctl` before parsing arguments), and older releases reject the unknown option
 * outright — 0.11.1 exits before the sandbox starts.
 */
export function buildBwrapArgv(config: PtcConfig, hostWorkspace: string): string[] {
  const argv = [
    config.bwrapPath,
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  argv.push(...readOnlyRootArgs(config, true));
  argv.push(...sharedMountArgs(config));
  argv.push(
    "--bind", hostWorkspace, "/workspace",
    "--chdir", "/workspace",
    "--clearenv",
  );
  for (const [name, value] of baseEnvironment(config, "/workspace")) argv.push("--setenv", name, value);
  for (const [name, value] of Object.entries(runnerEnvironment(config, "/workspace", {
    ...(config.sharedWorkspace === undefined || config.sharedWorkspaceMode === "none"
      ? {}
      : { sharedPath: "/shared" }),
    tmpPath: "/tmp",
  }))) {
    argv.push("--setenv", name, value);
  }
  argv.push(...nodeCommand(config));
  return argv;
}

export type DirectSandboxMounts = {
  /** Host directory mounted at `/shared`; required. */
  readonly sharedPath: string;
  /** Host directory mounted at `/tmp`; a private directory owned by one session. */
  readonly tmpPath: string;
  /** The session's working directory, as a path inside the sandbox (under `/shared`). */
  readonly cwd: string;
};

/**
 * One-shot bwrap argv for a direct command. The same isolation as the PTC runner, but the command
 * replaces the runner: it runs through `/bin/sh -c` for a string, or directly for an argv, with
 * the caller's environment after the fixed sandbox variables. The workspace app root is not
 * exposed: a direct command needs no part of the control plane.
 */
export function buildDirectBwrapArgv(
  config: PtcConfig,
  mounts: DirectSandboxMounts,
  payload: RpcBashExecutePayload,
): string[] {
  const argv = [
    config.bwrapPath,
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--proc", "/proc",
    "--dev", "/dev",
  ];
  argv.push(...readOnlyRootArgs(config, false));
  argv.push(
    config.sharedWorkspaceMode === "rw"
      ? "--bind" : "--ro-bind",
    mounts.sharedPath,
    "/shared",
    "--bind", mounts.tmpPath, "/tmp",
    "--chdir", mounts.cwd,
    "--clearenv",
  );
  for (const [name, value] of baseEnvironment(config, mounts.cwd)) argv.push("--setenv", name, value);
  for (const [name, value] of Object.entries(payload.env)) argv.push("--setenv", name, value);
  argv.push("--");
  if (typeof payload.command === "string") argv.push("/bin/sh", "-c", payload.command);
  else argv.push(...payload.command);
  return argv;
}

/**
 * Explicitly allowed degraded mode: no namespaces, only rlimits. It is never selected silently;
 * `PTC_ALLOW_DEGRADED=1` and a failed bwrap probe are both required.
 */
export function buildDegradedArgv(config: PtcConfig, _hostWorkspace: string): string[] {
  return [
    "prlimit",
    `--as=${config.cgroupMemoryMaxBytes}`,
    `--nproc=${config.cgroupPidsMax}`,
    "--fsize=67108864",
    "--",
    ...nodeCommand(config),
  ];
}

function nodeCommand(config: PtcConfig): string[] {
  const args = [process.execPath];
  // In development the entry is TypeScript; the deployment artifact is JavaScript.
  if (config.runnerEntry.endsWith(".ts")) args.push("--import", "tsx");
  args.push(config.runnerEntry);
  return args;
}
