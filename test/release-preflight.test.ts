import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseReleaseManifest,
  preflightRelease,
  ReleasePreflightError,
  type ReleaseManifest,
  type ReleasePreflightOptions,
} from "../src/release-manifest.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const image = (role: string, digit: string) => `ghcr.io/example/${role}@sha256:${digit.repeat(64)}`;
const files = ["docker-compose.yml"] as const;
const cli = fileURLToPath(new URL("../src/release-preflight.ts", import.meta.url));
const checkout = fileURLToPath(new URL("../", import.meta.url));
const policyBytes = '{"synthetic":"binding fixture only; not a security policy"}\n';

function manifestFor(compose: string): ReleaseManifest {
  return {
    schemaVersion: 1,
    kind: "aster.release-bindings",
    sourceCommit: "a".repeat(40),
    platform: "linux/amd64",
    images: { app: image("app", "1") },
    compose: [{ path: files[0], sha256: sha(compose) }],
    policy: { sha256: sha(policyBytes) },
  };
}

const parse = (value: unknown) => parseReleaseManifest(Buffer.from(JSON.stringify(value)));
function errorCode(code: string) {
  return (error: unknown) => error instanceof ReleasePreflightError && error.code === code;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "aster-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Use the real production Compose file, without rendering private env/secrets.
  const compose = await readFile(join(checkout, files[0]), "utf8");
  const manifest = manifestFor(compose);
  const options: ReleasePreflightOptions = {
    manifestPath: join(directory, "release.json"),
    composeRoot: directory,
    policyPath: join(directory, "caller-selected-policy.json"),
    expected: { sourceCommit: manifest.sourceCommit, images: { ...manifest.images } },
  };
  await Promise.all([
    writeFile(options.manifestPath, JSON.stringify(manifest)),
    writeFile(join(directory, files[0]), compose),
    writeFile(options.policyPath, policyBytes),
  ]);
  return { directory, manifest, options, compose };
}

function args(options: ReleasePreflightOptions): string[] {
  return [
    "--manifest", options.manifestPath, "--compose-root", options.composeRoot, "--policy", options.policyPath,
    "--commit", options.expected.sourceCommit,
    ...Object.entries(options.expected.images).flatMap(([role, reference]) => [`--${role}`, reference]),
  ];
}
function runCli(argv: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...argv], {
    cwd: checkout, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, ASTER_IMAGE: "ignored:mutable" },
  });
}

test("offline check binds the actual Compose file, caller-selected policy, commit and the app image without writing files", async (t) => {
  const { options } = await fixture(t);
  const paths = [options.manifestPath, options.policyPath, ...files.map((file) => join(options.composeRoot, file))];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  assert.deepEqual(await preflightRelease(options), { status: "offline-bindings-ok", productionAdmission: "not-evaluated" });
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
  const result = runCli(args(options));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { status: "offline-bindings-ok", productionAdmission: "not-evaluated" });
});

test("manifest schema rejects unsupported versions, platforms, fields, shapes and noncanonical digest/commit strings", () => {
  const good = manifestFor("base");
  const bad: unknown[] = [
    null, [], {},
    { ...good, schemaVersion: "1" }, { ...good, schemaVersion: 2 },
    { ...good, kind: "signed-release" }, { ...good, platform: "linux/arm64" },
    { ...good, signatureVerified: true }, { ...good, evidence: { accepted: true } },
    { ...good, sourceCommit: "a".repeat(39) }, { ...good, sourceCommit: "A".repeat(40) },
    { ...good, sourceCommit: `${good.sourceCommit}\n` },
    { ...good, policy: null }, { ...good, policy: { ...good.policy, path: "../../private/app.env" } },
    { ...good, policy: { sha256: good.policy.sha256.toUpperCase() } },
    { ...good, policy: { sha256: `${good.policy.sha256}\n` } },
    { ...good, images: { ...good.images, extra: good.images.app } },
    { ...good, images: {} },
    { ...good, compose: [] },
    { ...good, compose: [...good.compose, good.compose[0]] },
    { ...good, compose: [{ ...good.compose[0], path: "../docker-compose.yml" }] },
    { ...good, compose: [{ ...good.compose[0], optional: true }] },
  ];
  assert.deepEqual(parse(good), good);
  for (const value of bad) assert.throws(() => parse(value), errorCode("MANIFEST_INVALID_SCHEMA"));
});

test("the app image requires an explicit registry, untagged repository and lowercase sha256 digest", () => {
  const good = manifestFor("base");
  const bad = [
    "aster:local", `aster@sha256:${"1".repeat(64)}`, `example/app@sha256:${"1".repeat(64)}`,
    good.images.app.replace("@", ":latest@"), good.images.app.replace("ghcr.io", "https://ghcr.io"),
    good.images.app.replace("ghcr.io", "user:password@ghcr.io"),
    good.images.app.replace("ghcr.io", "ghcr.io:65536"), good.images.app.replace("ghcr.io", "ghcr.io:0"),
    good.images.app.replace("/example/", "/../"), good.images.app.replace("/app@", "/App@"),
    good.images.app.replace("sha256:", "sha512:"), good.images.app.slice(0, -1),
    `${good.images.app}\n`, `${good.images.app}?token=secret`, `${good.images.app}#fragment`,
  ];
  for (const reference of bad) {
    assert.throws(() => parse({ ...good, images: { app: reference } }), errorCode("MANIFEST_INVALID_SCHEMA"));
  }
  parse({ ...good, images: { app: good.images.app.replace("ghcr.io", "registry.example.com:5000") } });
});

test("ambiguous duplicate keys, including escaped aliases, are rejected at every nesting level", () => {
  const good = JSON.stringify(manifestFor("base"));
  const duplicate = [
    good.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'),
    good.replace('"schemaVersion":1', '"schemaVersion":2,"schema\\u0056ersion":1'),
    good.replace('"images":{', '"images":{"app":"hidden",'),
    good.replace('"policy":{', '"policy":{"sha256":"hidden",'),
    good.replace('"compose":[{', '"compose":[{"path":"hidden",'),
  ];
  for (const text of duplicate) assert.throws(() => parseReleaseManifest(Buffer.from(text)), errorCode("MANIFEST_DUPLICATE_KEY"));
});

test("invalid JSON, BOM, malformed UTF-8 and oversized input fail with bounded diagnostics", () => {
  for (const bytes of [Buffer.from("{"), Buffer.from("{} trailing"), Buffer.from("﻿{}"), Buffer.from([0xff])]) {
    assert.throws(() => parseReleaseManifest(bytes), errorCode("MANIFEST_INVALID_JSON"));
  }
  assert.throws(() => parseReleaseManifest(Buffer.alloc(64 * 1024 + 1)), errorCode("MANIFEST_TOO_LARGE"));
});

test("expected commit and the app repository/digest are independent requirements", async (t) => {
  const { options, manifest } = await fixture(t);
  await assert.rejects(preflightRelease({ ...options, expected: { ...options.expected, sourceCommit: "b".repeat(40) } }), errorCode("COMMIT_MISMATCH"));
  for (const reference of [image("app", "9"), manifest.images.app.replace("/example/", "/attacker/")]) {
    await assert.rejects(preflightRelease({ ...options, expected: {
      ...options.expected, images: { app: reference },
    } }), errorCode("IMAGE_APP_MISMATCH"));
  }
  await assert.rejects(preflightRelease({ ...options, expected: {
    ...options.expected, images: { app: "mutable:tag" },
  } }), errorCode("EXPECTED_INVALID"));
});

test("every local byte binding rejects drift, including line endings and policy edits", async (t) => {
  const { options, compose } = await fixture(t);
  for (const [index, path] of files.entries()) {
    await writeFile(join(options.composeRoot, path), compose.replace(/\r?\n/g, "\r\n") + "\n");
    await assert.rejects(preflightRelease(options), errorCode(`COMPOSE_${index}_DIGEST_MISMATCH`));
    await writeFile(join(options.composeRoot, path), compose);
  }
  await writeFile(options.policyPath, `${policyBytes} `);
  await assert.rejects(preflightRelease(options), errorCode("POLICY_DIGEST_MISMATCH"));
});

test("missing, empty, oversized and non-file policies cannot silently satisfy the policy binding", async (t) => {
  const { options, manifest, directory } = await fixture(t);
  await rm(options.policyPath);
  await assert.rejects(preflightRelease(options), errorCode("POLICY_UNREADABLE"));
  await writeFile(options.policyPath, "");
  await writeFile(options.manifestPath, JSON.stringify({ ...manifest, policy: { sha256: sha("") } }));
  await assert.rejects(preflightRelease(options), errorCode("POLICY_EMPTY"));
  await writeFile(options.policyPath, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(preflightRelease(options), errorCode("POLICY_TOO_LARGE"));
  await assert.rejects(preflightRelease({ ...options, policyPath: directory }), errorCode("POLICY_NOT_REGULAR_FILE"));
});

test("missing Compose and manifest files fail closed without selecting another deployment mode", async (t) => {
  const { options } = await fixture(t);
  await rm(join(options.composeRoot, files[0]));
  await assert.rejects(preflightRelease(options), errorCode("COMPOSE_0_UNREADABLE"));
  await rm(options.manifestPath);
  await assert.rejects(preflightRelease(options), errorCode("MANIFEST_UNREADABLE"));
});

test("local manifest and Compose size bounds are enforced before hashing or parsing", async (t) => {
  const { options, manifest } = await fixture(t);
  await writeFile(options.manifestPath, Buffer.alloc(64 * 1024 + 1));
  await assert.rejects(preflightRelease(options), errorCode("MANIFEST_TOO_LARGE"));
  await writeFile(options.manifestPath, JSON.stringify(manifest));
  for (const [index, path] of files.entries()) {
    await writeFile(join(options.composeRoot, path), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(preflightRelease(options), errorCode(`COMPOSE_${index}_TOO_LARGE`));
    await writeFile(join(options.composeRoot, path), await readFile(join(checkout, path)));
  }
});

test("CLI rejects absent, duplicate, positional and unknown arguments without echoing secrets", async (t) => {
  const { options } = await fixture(t);
  const marker = "DO_NOT_PRINT_SYNTHETIC_SECRET";
  for (const argv of [[], [...args(options), "--policy", marker], [...args(options), "--unknown", marker], [marker]]) {
    const result = runCli(argv);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(marker), false);
    assert.equal(JSON.parse(result.stderr).productionAdmission, "not-evaluated");
  }
  await writeFile(options.manifestPath, `{ ${marker}`);
  const malformed = runCli(args(options));
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stderr).code, "MANIFEST_INVALID_JSON");
  assert.equal(malformed.stderr.includes(marker), false);
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /NOT signature verification or production admission/);
});
