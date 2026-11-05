import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { readMcpConfig, validateMcpConfig } from "../src/mcp-config.js";

const env = { GITHUB_TOKEN: "secret-token", EXTRA: "value" };

test("the MCP config path defaults under DATA_DIR and can be overridden", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_OWNER_ID: "42",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "model",
    OPENAI_API_KEY: "key",
    DATA_DIR: "data-dir",
  };
  const config = readConfig(base);
  assert.equal(config.mcpConfigPath, resolve("data-dir", "mcp.json"));
  assert.equal(config.mcpConfigExplicit, false);

  const overridden = readConfig({ ...base, MCP_CONFIG: "custom/mcp.json" });
  assert.equal(overridden.mcpConfigPath, resolve("custom/mcp.json"));
  assert.equal(overridden.mcpConfigExplicit, true);
});

function stdio(overrides: Record<string, unknown> = {}) {
  return { name: "fixture", transport: "stdio", command: "npx", args: ["-y", "server-github"], ...overrides };
}

test("a missing default MCP file means the feature is off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-config-"));
  try {
    const result = await readMcpConfig(join(directory, "mcp.json"), false, env);
    assert.equal(result.error, undefined);
    assert.equal(result.config, undefined);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly configured MCP file must exist and be valid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-config-"));
  try {
    const missing = join(directory, "mcp.json");
    const absent = await readMcpConfig(missing, true, env);
    assert.match(absent.error ?? "", /cannot be read/);

    await writeFile(missing, "{ not json", "utf8");
    const broken = await readMcpConfig(missing, true, env);
    assert.match(broken.error ?? "", /not valid JSON/);
    assert.equal(broken.config, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stdio server is parsed with defaults and ${ENV} references resolved", () => {
  const result = validateMcpConfig({
    servers: [stdio({
      cwd: process.cwd(),
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LITERAL: "plain" },
      args: ["-y", "server-github", "${EXTRA}"],
    })],
  }, env);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.warnings, []);
  const server = result.config?.servers[0];
  assert.equal(server?.transport, "stdio");
  assert.equal(server?.timeoutMs, 60_000);
  assert.equal(server?.connectTimeoutMs, 10_000);
  assert.equal(server?.transport === "stdio" ? server.inheritEnv : undefined, false);
  assert.deepEqual(server?.transport === "stdio" ? server.env : undefined, { GITHUB_TOKEN: "secret-token", LITERAL: "plain" });
  assert.deepEqual(server?.transport === "stdio" ? server.args : undefined, ["-y", "server-github", "value"]);
});

test("a file-level problem fails the whole configuration", () => {
  assert.match(validateMcpConfig([]).error ?? "", /must be a JSON object/);
  assert.match(validateMcpConfig({}).error ?? "", /must contain a servers array/);
  assert.match(validateMcpConfig({ servers: [], extra: true }).error ?? "", /Unknown MCP config key: extra/);
});

test("tool pin options use registered names and bounded integer budgets", () => {
  const result = validateMcpConfig({ servers: [], tools: {
    mcp__s__echo: { pin: true }, mcp__s__other: { pin: false },
  }, residentToolBudgetTokens: 4_096 });
  assert.deepEqual(result.config?.tools, { mcp__s__echo: { pin: true }, mcp__s__other: { pin: false } });
  assert.equal(result.config?.residentToolBudgetTokens, 4_096);
  for (const invalid of [null, 0, 1.5, "8192", 1_048_577]) {
    assert.match(validateMcpConfig({ servers: [], residentToolBudgetTokens: invalid }).error ?? "", /residentToolBudgetTokens/);
  }
  for (const invalid of [[], null, { read: { pin: true } }, { "mcp__s__bad name": { pin: true } },
    { mcp__s__echo: { pin: "true" } }, { mcp__s__echo: { pin: true, authz: "admin" } }, { mcp__s__echo: {} },
    { mcp__s__echo: { authz: null } }, { mcp__s__echo: { authz: "read", extra: true } }]) {
    assert.match(validateMcpConfig({ servers: [], tools: invalid }).error ?? "", /tools/);
  }
});

test("an over-count server list keeps the first eight instead of disabling all of them", () => {
  // http servers, so the stdio budget does not decide which entries survive.
  const http = (index: number) => ({ name: `s${index}`, transport: "http", url: "https://example.com/mcp" });
  const result = validateMcpConfig({ servers: Array.from({ length: 9 }, (_value, index) => http(index)) });
  assert.equal(result.error, undefined, "the rest of the file stays usable");
  assert.deepEqual(result.config?.servers.map((server) => server.name), ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  assert.match(result.warnings[0] ?? "", /at most 8 servers are allowed; 1 entry ignored/);
});

test("a broken server entry is skipped without failing the others", () => {
  const result = validateMcpConfig({
    servers: [
      { name: "bad", transport: "stdio" },
      stdio(),
      { name: "wrongTransport", transport: "sse", url: "https://example.com/mcp" },
      stdio({ name: "extra", unknownKey: true }),
      stdio({ name: "bad name!" }),
    ],
  }, env);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.config?.servers.map((server) => server.name), ["fixture"]);
  assert.equal(result.warnings.length, 4);
  assert.match(result.warnings[0]!, /servers\[0\]: .*command/);
});

test("duplicate names and the stdio budget are reported as warnings", () => {
  const result = validateMcpConfig({
    servers: [
      stdio({ name: "one" }),
      stdio({ name: "one" }),
      stdio({ name: "two" }),
      stdio({ name: "three" }),
      stdio({ name: "four" }),
      stdio({ name: "five" }),
    ],
  }, env);
  assert.deepEqual(result.config?.servers.map((server) => server.name), ["one", "two", "three", "four"]);
  assert.match(result.warnings.join("\n"), /duplicate server name one/);
  assert.match(result.warnings.join("\n"), /at most 4 stdio servers/);
});

test("a missing environment variable disables the server and names only the variable", () => {
  const result = validateMcpConfig({
    servers: [stdio({ env: { GITHUB_TOKEN: "${NOT_SET_ANYWHERE}" } })],
  }, env);
  assert.deepEqual(result.config?.servers, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /NOT_SET_ANYWHERE/);
  assert.doesNotMatch(result.warnings[0]!, /secret-token/);
});

test("stdio validation rejects unsafe shapes", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [stdio({ name: "" }), /name must match/],
    [stdio({ name: "a".repeat(25) }), /name must match/],
    [stdio({ command: "  " }), /command must be a non-empty string/],
    [stdio({ args: "nope" }), /args must be an array of strings/],
    [stdio({ args: ["ok", 1] }), /args must be an array of strings/],
    [stdio({ env: { TOKEN: 1 } }), /env must be an object of strings/],
    [stdio({ env: { "not a name": "x" } }), /invalid environment variable name/],
    [stdio({ env: { OK: "x" }, inheritEnv: "yes" }), /inheritEnv must be a boolean/],
    [stdio({ cwd: "relative/path" }), /cwd must be an absolute path/],
    [stdio({ cwd: join(process.cwd(), "does-not-exist-xyz") }), /cwd is not an existing directory/],
    [stdio({ timeoutMs: 10 }), /timeoutMs must be an integer between 1000 and 300000/],
    [stdio({ connectTimeoutMs: 999_999 }), /connectTimeoutMs must be an integer between 1000 and 120000/],
    [stdio({ url: "https://example.com/mcp" }), /unknown key url/],
    [{ name: "x", transport: "stdio", command: "npx", headers: {} }, /unknown key headers/],
  ];
  for (const [server, expected] of cases) {
    const result = validateMcpConfig({ servers: [server] }, env);
    assert.deepEqual(result.config?.servers, [], `expected rejection for ${JSON.stringify(server)}`);
    assert.match(result.warnings[0]!, expected);
  }
});

test("http validation requires https except on loopback and keeps headers", () => {
  const good = validateMcpConfig({
    servers: [{
      name: "calendar",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Extra": "${EXTRA}" },
    }],
  }, env);
  const server = good.config?.servers[0];
  assert.equal(server?.transport, "http");
  assert.deepEqual(server?.transport === "http" ? server.headers : undefined, { "X-Extra": "value" });

  const loopback = validateMcpConfig({ servers: [{ name: "local", transport: "http", url: "http://127.0.0.1:8788/mcp" }] }, env);
  assert.equal(loopback.config?.servers.length, 1);

  const cases: [Record<string, unknown>, RegExp][] = [
    [{ name: "plain", transport: "http", url: "http://mcp.example.com/mcp" }, /http is allowed only on loopback/],
    [{ name: "nope", transport: "http", url: "not-a-url" }, /url must be an https URL/],
    [{ name: "user", transport: "http", url: "https://user:pass@example.com/mcp" }, /url must be an https URL/],
    [{ name: "header", transport: "http", url: "https://example.com/mcp", headers: { "X-Bad": "a\nb" } }, /not allowed in an HTTP header/],
    [{ name: "header", transport: "http", url: "https://example.com/mcp", headers: { "Bad Header": "x" } }, /invalid header name/],
    [{ name: "cmd", transport: "http", url: "https://example.com/mcp", command: "npx" }, /unknown key command/],
  ];
  for (const [server2, expected] of cases) {
    const result = validateMcpConfig({ servers: [server2] }, env);
    assert.deepEqual(result.config?.servers, []);
    assert.match(result.warnings[0]!, expected);
  }
});

test("header values are validated after ${ENV} resolution and must be ByteString", () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ["a non-Latin-1 character", { "X-Client": "个人助手" }, /not allowed in an HTTP header/],
    ["a carriage return from the environment", { "X-Client": "${WITH_CR}" }, /not allowed in an HTTP header/],
    ["a tab is allowed", { "X-Client": "a\tb" }, /^$/],
  ];
  for (const [label, headers, expected] of cases) {
    const result = validateMcpConfig({
      servers: [{ name: "h", transport: "http", url: "https://example.com/mcp", headers }],
    }, { ...env, WITH_CR: "a\rb" });
    if (expected.source === "^$") {
      assert.deepEqual(result.warnings, [], label);
      assert.equal(result.config?.servers[0]?.transport === "http" ? result.config.servers[0].headers["X-Client"] : undefined, "a\tb");
    } else {
      assert.deepEqual(result.config?.servers, [], label);
      assert.match(result.warnings[0] ?? "", expected, label);
    }
  }
});

test("a UTF-8 BOM does not make the config file invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-config-"));
  try {
    const path = join(directory, "mcp.json");
    // Windows editors write this; JSON.parse alone rejects it.
    await writeFile(path, `﻿${JSON.stringify({ servers: [stdio()] })}`, "utf8");
    const result = await readMcpConfig(path, true, env);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.config?.servers.map((server) => server.name), ["fixture"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oauth is only accepted for http servers and resolves its client secret", () => {
  const good = validateMcpConfig({
    servers: [{
      name: "calendar",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      auth: { type: "oauth", scope: "calendar.read", clientSecret: "${EXTRA}", redirectPort: 9000 },
    }],
  }, env);
  const server = good.config?.servers[0];
  assert.equal(server?.transport === "http" ? server.auth?.redirectPort : undefined, 9_000);
  assert.equal(server?.transport === "http" ? server.auth?.scope : undefined, "calendar.read");
  assert.equal(server?.transport === "http" ? server.auth?.clientSecret : undefined, "value");

  const defaults = validateMcpConfig({ servers: [{ name: "c", transport: "http", url: "https://example.com/mcp", auth: { type: "oauth" } }] }, env);
  assert.equal(defaults.config?.servers[0]?.transport === "http" ? defaults.config.servers[0].auth?.redirectPort : undefined, 8_765);

  const cases: [Record<string, unknown>, RegExp][] = [
    [stdio({ auth: { type: "oauth" } }), /unknown key auth/],
    [{ name: "c", transport: "http", url: "https://example.com/mcp", auth: { type: "basic" } }, /auth.type must be "oauth"/],
    [{ name: "c", transport: "http", url: "https://example.com/mcp", auth: { type: "oauth", redirectPort: 80 } }, /redirectPort must be an integer between 1024 and 65535/],
    [{ name: "c", transport: "http", url: "https://example.com/mcp", auth: { type: "oauth", redirectPort: "8765" } }, /redirectPort must be an integer between 1024 and 65535/],
    [{ name: "c", transport: "http", url: "https://example.com/mcp", auth: { type: "oauth", unknown: 1 } }, /unknown auth key unknown/],
    [{ name: "c", transport: "http", url: "https://example.com/mcp", auth: { type: "oauth", authorizationServerMetadataUrl: "http://example.com/meta" } }, /must be an https URL/],
  ];
  for (const [server2, expected] of cases) {
    const result = validateMcpConfig({ servers: [server2] }, env);
    assert.deepEqual(result.config?.servers, []);
    assert.match(result.warnings[0]!, expected);
  }
});
