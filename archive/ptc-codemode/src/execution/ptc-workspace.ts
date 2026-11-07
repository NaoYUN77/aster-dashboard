import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PtcHostError } from "./ptc-host.js";
import { PTC_JOB_ID_PATTERN, type PtcConfig } from "./ptc-config.js";
import type { PtcWorkspaceState } from "./rpc-protocol.js";

/** The sandbox path never varies; the host path is derived from a validated job id only. */
export const PTC_SANDBOX_WORKSPACE = "/workspace";
export const PTC_OUTPUT_DIRECTORY = ".ptc/outputs";

export function assertJobId(jobId: string): void {
  if (!PTC_JOB_ID_PATTERN.test(jobId)) {
    throw new PtcHostError("invalid_request", "jobId does not have the ptc-<32 hex> form", "not_started");
  }
}

export function jobWorkspacePath(config: PtcConfig, jobId: string): string {
  assertJobId(jobId);
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(join(root, jobId, "workspace"));
  if (workspace !== join(root, jobId, "workspace") || !workspace.startsWith(`${root}${sep}`)) {
    throw new PtcHostError("invalid_request", "job workspace escapes the configured root", "not_started");
  }
  return workspace;
}

async function ensureDirectory(path: string, description: string): Promise<"missing" | "present"> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new PtcHostError("internal", `${description} cannot be inspected`, "not_started");
  }
  if (info.isSymbolicLink()) {
    throw new PtcHostError("invalid_request", `${description} must not be a symbolic link`, "not_started");
  }
  if (!info.isDirectory()) {
    throw new PtcHostError("invalid_request", `${description} is not a directory`, "not_started");
  }
  return "present";
}

/**
 * Prepare the host directory mounted as `/workspace`. The replay rules are explicit: a job whose
 * workspace was already reported ready must not silently get a fresh empty directory, because its
 * journaled results may refer to files that would then be missing.
 */
export async function preparePtcWorkspace(
  config: PtcConfig,
  jobId: string,
  workspaceReady: boolean,
): Promise<PtcWorkspaceState> {
  const hostPath = jobWorkspacePath(config, jobId);
  const root = resolve(config.workspaceRoot);
  if (await ensureDirectory(root, "PTC workspace root") === "missing") {
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  const jobDirectory = join(root, jobId);
  // Validate an existing job directory without creating one: a replay whose workspace vanished
  // must not leave a fresh empty job directory behind.
  await ensureDirectory(jobDirectory, "job directory");

  let created = false;
  let reused = false;
  if (await ensureDirectory(hostPath, "job workspace") === "missing") {
    if (workspaceReady) {
      throw new PtcHostError(
        "workspace_missing",
        "the job workspace is gone although workspaceReady was committed; refusing to start with an empty directory",
        "not_started",
      );
    }
    await mkdir(hostPath, { recursive: true, mode: 0o700 });
    created = true;
  } else {
    reused = true;
    const [realRoot, realWorkspace] = await Promise.all([realpath(root), realpath(hostPath)]);
    if (realWorkspace !== realRoot && !realWorkspace.startsWith(`${realRoot}${sep}`)) {
      throw new PtcHostError("invalid_request", "job workspace resolves outside the configured root", "not_started");
    }
  }

  const outputs = join(hostPath, ...PTC_OUTPUT_DIRECTORY.split("/"));
  if (await ensureDirectory(outputs, "output directory") === "missing") {
    await mkdir(outputs, { recursive: true, mode: 0o700 });
  }
  return { path: PTC_SANDBOX_WORKSPACE, created, reused };
}
