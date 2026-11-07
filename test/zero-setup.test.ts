// Acceptance tests for the zero-setup bot runtime. These exercise the platform manifest, the
// capability resolver, the integration state abstraction, the idempotent provisioner and the
// execution-boundary denial without starting the full service (the wiring tests come with the
// host integration). No test here claims a real vendor connection or a real OS sandbox.

import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  BotProvisioner, chatAllowed,
  type HealthReport, type ProvisioningRecord, type ProvisioningRuntime,
  type ProvisioningSettlement, type ProvisioningStore, type ProvisionTarget,
} from "../src/bot-provisioner.js";
import { resolveCatalog } from "../src/capability-resolver.js";
import {
  INTEGRATION_IDS, IntegrationRegistry, type IntegrationRow, type IntegrationStore,
} from "../src/integrations.js";
import {
  buildPlatformManifest, type PlatformDependencies, type PlatformManifest,
} from "../src/platform-capabilities.js";
import { createToolRegistry } from "../src/tools.js";
import { catalogFor } from "../src/tool-catalog.js";

function makeManifest(overrides: Partial<PlatformDependencies> = {}): PlatformManifest {
  return buildPlatformManifest({
    memoryEnabled: true,
    webConfigured: true,
    webViaPlatformCredential: true,
    computerHost: true,
    mcpConnected: true,
    ...overrides,
  }, () => new Date("2026-11-06T00:00:00.000Z"));
}

class MemoryIntegrationStore implements IntegrationStore {
  readonly rows: IntegrationRow[] = [];
  integrations(): readonly IntegrationRow[] { return this.rows; }
  setIntegration(row: IntegrationRow): void {
    const index = this.rows.findIndex((entry) => entry.service === row.service);
    if (index === -1) this.rows.push(row);
    else this.rows[index] = row;
  }
}

class MemoryProvisioningStore implements ProvisioningStore {
  readonly rows = new Map<string, ProvisioningRecord>();
  claims = 0;
  finishes = 0;
  claim(botId: string, fingerprint: string, startedAt: string): ProvisioningRecord {
    this.claims++;
    const previous = this.rows.get(botId);
    const row: ProvisioningRecord = {
      botId,
      state: "provisioning",
      attempt: (previous?.attempt ?? 0) + 1,
      manifestFingerprint: fingerprint,
      workspace: previous?.workspace ?? null,
      startedAt,
      finishedAt: null,
      error: null,
      unavailable: previous?.unavailable ?? [],
    };
    this.rows.set(botId, row);
    return row;
  }
  finish(botId: string, result: ProvisioningSettlement): ProvisioningRecord {
    this.finishes++;
    const current = this.rows.get(botId);
    if (current === undefined) throw new Error("finish without a claim");
    const row: ProvisioningRecord = { ...current, ...result };
    this.rows.set(botId, row);
    return row;
  }
  record(botId: string): ProvisioningRecord | undefined { return this.rows.get(botId); }
  records(): readonly ProvisioningRecord[] { return [...this.rows.values()]; }
}

const PASSING: HealthReport = {
  ok: true,
  checks: [
    { name: "workspace", ok: true, reason: "目录存在且可写" },
    { name: "conversation", ok: true, reason: "持久会话可读" },
    { name: "core", ok: true, reason: "current_time / tool_search 已注册" },
  ],
};

class FakeRuntime implements ProvisioningRuntime {
  configureCalls = 0;
  healthCalls = 0;
  readonly conversations = new Set<string>();
  failConfigure = false;
  configureMessage = "conversation backend unavailable";
  report: HealthReport = PASSING;
  #next = 0;

  async configure(input: Parameters<ProvisioningRuntime["configure"]>[0]) {
    this.configureCalls++;
    if (this.failConfigure) throw new Error(this.configureMessage);
    const id = input.conversationId ?? String(++this.#next);
    this.conversations.add(id);
    return { conversationId: id, tools: ["current_time", "tool_search"] };
  }
  async health(): Promise<HealthReport> {
    this.healthCalls++;
    return this.report;
  }
}

function target(overrides: Partial<ProvisionTarget> = {}): ProvisionTarget {
  return {
    botId: "first",
    name: "First",
    systemPrompt: "",
    conversationId: undefined,
    cwd: "/data/workspaces/owner/first",
    channel: "console",
    ...overrides,
  };
}

function harness(overrides: {
  readonly manifest?: PlatformManifest;
  readonly runtime?: FakeRuntime;
  readonly store?: MemoryProvisioningStore;
} = {}) {
  const store = overrides.store ?? new MemoryProvisioningStore();
  const runtime = overrides.runtime ?? new FakeRuntime();
  const manifest = overrides.manifest ?? makeManifest();
  const integrations = new IntegrationRegistry(new MemoryIntegrationStore());
  const provisioner = new BotProvisioner({ store, manifest, integrations, runtime, log: () => {} });
  return { store, runtime, manifest, integrations, provisioner };
}

function restarted(store: MemoryProvisioningStore, runtime: FakeRuntime, manifest = makeManifest()): BotProvisioner {
  return new BotProvisioner({
    store, manifest, runtime,
    integrations: new IntegrationRegistry(new MemoryIntegrationStore()),
    log: () => {},
  });
}

test("platform manifest marks unconfigured services unavailable and gates internal defaults", () => {
  const manifest = makeManifest({
    memoryEnabled: false, webConfigured: false,
    computerHost: false, mcpConnected: false,
  });
  const states = new Map(manifest.capabilities.map((entry) => [entry.id, entry.state]));
  assert.equal(states.get("core"), "available");
  assert.equal(states.get("workspace"), "available");
  assert.equal(states.get("integration"), "available");
  assert.equal(states.get("memory"), "unavailable");
  assert.equal(states.get("web"), "unavailable");
  assert.equal(states.get("computer"), "unavailable");
  assert.equal(states.get("task"), "unavailable");
  // Bash is only a zero-setup default when the shared execution host is configured.
  assert.equal(manifest.defaults.shell, false);
  assert.equal(manifest.defaults.web, false);
  assert.equal(manifest.defaults.ptc, false);
  assert.equal(manifest.defaults.memory, false);
  assert.equal(manifest.defaults.reminders, false);
  assert.equal(manifest.defaults.mcp, false);
  assert.equal(manifest.defaults.core, true);
  assert.equal(manifest.defaults.files, true);
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(manifest.capabilities.find((entry) => entry.id === "computer")!.reason, /未配置共享执行主机/);
  assert.ok(manifest.capabilities.every((entry) => !/Bearer|sk-|api[_-]?key/i.test(entry.reason)),
    "operator reasons never carry a credential");
});

test("a changed deployment changes the manifest fingerprint", () => {
  assert.notEqual(makeManifest().fingerprint, makeManifest({ webConfigured: false }).fingerprint);
});

test("a configured shared execution host grants Bash but never the retired groups", () => {
  const manifest = makeManifest({ computerHost: true });
  assert.equal(manifest.capabilities.find((entry) => entry.id === "computer")!.state, "available");
  assert.equal(manifest.defaults.shell, true);
  // Phase 1 migrates Bash / Read / Write / Edit only; retired PTC/reminders switches always stay off.
  assert.equal(manifest.defaults.ptc, false);
  assert.equal(manifest.defaults.reminders, false);
});

test("capability resolver closes unavailable groups with exact-name reasons", () => {
  const { manifest, integrations } = harness({
    manifest: makeManifest({ webConfigured: false, computerHost: false }),
  });
  const resolved = resolveCatalog({ manifest, integrations });
  assert.equal(resolved.profile.core, true);
  assert.equal(resolved.profile.files, true);
  assert.equal(resolved.profile.web, false);
  assert.equal(resolved.profile.shell, false);
  assert.equal(resolved.profile.ptc, false);
  assert.equal(resolved.profile.reminders, false);
  assert.equal(resolved.profile.mcp, false, "no external integration is connected in this phase");
  assert.match(resolved.reasons.get("web_search") ?? "", /能力 web 不可用/);
  assert.match(resolved.reasons.get("bash") ?? "", /能力 computer 不可用/);
  // Retired groups select no tools, so no exact-name reason is emitted for them.
  assert.equal(resolved.reasons.get("reminder_create"), undefined);
  // A retired capability stays in the platform status but is excluded from provisioning degradation.
  assert.deepEqual(resolved.unavailableCapabilities, ["web", "computer"]);
});

test("integration authorization never claims a connection", () => {
  const registry = new IntegrationRegistry(new MemoryIntegrationStore());
  assert.equal(registry.list().length, INTEGRATION_IDS.length);
  assert.ok(registry.list().every((view) => view.state === "disconnected"));
  assert.equal(registry.connectedServices().size, 0);
  const request = registry.request("github");
  assert.equal(request.connected, false);
  assert.equal(request.state, "authorization_pending");
  assert.equal(request.implementation, "not_implemented");
  assert.match(request.message, /未接入 OAuth/);
  assert.equal(registry.state("github"), "authorization_pending");
  assert.equal(registry.connectedServices().size, 0);
  assert.throws(() => registry.complete("github"), /not implemented/);
  assert.throws(() => registry.request("unknown"), /Unknown external integration/);
});

test("provisioning is idempotent and reuses one workspace and one conversation", async () => {
  const { store, runtime, provisioner } = harness();
  const first = await provisioner.provision(target());
  assert.equal(first.state, "ready");
  assert.equal(first.workspace, "/data/workspaces/owner/first");
  const conversationId = [...runtime.conversations][0]!;
  const second = await provisioner.provision(target({ conversationId }));
  assert.equal(second.attempt, 1);
  assert.equal(second.state, "ready");
  assert.equal(runtime.configureCalls, 1);
  assert.equal(runtime.conversations.size, 1);
  assert.equal(store.claims, 1);
  assert.equal(store.records().length, 1);
});

test("a changed manifest fingerprint re-provisions the same resources", async () => {
  const store = new MemoryProvisioningStore();
  const runtime = new FakeRuntime();
  await restarted(store, runtime).provision(target());
  const conversationId = [...runtime.conversations][0]!;
  const after = await restarted(store, runtime, makeManifest({ webConfigured: false }))
    .provision(target({ conversationId }));
  assert.equal(after.state, "degraded");
  assert.equal(after.attempt, 2);
  assert.equal(runtime.conversations.size, 1);
  assert.equal(after.workspace, "/data/workspaces/owner/first");
});

test("restart re-verifies health instead of trusting a durable Ready row", async () => {
  const store = new MemoryProvisioningStore();
  const runtime = new FakeRuntime();
  const ready = await restarted(store, runtime).provision(target());
  assert.equal(ready.state, "ready");
  runtime.report = {
    ok: false,
    checks: [{ name: "conversation", ok: false, reason: "transcript missing" }],
  };
  const conversationId = [...runtime.conversations][0]!;
  const after = await restarted(store, runtime).provision(target({ conversationId }));
  assert.equal(after.state, "failed");
  assert.equal(chatAllowed(after.state), false);
  assert.match(after.error ?? "", /健康检查未通过/);
  assert.match(after.error ?? "", /transcript missing/);
});

test("an empty or inconsistent health report cannot produce Ready", async () => {
  const runtime = new FakeRuntime();
  runtime.report = { ok: true, checks: [] };
  const { provisioner } = harness({ runtime });
  const record = await provisioner.provision(target());
  assert.equal(record.state, "failed");
  assert.match(record.error ?? "", /未提供任何校验项/);
});

test("a failed initialization is retryable and is never reported as success", async () => {
  const { store, runtime, provisioner } = harness();
  runtime.failConfigure = true;
  const failed = await provisioner.provision(target());
  assert.equal(failed.state, "failed");
  assert.equal(chatAllowed(failed.state), false);
  assert.match(failed.error ?? "", /运行时初始化失败/);
  assert.equal(store.record("first")?.state, "failed");
  runtime.failConfigure = false;
  const retried = await provisioner.retry(target());
  assert.equal(retried.state, "ready");
  assert.equal(retried.attempt, 2);
  assert.equal(retried.error, null);
  assert.equal(runtime.configureCalls, 2);
  assert.equal(runtime.conversations.size, 1);
});

test("an interrupted provisioning claim is an unknown result, not a success", async () => {
  const store = new MemoryProvisioningStore();
  store.claim("first", "old-fingerprint", "2026-11-06T00:00:00.000Z");
  const runtime = new FakeRuntime();
  const record = await restarted(store, runtime).provision(target());
  assert.equal(record.state, "ready");
  assert.equal(record.attempt, 2);
  assert.equal(runtime.configureCalls, 1);
});

test("concurrent provisions of one bot share a single attempt", async () => {
  const { runtime, provisioner } = harness();
  const [left, right] = await Promise.all([
    provisioner.provision(target()), provisioner.provision(target()),
  ]);
  assert.equal(left.attempt, 1);
  assert.equal(right.attempt, 1);
  assert.equal(runtime.configureCalls, 1);
  assert.equal(left.state, "ready");
  assert.equal(right.state, "ready");
});

test("unavailable optional capabilities produce degraded, never Ready", async () => {
  const { provisioner } = harness({ manifest: makeManifest({ webConfigured: false }) });
  const record = await provisioner.provision(target());
  assert.equal(record.state, "degraded");
  assert.deepEqual(record.unavailable, ["web"]);
  assert.equal(record.error, null);
  assert.equal(chatAllowed(record.state), true);
});

test("an unavailable required capability can never produce Ready", async () => {
  const base = makeManifest();
  const broken: PlatformManifest = {
    ...base,
    capabilities: base.capabilities.map((entry) => entry.id === "workspace"
      ? { ...entry, state: "unavailable" as const, reason: "工作区不可写" }
      : entry),
  };
  const { provisioner } = harness({ manifest: broken });
  const record = await provisioner.provision(target());
  assert.equal(record.state, "failed");
  assert.match(record.error ?? "", /基础能力不可用：workspace/);
  assert.equal(chatAllowed(record.state), false);
});

test("a missing provisioning record never permits chat", () => {
  assert.equal(chatAllowed(undefined), false);
  assert.equal(chatAllowed("provisioning"), false);
  assert.equal(chatAllowed("failed"), false);
});

test("failure reasons are bounded and never report success", async () => {
  const runtime = new FakeRuntime();
  runtime.failConfigure = true;
  runtime.configureMessage = "x".repeat(2_000);
  const { provisioner } = harness({ runtime });
  const record = await provisioner.provision(target());
  assert.equal(record.state, "failed");
  assert.equal(chatAllowed(record.state), false);
  assert.ok((record.error ?? "").length <= 520);
});

test("a host error echoing a bearer-shaped value is redacted before it is persisted", async () => {
  const runtime = new FakeRuntime();
  runtime.failConfigure = true;
  // Built from pieces so no literal that looks like a credential is ever written to disk here.
  const suffix = ["example", "0123456789"].join("");
  runtime.configureMessage = ["provider said Bearer sk-", suffix].join("");
  const { provisioner } = harness({ runtime });
  const record = await provisioner.provision(target());
  assert.equal(record.state, "failed");
  assert.ok(!record.error?.includes(suffix), "a credential-shaped value must not reach the log or the row");
  assert.match(record.error ?? "", /\[redacted\]/);
});

test("deferred discovery only sees tools whose capability is actually available", () => {
  const names = ["current_time", "tool_search", "bash", "web_search", "memory_search"];
  const tools = names.map((name) => defineTool({
    name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => ({ output: [] }),
  }));
  const registry = createToolRegistry([defineExtension({ name: "sample", tools })], { log: () => {} });
  const entries = registry.snapshot().tools().map(({ tool }) => ({ tool, record: registry.lookup(tool.name) }));
  const { integrations } = harness();
  const off = resolveCatalog({
    manifest: makeManifest({ webConfigured: false, computerHost: false }), integrations,
  });
  const on = resolveCatalog({ manifest: makeManifest(), integrations });
  const offNames = catalogFor(entries, off.profile, off.scope).names;
  const onNames = catalogFor(entries, on.profile, on.scope).names;
  assert.equal(offNames.has("current_time"), true);
  assert.equal(offNames.has("tool_search"), true);
  assert.equal(offNames.has("web_search"), false);
  assert.equal(offNames.has("bash"), false);
  assert.equal(onNames.has("web_search"), true);
  assert.equal(onNames.has("bash"), true);
  assert.ok(onNames.size > offNames.size, "not every declaration is resident in every context");
});

test("an unavailable tool is not exposed and a direct call is rejected with a clear reason", async () => {
  const webSearch = defineTool({
    name: "web_search",
    description: "search",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => ({ output: [{ type: "text" as const, text: "must not run" }] }),
  });
  const registry = createToolRegistry(
    [defineExtension({ name: "web-tools", tools: [webSearch] })],
    { log: () => {} },
  );
  const { manifest, integrations } = harness({ manifest: makeManifest({ webConfigured: false }) });
  const resolved = resolveCatalog({ manifest, integrations });
  const entries = registry.snapshot().tools().map(({ tool }) => ({ tool, record: registry.lookup(tool.name) }));
  const catalog = catalogFor(entries, resolved.profile, resolved.scope);
  assert.equal(catalog.names.has("web_search"), false, "an unavailable capability is not discoverable");
  registry.setConversationCatalog(1, resolved.profile, resolved.scope, catalog.names, resolved.reasons);
  const native = registry.snapshot().tools().find(({ tool }) => tool.name === "web_search")!.tool;
  const result = await native.execute({}, {
    conversationId: 1, taskId: 2, callId: "direct",
  } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal((result.details as { code?: string }).code, "TOOL_CAPABILITY_UNAVAILABLE");
  assert.match(JSON.stringify(result.output), /能力 web 不可用/);
});
