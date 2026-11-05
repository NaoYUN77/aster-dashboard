import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDistinctEnvironments, EnvironmentError, parseEnvironment,
  readEnvironment, type DeploymentEnvironment,
} from "../src/deployment-environment.js";
import { checkRenderedProject, DeploymentRenderError } from "../src/deployment-render.js";
import { composeEnvironment } from "../src/deployment-environment-check.js";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../src/deployment-environment-check.ts", import.meta.url));
// Rendering is Compose's own output, so these tests need a real Compose binary. A machine without
// one reports an explicit skip instead of a pass.
const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
const requiresCompose = { skip: compose.error !== undefined || compose.status !== 0 ? "Docker Compose is unavailable" : false };

function environment(overrides: Partial<DeploymentEnvironment> = {}): DeploymentEnvironment {
  return {
    schemaVersion: 1,
    kind: "aster.deployment-environment",
    environment: "test",
    composeProject: "aster-test",
    volumes: { app: "aster-test-app-data" },
    identity: { botId: "111111" },
    ...overrides,
  };
}
const production = () => environment({
  environment: "production",
  composeProject: "aster-production",
  volumes: { app: "personal-agent-data" },
  identity: { botId: "222222" },
});
const parse = (value: unknown) => parseEnvironment(Buffer.from(JSON.stringify(value)));
const environmentCode = (code: string) => (error: unknown) => error instanceof EnvironmentError && error.code === code;

/**
 * The base Compose file reads `.env` from the project directory. A developer checkout may carry a
 * real one; only create (and later remove) the placeholder when none exists.
 */
function ensureEnvFile(): () => Promise<void> {
  const path = join(checkout, ".env");
  if (existsSync(path)) return async () => {};
  writeFileSync(path, "", { mode: 0o600 });
  return () => rm(path, { force: true });
}

test("a description is accepted only with canonical, self-consistent resources", () => {
  assert.deepEqual(parse(environment()), environment());
  assert.deepEqual(parse(production()), production());

  const bad: unknown[] = [
    null, [], {},
    { ...environment(), schemaVersion: "1" }, { ...environment(), schemaVersion: 2 },
    { ...environment(), kind: "aster.release-bindings" }, { ...environment(), environment: "staging" },
    { ...environment(), accepted: true }, { ...environment(), productionAdmission: "ok" },
    { ...environment(), composeProject: "Aster_Test" }, { ...environment(), composeProject: "a" },
    { ...environment(), volumes: { app: "app", extra: "x" } },
    // Fields of the removed broker stack are unknown-field input now, not configurable data.
    { ...environment(), volumes: { app: "app", broker: "broker" } },
    { ...environment(), network: { subnet: "172.31.82.0/24" } },
    { ...environment(), broker: { managementPort: 15321 } },
    { ...environment(), privateDirectory: "/srv/aster/test/private" },
    { ...environment(), privateFiles: { ca: "ca.pem" } },
    { ...environment(), identity: { botId: "0" } }, { ...environment(), identity: { botId: "-1" } },
    { ...environment(), identity: { botId: "bot" } }, { ...environment(), identity: {} },
  ];
  for (const value of bad) assert.throws(() => parse(value), environmentCode("ENVIRONMENT_INVALID_SCHEMA"), JSON.stringify(value));
});

test("the checked-in examples parse and describe two distinct environments", async () => {
  const examples = join(checkout, "deploy", "environments");
  const testEnvironment = await readEnvironment(join(examples, "test.example.json"));
  const productionEnvironment = await readEnvironment(join(examples, "production.example.json"));
  assert.equal(testEnvironment.environment, "test");
  assert.equal(productionEnvironment.environment, "production");
  assert.doesNotThrow(() => assertDistinctEnvironments(testEnvironment, productionEnvironment));
});

test("strict JSON rejects duplicates, BOM, malformed UTF-8 and oversized input", () => {
  const good = JSON.stringify(environment());
  const duplicate = good.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  assert.throws(() => parseEnvironment(Buffer.from(duplicate)), environmentCode("ENVIRONMENT_DUPLICATE_KEY"));
  assert.throws(() => parseEnvironment(Buffer.from(`﻿${good}`)), environmentCode("ENVIRONMENT_INVALID_JSON"));
  assert.throws(() => parseEnvironment(Buffer.from([0xff])), environmentCode("ENVIRONMENT_INVALID_JSON"));
  assert.throws(() => parseEnvironment(Buffer.from("{")), environmentCode("ENVIRONMENT_INVALID_JSON"));
  assert.throws(() => parseEnvironment(Buffer.alloc(64 * 1024 + 1)), environmentCode("ENVIRONMENT_TOO_LARGE"));
});

test("two environments are distinct only when no host resource is shared", () => {
  assert.doesNotThrow(() => assertDistinctEnvironments(parse(environment()), parse(production())));
  const changes: Array<(value: DeploymentEnvironment) => void> = [
    (value) => { value.composeProject = "aster-test"; },
    (value) => { value.volumes.app = "aster-test-app-data"; },
    (value) => { value.identity.botId = "111111"; },
  ];
  for (const change of changes) {
    const other = structuredClone(production());
    change(other);
    assert.throws(() => assertDistinctEnvironments(parse(environment()), parse(other)), environmentCode("ENVIRONMENT_RESOURCE_OVERLAP"));
  }
  // The same environment twice is never a valid comparison.
  assert.throws(() => assertDistinctEnvironments(parse(environment()), parse(environment())), environmentCode("ENVIRONMENT_RESOURCE_OVERLAP"));
});

test("a rendered project must match the description in every host-visible resource", requiresCompose, async (t) => {
  const cleanupEnv = ensureEnvFile();
  t.after(cleanupEnv);
  const directory = await mkdtemp(join(tmpdir(), "aster-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = parse(environment());
  const assignments = composeEnvironment(value);

  function compose(overrides: Record<string, string> = {}) {
    const path = join(directory, `render-${Math.random().toString(16).slice(2)}.env`);
    writeFileSync(path, Object.entries({ ...assignments, ...overrides }).map(([key, entry]) => `${key}=${entry}\n`).join(""));
    return spawnSync("docker", ["compose", "--project-name", value.composeProject, "--project-directory", checkout,
      "--env-file", path, "-f", join(checkout, "docker-compose.yml"), "config", "--format", "json"],
    { cwd: checkout, encoding: "utf8", timeout: 120_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ASTER_") && !key.startsWith("COMPOSE_"))) });
  }
  const rendered = compose();
  assert.equal(rendered.status, 0, rendered.stderr);
  const check = (bytes: string, overrides: Partial<Parameters<typeof checkRenderedProject>[1]> = {}) => checkRenderedProject(
    Buffer.from(bytes),
    { environment: value, projectName: value.composeProject, ...overrides },
  );
  assert.deepEqual(check(rendered.stdout),
    { status: "render-matches-environment", environment: "test", composeProject: "aster-test", productionAdmission: "not-evaluated" });

  const renderCode = (code: string) => (error: unknown) => error instanceof DeploymentRenderError && error.code === code;
  // A description that changes a resource must not accept a project rendered from other values.
  const tampered = compose({ ASTER_APP_VOLUME: "personal-agent-data" });
  assert.equal(tampered.status, 0, tampered.stderr);
  assert.throws(() => check(tampered.stdout), renderCode("RENDER_VOLUME_MISMATCH"));
  // Project name and service set are part of the identity.
  assert.throws(() => checkRenderedProject(Buffer.from(rendered.stdout), {
    environment: value, projectName: "aster-production",
  }), renderCode("RENDER_PROJECT_MISMATCH"));
  const extraService = JSON.parse(rendered.stdout);
  extraService.services["agent-vault"] = { image: "example.invalid/x:latest" };
  assert.throws(() => check(JSON.stringify(extraService)), renderCode("RENDER_SERVICE_MISSING"));
  // The app publishes no port; a rendered mapping is host-reachable surface the description
  // never sanctioned.
  const published = JSON.parse(rendered.stdout);
  published.services["personal-agent"].ports = [
    { mode: "host", host_ip: "127.0.0.1", target: 8080, published: "8080", protocol: "tcp" },
  ];
  assert.throws(() => check(JSON.stringify(published)), renderCode("RENDER_PUBLISHED_PORT"));
  // Boundaries pinned by the base file must survive rendering.
  const weakened = JSON.parse(rendered.stdout);
  delete weakened.services["personal-agent"].cap_drop;
  assert.throws(() => check(JSON.stringify(weakened)), renderCode("RENDER_BOUNDARY_MISMATCH"));
  const namespaced = JSON.parse(rendered.stdout);
  namespaced.services["personal-agent"].network_mode = "service:other";
  assert.throws(() => check(JSON.stringify(namespaced)), renderCode("RENDER_BOUNDARY_MISMATCH"));
  // A named network is not part of the single-service base stack.
  const networked = JSON.parse(rendered.stdout);
  networked.networks = { vault: { name: "aster-test_vault" } };
  assert.throws(() => check(JSON.stringify(networked)), renderCode("RENDER_NETWORK_MISMATCH"));
});

test("CLI reports fixed codes without echoing paths, values or environment contents", requiresCompose, async (t) => {
  const cleanupEnv = ensureEnvFile();
  t.after(cleanupEnv);
  const directory = await mkdtemp(join(tmpdir(), "aster-env-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = "DO_NOT_PRINT_SYNTHETIC_SECRET";
  const path = join(directory, "environment.json");
  await writeFile(path, JSON.stringify({ ...environment(), identity: { botId: "333333" } }));
  await writeFile(join(directory, "other.json"), JSON.stringify(production()));
  await writeFile(join(directory, "broken.json"), `{ ${marker}`);
  const run = (argv: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...argv], {
    cwd: checkout, encoding: "utf8", timeout: 60_000,
  });
  const missing = run(["compare", "--first", join(directory, "absent.json"), "--second", path]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr.includes(marker), false);
  assert.equal(JSON.parse(missing.stderr).productionAdmission, "not-evaluated");
  const broken = run(["compare", "--first", join(directory, "broken.json"), "--second", path]);
  assert.equal(JSON.parse(broken.stderr).code, "ENVIRONMENT_INVALID_JSON");
  assert.equal(broken.stderr.includes(marker), false);
  const distinct = run(["compare", "--first", path, "--second", join(directory, "other.json")]);
  assert.equal(distinct.status, 0, distinct.stderr);
  assert.equal(JSON.parse(distinct.stdout).status, "environments-distinct");
  // Render through the CLI: the description drives the interpolation, so the rendered project
  // matches it by construction. A volume mismatch can only come from the Compose file
  // disagreeing with the interpolation, which the rendered-project test above pins by
  // rendering with an overridden assignment.
  const rendered = run(["render", "--environment", path]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(JSON.parse(rendered.stdout).status, "render-matches-environment");
  for (const argv of [[], ["unknown"], ["compare"], ["compare", "--first", path, "--second", path, "extra"], ["router", "--environment", path]]) {
    const result = run(argv);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "ARGUMENTS_INVALID");
    assert.equal(result.stderr.includes(marker), false);
  }
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /not signature verification or production admission/);
});
