import { Type } from "typebox";
import { Value } from "typebox/value";
import type { DeploymentEnvironment } from "./deployment-environment.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

/**
 * Checks a rendered Compose project against the environment description it claims to deploy.
 * Compose interpolation is not trusted: every value is compared after rendering, so a variable
 * that silently did not apply cannot produce a project that differs from the description.
 * The deployment topology is the single `personal-agent` service from docker-compose.yml.
 */
export type RenderFailureCode =
  | "RENDER_INVALID_JSON" | "RENDER_DUPLICATE_KEY" | "RENDER_INVALID_SCHEMA"
  | "RENDER_PROJECT_MISMATCH" | "RENDER_VOLUME_MISMATCH" | "RENDER_NETWORK_MISMATCH"
  | "RENDER_PUBLISHED_PORT" | "RENDER_SERVICE_MISSING" | "RENDER_BOUNDARY_MISMATCH"
  | "RENDER_COMPOSE_FAILED";

export class DeploymentRenderError extends Error {
  constructor(readonly code: RenderFailureCode) {
    super(code);
    this.name = "DeploymentRenderError";
  }
}

function fail(code: RenderFailureCode): never {
  throw new DeploymentRenderError(code);
}

const PortMapping = Type.Object({
  host_ip: Type.Optional(Type.String()),
  published: Type.Optional(Type.String()),
  target: Type.Optional(Type.Integer()),
  protocol: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
}, { additionalProperties: true });

const Service = Type.Object({
  image: Type.Optional(Type.String()),
  network_mode: Type.Optional(Type.String()),
  cap_drop: Type.Optional(Type.Array(Type.String())),
  security_opt: Type.Optional(Type.Array(Type.String())),
  ports: Type.Optional(Type.Array(PortMapping)),
  volumes: Type.Optional(Type.Array(Type.Object({
    type: Type.String(),
    source: Type.Optional(Type.String()),
    target: Type.String(),
    read_only: Type.Optional(Type.Boolean()),
  }, { additionalProperties: true }))),
}, { additionalProperties: true });

const Rendered = Type.Object({
  name: Type.String(),
  services: Type.Record(Type.String(), Service),
  networks: Type.Record(Type.String(), Type.Object({
    name: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
  volumes: Type.Record(Type.String(), Type.Object({ name: Type.Optional(Type.String()) }, { additionalProperties: true })),
}, { additionalProperties: true });

export interface RenderCheckOptions {
  environment: DeploymentEnvironment;
  /** Compose project name passed with --project-name; defaults to the environment's. */
  projectName: string;
}

export interface RenderReport {
  status: "render-matches-environment";
  environment: DeploymentEnvironment["environment"];
  composeProject: string;
  productionAdmission: "not-evaluated";
}

export function checkRenderedProject(bytes: Uint8Array, options: RenderCheckOptions): RenderReport {
  let config: unknown;
  try {
    config = parseStrictJson(bytes, 4 * 1024 * 1024);
  } catch (error) {
    return fail(error instanceof StrictJsonError && error.code === "DUPLICATE_KEY" ? "RENDER_DUPLICATE_KEY" : "RENDER_INVALID_JSON");
  }
  if (!Value.Check(Rendered, config)) fail("RENDER_INVALID_SCHEMA");
  const environment = options.environment;
  if (config.name !== options.projectName || config.name !== environment.composeProject) fail("RENDER_PROJECT_MISMATCH");

  // The topology is exactly one service; anything else is a different stack than the description
  // sanctions (the service key set is compared, not just the app's presence).
  const app = config.services["personal-agent"];
  if (!app || Object.keys(config.services).join() !== "personal-agent") fail("RENDER_SERVICE_MISSING");

  // An extra volume is a deployment resource the description does not name, so it is rejected.
  if (Object.keys(config.volumes).join() !== "personal-agent-data") fail("RENDER_VOLUME_MISMATCH");
  const volume = config.volumes["personal-agent-data"];
  // Compose derives "<project>_<key>" when a name is not set; only the explicit name is acceptable.
  if (!volume || volume.name !== environment.volumes.app) fail("RENDER_VOLUME_MISMATCH");
  const dataMounts = (app.volumes ?? []).filter((mount) => mount.target === "/data");
  if (dataMounts.length !== 1 || dataMounts[0]!.source !== "personal-agent-data") fail("RENDER_VOLUME_MISMATCH");

  // Compose adds only its implicit default network; a named network means the file set drifted
  // from the single-service base stack.
  for (const [key, network] of Object.entries(config.networks)) {
    if (key !== "default") fail("RENDER_NETWORK_MISMATCH");
    if (network.name !== undefined && network.name !== `${options.projectName}_default`) fail("RENDER_NETWORK_MISMATCH");
  }

  // The app publishes no port: Telegram is long polling, so any published port is unsanctioned.
  for (const service of Object.values(config.services)) {
    if ((service.ports ?? []).length > 0) fail("RENDER_PUBLISHED_PORT");
  }

  // Boundaries the base Compose file pins and a per-environment override must not weaken.
  if (!app.cap_drop?.includes("ALL")) fail("RENDER_BOUNDARY_MISMATCH");
  if (!app.security_opt?.includes("no-new-privileges:true")) fail("RENDER_BOUNDARY_MISMATCH");
  // A shared network namespace is not part of this topology; the app networks directly.
  if (app.network_mode !== undefined) fail("RENDER_BOUNDARY_MISMATCH");

  return {
    status: "render-matches-environment",
    environment: environment.environment,
    composeProject: config.name,
    productionAdmission: "not-evaluated",
  };
}
