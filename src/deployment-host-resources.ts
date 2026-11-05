import { spawnSync } from "node:child_process";
import type { DeploymentEnvironment } from "./deployment-environment.js";

/**
 * Read-only host resource check. Docker itself is the authority for what exists on this host;
 * this module only reports conflicts, never creates, renames or removes anything. A missing
 * volume is not repaired here, and an existing production volume is never adopted silently.
 */
export type HostConflictCode =
  | "DOCKER_UNAVAILABLE" | "PROJECT_CONFLICT" | "VOLUME_MISSING" | "VOLUME_EXISTS"
  | "VOLUME_IN_USE";

export class HostResourceError extends Error {
  constructor(readonly code: HostConflictCode) {
    super(code);
    this.name = "HostResourceError";
  }
}

function run(args: string[], expected = 0): { status: number; stdout: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new HostResourceError("DOCKER_UNAVAILABLE");
  if (result.status !== expected) throw new HostResourceError("DOCKER_UNAVAILABLE");
  return { status: result.status ?? 0, stdout: result.stdout };
}

/** Existence probe: a non-zero status is a normal "not found", not an unusable daemon. */
function exists(args: string[]): boolean {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new HostResourceError("DOCKER_UNAVAILABLE");
  if (result.status === 0) return true;
  // Distinguish "no such object" from a daemon or permission failure.
  const message = `${result.stderr}`;
  if (/no such|not found|does not exist/iu.test(message)) return false;
  throw new HostResourceError("DOCKER_UNAVAILABLE");
}

export interface HostCheckOptions {
  environment: DeploymentEnvironment;
  /** First install requires the target volume to be absent; an update requires it to exist. */
  volumes: "absent" | "present" | "any";
}

export interface HostCheckResult {
  status: "host-resources-clear";
  environment: DeploymentEnvironment["environment"];
  volumes: "absent" | "present" | "any";
  productionAdmission: "not-evaluated";
}

export function checkHostResources(options: HostCheckOptions): HostCheckResult {
  const environment = options.environment;
  const containers = (runningOnly: boolean) => run(["ps", ...(runningOnly ? [] : ["--all"]),
    "--filter", `label=com.docker.compose.project=${environment.composeProject}`, "--format", "{{.ID}}"]).stdout.trim();
  // A first install owns nothing yet. An update reuses the project's own containers, but they must
  // be stopped: the caller stops writers before preflighting the volumes they are about to replace.
  if (options.volumes === "absent" ? containers(false) !== "" : containers(true) !== "") {
    throw new HostResourceError("PROJECT_CONFLICT");
  }

  const name = environment.volumes.app;
  const present = exists(["volume", "inspect", name]);
  if (options.volumes === "absent" && present) throw new HostResourceError("VOLUME_EXISTS");
  if (options.volumes === "present" && !present) throw new HostResourceError("VOLUME_MISSING");
  // Any consumer, including a paused or restarting one, blocks a safe update.
  if (present && run(["ps", "--quiet", "--filter", `volume=${name}`]).stdout.trim() !== "") {
    throw new HostResourceError("VOLUME_IN_USE");
  }

  return { status: "host-resources-clear", environment: environment.environment, volumes: options.volumes, productionAdmission: "not-evaluated" };
}
