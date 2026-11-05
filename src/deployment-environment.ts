import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BoundedFileError, readBoundedFile } from "./bounded-file.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

/**
 * One deployment environment's public, non-secret resource identity.
 *
 * The authority for every value is this file: the rendered Compose project is checked against
 * the validated description, so a resource name cannot drift in only one of them. Host-private
 * material (credentials) lives in the app's env file and is never described here.
 */
const EnvironmentName = Type.Union([Type.Literal("test"), Type.Literal("production")]);
// Docker project names are lowercase alphanumerics plus inner separators.
const ProjectName = Type.String({ minLength: 2, maxLength: 63, pattern: "^[a-z0-9][a-z0-9_-]*$" });
const VolumeName = Type.String({ minLength: 2, maxLength: 63, pattern: "^[a-z0-9][a-z0-9_.-]*$" });

export const EnvironmentSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("aster.deployment-environment"),
  environment: EnvironmentName,
  composeProject: ProjectName,
  volumes: Type.Object({
    app: VolumeName,
  }, { additionalProperties: false }),
  // The numeric Telegram bot user ID is an identifier, not a credential. Declaring it lets the
  // offline check reject two environments that consume the same bot; the live check (Stage A2)
  // confirms the deployed token actually resolves to this ID.
  identity: Type.Object({
    botId: Type.String({ minLength: 1, maxLength: 20, pattern: "^[1-9]\\d*$" }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type DeploymentEnvironment = Static<typeof EnvironmentSchema>;

export type EnvironmentFailureCode =
  | "ENVIRONMENT_TOO_LARGE" | "ENVIRONMENT_INVALID_JSON" | "ENVIRONMENT_DUPLICATE_KEY"
  | "ENVIRONMENT_INVALID_SCHEMA" | "ENVIRONMENT_UNREADABLE" | "ENVIRONMENT_NOT_REGULAR_FILE"
  | "ENVIRONMENT_RESOURCE_OVERLAP";

export class EnvironmentError extends Error {
  constructor(readonly code: EnvironmentFailureCode) {
    super(code);
    this.name = "EnvironmentError";
  }
}

function fail(code: EnvironmentFailureCode): never {
  throw new EnvironmentError(code);
}

export function parseEnvironment(bytes: Uint8Array): DeploymentEnvironment {
  let value: unknown;
  try {
    value = parseStrictJson(bytes, 64 * 1024);
  } catch (error) {
    return fail(error instanceof StrictJsonError && error.code === "TOO_LARGE" ? "ENVIRONMENT_TOO_LARGE"
      : error instanceof StrictJsonError && error.code === "DUPLICATE_KEY" ? "ENVIRONMENT_DUPLICATE_KEY"
      : "ENVIRONMENT_INVALID_JSON");
  }
  if (!Value.Check(EnvironmentSchema, value)) fail("ENVIRONMENT_INVALID_SCHEMA");
  return value;
}

export async function readEnvironment(path: string): Promise<DeploymentEnvironment> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, 64 * 1024);
  } catch (error) {
    if (!(error instanceof BoundedFileError)) throw error;
    return fail(error.code === "UNREADABLE" ? "ENVIRONMENT_UNREADABLE"
      : error.code === "NOT_REGULAR_FILE" ? "ENVIRONMENT_NOT_REGULAR_FILE" : "ENVIRONMENT_TOO_LARGE");
  }
  return parseEnvironment(bytes);
}

/**
 * Reject descriptions that would collide on one host. Environments are separate Compose projects,
 * so the same service names are expected; identity comes from projects, volumes and the bot the
 * environment consumes.
 */
export function assertDistinctEnvironments(first: DeploymentEnvironment, second: DeploymentEnvironment): void {
  if (first.environment === second.environment) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.composeProject === second.composeProject) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.volumes.app === second.volumes.app) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  // The same bot cannot serve two environments: long polling would split updates between them.
  if (first.identity.botId === second.identity.botId) fail("ENVIRONMENT_RESOURCE_OVERLAP");
}
