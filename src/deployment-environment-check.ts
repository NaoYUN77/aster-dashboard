import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertDistinctEnvironments, EnvironmentError, readEnvironment,
  type DeploymentEnvironment,
} from "./deployment-environment.js";
import { checkHostResources, HostResourceError } from "./deployment-host-resources.js";
import { checkRenderedProject, DeploymentRenderError } from "./deployment-render.js";

/**
 * Offline/read-only deployment environment check.
 *
 *   render  render Compose from the environment description and compare every resource
 *   host    inspect Docker for conflicts with this environment (read-only)
 *   compare reject two environments that would collide on one host
 *
 * `render` derives all ASTER_* interpolation values from the description, so the operator cannot
 * pass a resource name that disagrees with the file. Every command is read-only; `host` queries
 * Docker but never changes host state. Exit 0 only means these checks agree; it is not production
 * admission, signature verification or a business acceptance result.
 */
const help = `Usage: npm run deployment:environment -- <command> [options]

  render --environment <file>
  host   --environment <file> [--volumes absent|present|any]
  compare --first <file> --second <file>

Read-only. Exit 0 is not signature verification or production admission.`;

/** The repository root, whether this module runs from `src/` or the built `dist/src/`. */
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const root = [resolve(moduleDirectory, ".."), resolve(moduleDirectory, "../..")]
  .find((candidate) => existsSync(join(candidate, "docker-compose.yml"))) ?? resolve(moduleDirectory, "..");

class ArgumentError extends Error {}

function requireValue(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new ArgumentError();
  return value;
}

/** The single mapping from a validated description to the Compose interpolation contract. */
export function composeEnvironment(environment: DeploymentEnvironment): Record<string, string> {
  return {
    ASTER_APP_VOLUME: environment.volumes.app,
  };
}

async function render(values: Record<string, unknown>): Promise<unknown> {
  const environment = await readEnvironment(requireValue(values, "environment"));
  const directory = await mkdtemp(join(tmpdir(), "aster-environment-"));
  try {
    // The generated env file carries only non-secret resource names; the description is the source.
    const envFile = join(directory, "environment.env");
    const assignments = composeEnvironment(environment);
    await writeFile(envFile, Object.entries(assignments).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    const result = spawnSync("docker", [
      "compose", "--project-name", environment.composeProject, "--project-directory", root,
      "--env-file", envFile, "-f", join(root, "docker-compose.yml"),
      "config", "--format", "json",
    ], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      // Inherited ASTER_* values would silently override the env file.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ASTER_") && !key.startsWith("COMPOSE_"))),
    });
    // Compose refusing to render is not the same as rendering a project that disagrees with the
    // description; keep the two apart so the operator knows which side to inspect.
    if (result.error || result.status !== 0) throw new DeploymentRenderError("RENDER_COMPOSE_FAILED");
    return checkRenderedProject(Buffer.from(result.stdout, "utf8"), {
      environment, projectName: environment.composeProject,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function host(values: Record<string, unknown>): Promise<unknown> {
  const environment = await readEnvironment(requireValue(values, "environment"));
  const volumes = values.volumes ?? "any";
  if (volumes !== "absent" && volumes !== "present" && volumes !== "any") throw new ArgumentError();
  return checkHostResources({ environment, volumes });
}

async function compare(values: Record<string, unknown>): Promise<unknown> {
  const first = await readEnvironment(requireValue(values, "first"));
  const second = await readEnvironment(requireValue(values, "second"));
  assertDistinctEnvironments(first, second);
  return { status: "environments-distinct", environments: [first.environment, second.environment], productionAdmission: "not-evaluated" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        environment: { type: "string" },
        volumes: { type: "string" }, first: { type: "string" }, second: { type: "string" }, help: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (values.help === true && positionals.length === 0) {
      console.log(help);
    } else {
      const [command, ...rest] = positionals;
      if (rest.length > 0) throw new ArgumentError();
      const handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = { render, host, compare };
      const handler = command === undefined ? undefined : handlers[command];
      if (!handler) throw new ArgumentError();
      console.log(JSON.stringify(await handler(values)));
    }
  } catch (error) {
    const code = error instanceof EnvironmentError || error instanceof DeploymentRenderError
      || error instanceof HostResourceError ? error.code
      : error instanceof ArgumentError ? "ARGUMENTS_INVALID" : "INTERNAL_ERROR";
    // Never echo paths, rendered values, environment contents or daemon output.
    console.error(JSON.stringify({ status: "environment-check-failed", code, productionAdmission: "not-evaluated" }));
    process.exitCode = 1;
  }
}
