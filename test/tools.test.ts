import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { connectMcp } from "../src/mcp.js";
import { createToolRegistry, currentTime, personalTools, type GovernedTool } from "../src/tools.js";

const example = (name: string, parameters = Type.Object({})) => defineTool({
  name,
  description: name,
  parameters,
  execute: async () => ({ output: [] }),
});

test("registration exposes immutable governance without changing native tools", () => {
  const registry = createToolRegistry();
  const clock = registry.lookup("current_time");
  assert.ok(clock);
  assert.deepEqual(clock, {
    name: "current_time",
    source: { kind: "builtin", extension: "personal-tools" },
    tier: 1,
    trust: "trusted",
    replay: "safe",
    authz: "read",
    schemaHash: clock.schemaHash,
    state: "available",
  });
  assert.match(clock.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal(registry.lookup("write")?.authz, "write");
  assert.equal(registry.lookup("bash")?.replay, "unsafe");
  assert.equal(registry.lookup("missing"), undefined);
  assert.equal(Object.isFrozen(clock), true);
  assert.equal(Object.isFrozen(clock.source), true);
  assert.equal(Object.isFrozen(registry.records()), true);
  const native = registry.snapshot().tools().find(({ tool }) => tool.name === "current_time")!.tool;
  assert.equal(native.parameters, currentTime.parameters);
  assert.equal(native.replay, currentTime.replay);
  assert.equal(native.description, currentTime.description);
});

test("late installs reject collisions atomically and retain native replace/uninstall semantics", () => {
  const registry = createToolRegistry([personalTools]);
  let notifications = 0;
  registry.subscribe(() => {
    notifications++;
    for (const { tool } of registry.snapshot().tools()) assert.ok(registry.lookup(tool.name));
  });
  assert.throws(() => registry.install({ name: "collision", tools: [example("extra"), currentTime] }), /Duplicate tool name/);
  assert.equal(registry.lookup("extra"), undefined);
  assert.equal(registry.snapshot().extension("collision"), undefined);
  assert.equal(notifications, 0);
  assert.throws(() => registry.install({ name: "twice", tools: [example("extra"), example("extra")] }), /Duplicate tool name/);
  assert.throws(() => registry.install({ name: "invalid", tools: [example("extra")], sections: [{ key: "INVALID", render: () => "" }] }), /must match/);
  assert.equal(registry.lookup("extra"), undefined, "failed native validation must not publish governance");
  assert.equal(notifications, 0);
  registry.install({ name: "personal-tools", tools: [example("replacement")] });
  assert.equal(registry.lookup("current_time"), undefined);
  assert.equal(registry.lookup("replacement")?.state, "available");
  assert.deepEqual(registry.records().map(({ name }) => name), ["replacement"]);
  registry.uninstall(personalTools);
  assert.equal(registry.lookup("replacement"), undefined);
  assert.equal(registry.snapshot().tools().length, 0);
  assert.equal(notifications, 2);
});

test("a stale executor cannot borrow a replacement registration's authority", async () => {
  let writes = 0;
  const write = defineTool({ name: "action", description: "write", parameters: Type.Object({}),
    execute: async () => { writes++; return { output: [] }; } });
  const registry = createToolRegistry([defineExtension({ name: "action", tools: [write] })], {
    authority: "restricted", log: () => {},
  });
  const stale = registry.snapshot().tools()[0]!.tool;
  const read = Object.assign(defineTool({ name: "action", description: "read", parameters: Type.Object({}),
    execute: async () => ({ output: [] }) }), {
    governance: { source: { kind: "builtin" as const, extension: "action" }, trust: "trusted" as const, authz: "read" as const },
  });
  registry.install(defineExtension({ name: "action", tools: [read] }));
  const result = await stale.execute({}, {
    conversationId: 1, taskId: 2, callId: "stale",
  } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal((result.details as { code?: string }).code, "TOOL_REGISTRATION_CHANGED");
  assert.equal(writes, 0);
});

test("tool wrappers are rejected because they can replace the reviewed executor", () => {
  const registry = createToolRegistry([personalTools]);
  assert.throws(() => registry.install({
    name: "wrapper",
    wraps: [{ tool: "current_time", wrap: (tool: ToolRegistration) => ({ ...tool, execute: async () => ({ output: [] }) }) }],
  }), /Tool wrappers are not supported/);
  assert.equal(registry.snapshot().extension("wrapper"), undefined);
});

test("MCP availability changes are atomic per server and preserve native declarations and old records", () => {
  const mcpTool = (name: string, server: string): GovernedTool => Object.assign(example(name), {
    governance: { source: { kind: "mcp" as const, server }, trust: "untrusted" as const, authz: "write" as const },
  });
  const registry = createToolRegistry([personalTools]);
  registry.install({ name: "one", tools: [mcpTool("alpha", "one"), mcpTool("beta", "one")] });
  registry.install({ name: "two", tools: [mcpTool("gamma", "two")] });
  const snapshot = registry.snapshot();
  const original = registry.lookup("alpha")!;
  let changes = 0;
  registry.subscribe(() => {
    changes++;
    assert.equal(registry.lookup("alpha")?.state, registry.lookup("beta")?.state);
  });
  registry.setMcpAvailability("one", "unavailable");
  registry.setMcpAvailability("one", "unavailable");
  assert.equal(changes, 1);
  assert.equal(registry.lookup("gamma")?.state, "available");
  assert.equal(registry.lookup("current_time")?.state, "available");
  assert.equal(original.state, "available", "published records are immutable snapshots");
  assert.deepEqual(registry.lookup("alpha"), { ...original, state: "unavailable" });
  assert.equal(registry.snapshot(), snapshot, "health does not republish native registrations");
  registry.setMcpAvailability("one", "available");
  assert.equal(changes, 2);
  assert.deepEqual(registry.lookup("alpha"), original);
  registry.setMcpAvailability("early", "unavailable");
  registry.install({ name: "early", tools: [mcpTool("delta", "early")] });
  assert.equal(registry.lookup("delta")?.state, "unavailable", "an install inherits observed server state");
});

test("schema hashes ignore object key order and retain schema differences", () => {
  const registry = createToolRegistry([]);
  const hash = (parameters: ReturnType<typeof Type.Object>) => {
    registry.install(defineExtension({ name: "hash", tools: [example("hash", parameters)] }));
    return registry.lookup("hash")!.schemaHash;
  };
  const first = hash(Type.Object({ a: Type.String(), b: Type.Number() }, { required: ["a", "b"] }));
  assert.equal(first, hash(Type.Object({ b: Type.Number(), a: Type.String() }, { required: ["a", "b"] })));
  assert.notEqual(first, hash(Type.Object({ a: Type.String(), b: Type.Boolean() }, { required: ["a", "b"] })));
});

test("MCP registrations use the same records with adapter-owned source and conservative metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-register-"));
  const host = await connectMcp({ servers: [{
    name: "calendar", transport: "stdio", command: "unused", args: [], env: {}, inheritEnv: false,
    timeoutMs: 1000, connectTimeoutMs: 1000,
  }] }, {
    dataDir: directory,
    reserved: new Set(),
    log: () => {},
    connect: async () => ({
      serverName: "calendar",
      listTools: async () => [{ name: "events", inputSchema: { type: "object" } }],
      callTool: async () => ({ content: [] }),
      close: async () => {},
      subscribeAvailability: (listener) => { listener("available"); return () => {}; },
    }),
  });
  try {
    const registry = createToolRegistry();
    for (const extension of host.extensions) registry.install(extension);
    const record = registry.lookup("mcp__calendar__events");
    assert.ok(record);
    assert.deepEqual(record.source, { kind: "mcp", server: "calendar" });
    assert.equal(record.tier, 2);
    assert.equal(record.trust, "untrusted");
    assert.equal(record.authz, "write");
    assert.equal(record.replay, "unsafe");
    assert.equal(registry.lookup("tool_search")?.tier, 1);
    assert.equal(registry.lookup("tool_search")?.trust, "trusted");
    assert.equal(registry.snapshot().tools().find(({ tool }) => tool.name === record.name)?.tool.deferred, true);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
