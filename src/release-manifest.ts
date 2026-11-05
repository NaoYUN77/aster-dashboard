import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BoundedFileError, readBoundedFile } from "./bounded-file.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

const Sha256 = Type.String({ minLength: 71, maxLength: 71, pattern: "^sha256:[0-9a-f]{64}$" });
const Commit = Type.String({ minLength: 40, maxLength: 40, pattern: "^[0-9a-f]{40}$" });
// Deliberately accept only explicit DNS registries and untagged, digest-pinned repositories.
const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const Image = Type.String({
  maxLength: 512,
  pattern: `^${label}(?:\\.${label})+(?::[1-9][0-9]{0,4})?/${component}(?:/${component})*@sha256:[0-9a-f]{64}$`,
});
const Images = Type.Object({ app: Image }, { additionalProperties: false });
const ComposePaths = ["docker-compose.yml"] as const;

/** Partial release contract: bindings only, never a signature or production admission result. */
export const ReleaseManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("aster.release-bindings"),
  sourceCommit: Commit,
  platform: Type.Literal("linux/amd64"),
  images: Images,
  compose: Type.Tuple([
    Type.Object({ path: Type.Literal(ComposePaths[0]), sha256: Sha256 }, { additionalProperties: false }),
  ]),
  policy: Type.Object({ sha256: Sha256 }, { additionalProperties: false }),
}, { additionalProperties: false });

export type ReleaseManifest = Static<typeof ReleaseManifestSchema>;
export type ReleaseImages = Static<typeof Images>;
const ExpectedSchema = Type.Object({ sourceCommit: Commit, images: Images }, { additionalProperties: false });

export class ReleasePreflightError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReleasePreflightError";
  }
}

function fail(code: string): never {
  throw new ReleasePreflightError(code);
}

function validPorts(images: ReleaseImages): boolean {
  return Object.values(images).every((image) => {
    const registry = image.split("/")[0]!;
    const port = registry.split(":")[1];
    return !/\s/.test(image) && (port === undefined || Number(port) <= 65535);
  });
}

// JSON.parse discards duplicate keys. Reject them, including escaped aliases, before trusting the result.
export function parseReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  let value: unknown;
  try {
    value = parseStrictJson(bytes, 64 * 1024);
  } catch (error) {
    return fail(error instanceof StrictJsonError && error.code === "TOO_LARGE" ? "MANIFEST_TOO_LARGE"
      : error instanceof StrictJsonError && error.code === "DUPLICATE_KEY" ? "MANIFEST_DUPLICATE_KEY"
      : "MANIFEST_INVALID_JSON");
  }
  if (!Value.Check(ReleaseManifestSchema, value) || !validPorts(value.images)) fail("MANIFEST_INVALID_SCHEMA");
  return value;
}

async function readBounded(path: string, limit: number, subject: string): Promise<Buffer> {
  try {
    return await readBoundedFile(path, limit);
  } catch (error) {
    if (!(error instanceof BoundedFileError)) throw error;
    return fail(`${subject}_${error.code}`);
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface ReleasePreflightOptions {
  manifestPath: string;
  composeRoot: string;
  policyPath: string;
  expected: { sourceCommit: string; images: ReleaseImages };
}

/** Read-only and offline. All expected values and local paths come from the caller, never the manifest. */
export async function preflightRelease(options: ReleasePreflightOptions): Promise<{
  status: "offline-bindings-ok";
  productionAdmission: "not-evaluated";
}> {
  if (!Value.Check(ExpectedSchema, options.expected) || !validPorts(options.expected.images)) fail("EXPECTED_INVALID");
  const manifest = parseReleaseManifest(await readBounded(options.manifestPath, 64 * 1024, "MANIFEST"));
  if (manifest.sourceCommit !== options.expected.sourceCommit) fail("COMMIT_MISMATCH");
  for (const role of ["app"] as const) {
    if (manifest.images[role] !== options.expected.images[role]) fail(`IMAGE_${role.toUpperCase()}_MISMATCH`);
  }
  for (const [index, path] of ComposePaths.entries()) {
    const bytes = await readBounded(join(options.composeRoot, path), 1024 * 1024, `COMPOSE_${index}`);
    if (digest(bytes) !== manifest.compose[index]!.sha256) fail(`COMPOSE_${index}_DIGEST_MISMATCH`);
  }
  const policy = await readBounded(options.policyPath, 1024 * 1024, "POLICY");
  if (policy.length === 0) fail("POLICY_EMPTY");
  if (digest(policy) !== manifest.policy.sha256) fail("POLICY_DIGEST_MISMATCH");
  return { status: "offline-bindings-ok", productionAdmission: "not-evaluated" };
}
