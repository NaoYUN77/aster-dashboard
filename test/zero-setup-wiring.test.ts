// End-to-end acceptance for the zero-setup runtime: the owner opens the console and can talk to a
// bot without ever naming a Tool, MCP server, Capability, Registry, Pin or API key.
//
// Everything below goes through the real HTTP surface and the real service composition. A service
// restart on the same DATA_DIR must recover the same bot, workspace and transcript rather than
// allocating a second one. Unconfigured dependencies are reported as unavailable, never as Ready.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { startService, type ServiceHandle } from "../src/main.js";

const TOKEN = "{{SECRET_5xpdbsvp}}";
const MODEL = "faux-1";

function environment(dataDir: string): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dataDir,
    TELEGRAM_ENABLED: "0",
    CONSOLE_ENABLED: "1",
    WEB_TOKEN: TOKEN,
    CONSOLE_HOST: "127.0.0.1",
    CONSOLE_PORT: "0",
    MODEL_PROVIDER: "openai",
    MODEL_ID: MODEL,
    OPENAI_API_KEY: "faux",
    MEMORY_ENABLED: "0",
    // No platform Web credential, no CCR profile, no verified OS sandbox and no Telegram identity:
    // those capabilities must be reported unavailable instead of being silently granted.
  };
}

function scriptedProvider() {
  const faux = fauxProvider({ provider: "openai" });
  faux.setResponses(Array.from({ length: 64 }, () => () => fauxAssistantMessage("OK")));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

type Console = {
  base: string;
  call(path: string, body?: unknown, method?: string): Promise<{ status: number; body: any }>;
};

function consoleOf(service: ServiceHandle): Console {
  const port = service.console?.port;
  assert.ok(port !== undefined, "the console must be listening");
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { base, call };
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("first entry creates a usable bot with no user configuration, and a restart recovers it", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-zero-setup-"));
  const env = environment(directory);
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env, models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);

    // 1. The first Bot exists already. The user did not create, configure or register anything.
    const listed = await console.call("/api/bots");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.bots.length, 1);
    const first = listed.body.bots[0];
    assert.equal(first.botId, "default");
    assert.equal(first.userId, "owner");
    assert.ok(first.conversationId !== "" && !first.conversationId.startsWith("pending:"));
    assert.ok(["ready", "degraded"].includes(first.provisioning.state), `unexpected state: ${first.provisioning.state}`);
    assert.equal(first.provisioning.error, null);
    assert.equal(first.greeting, "你好，我已经准备好了。");
    assert.equal(first.provisioning.attempt, 1);
    assert.ok(first.provisioning.workspace);

    // 2. Optional capabilities that are not deployed are honestly unavailable. The bot is still
    //    usable, but it is degraded rather than falsely Ready.
    assert.ok(first.provisioning.unavailable.includes("computer"));
    assert.ok(first.provisioning.unavailable.includes("web"));
    assert.ok(first.provisioning.unavailable.includes("task"));

    const platform = await console.call("/api/platform");
    assert.equal(platform.status, 200);
    const computer = platform.body.capabilities.find((entry: { id: string }) => entry.id === "computer");
    assert.equal(computer.state, "unavailable");
    assert.equal(computer.verification, "not-configured");
    assert.ok(platform.body.fingerprint.length >= 32);
    assert.equal(platform.body.provisioning.length, 1);

    // 3. The catalog the platform resolved excludes unconfigured tools but still exposes the
    //    integration status/authorization tools (they cannot connect anything by themselves).
    assert.ok(!first.loadedTools.includes("bash"), "host bash must not be a zero-setup default");
    assert.ok(!first.loadedTools.includes("web_search"));
    assert.ok(first.loadedTools.includes("current_time"));
    assert.ok(first.loadedTools.includes("integration_status"));
    assert.ok(first.loadedTools.includes("integration_request"));

    // 4. The browser cannot name a capability, tool, profile or scope.
    const withProfile = await console.call("/api/bots", { name: "Sneaky", profile: { shell: true } });
    assert.equal(withProfile.status, 400);
    const patch = await console.call("/api/bots/default", { profile: { shell: true } }, "PATCH");
    assert.equal(patch.status, 404);

    // 5. Chat works immediately, with no tool/MCP/key setup.
    const accepted = await console.call("/api/bots/default/messages", { text: "你好，请记下 MVP 已启动" });
    assert.equal(accepted.status, 202);
    await waitFor("the assistant's answer", async () => {
      const history = await console.call("/api/bots/default/history?limit=50");
      return history.body.messages.some((message: { role: string }) => message.role === "assistant") ? true : undefined;
    });

    // 6. A second bot needs only a name, and gets its own workspace and transcript.
    const created = await console.call("/api/bots", { name: "Research helper" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const second = created.body.bot;
    assert.ok(!second.conversationId.startsWith("pending:"));
    assert.notEqual(second.conversationId, first.conversationId);
    assert.notEqual(second.provisioning.workspace, first.provisioning.workspace);
    assert.ok(["ready", "degraded"].includes(second.provisioning.state));

    // 7. Integration authorization records a pending request; it never claims a connection.
    const integrations = await console.call("/api/integrations");
    assert.equal(integrations.status, 200);
    assert.equal(integrations.body.integrations.length, 5);
    assert.ok(integrations.body.integrations.every((entry: { state: string }) => entry.state === "disconnected"));
    assert.ok(integrations.body.integrations.every((entry: { authorization: { implemented: boolean } }) => entry.authorization.implemented === false));

    const requested = await console.call("/api/integrations/github/authorization-requests", {});
    assert.equal(requested.status, 202);
    assert.equal(requested.body.state, "authorization_pending");
    assert.equal(requested.body.connected, false);
    assert.equal(requested.body.implementation, "not_implemented");
    assert.ok(requested.body.requestId.startsWith("integration:github:"));
    const after = await console.call("/api/integrations");
    assert.equal(after.body.integrations.find((entry: { service: string }) => entry.service === "github").state, "authorization_pending");
    assert.ok(after.body.integrations.every((entry: { state: string }) => entry.state !== "connected"));
    assert.equal((await console.call("/api/integrations/twitter/authorization-requests", {})).status, 400);

    const conversationBefore = second.conversationId;
    const workspaceBefore = second.provisioning.workspace;
    await service.close();
    service = undefined;

    // 8. Restart recovery: durable state is re-verified against a fresh runtime, one workspace
    //    and one transcript per bot. The integration request survives too.
    service = await startService({ env, models: scriptedProvider(), log: () => {} });
    const restarted = consoleOf(service);
    const restored = await restarted.call("/api/bots");
    assert.equal(restored.status, 200);
    assert.equal(restored.body.bots.length, 2);
    const restoredSecond = restored.body.bots.find((bot: { botId: string }) => bot.botId === second.botId);
    assert.equal(restoredSecond.conversationId, conversationBefore);
    assert.equal(restoredSecond.provisioning.workspace, workspaceBefore);
    assert.ok(["ready", "degraded"].includes(restoredSecond.provisioning.state));
    assert.equal(restoredSecond.provisioning.error, null);
    assert.equal((await restarted.call("/api/platform")).body.fingerprint, platform.body.fingerprint);
    const persisted = await restarted.call("/api/integrations");
    assert.equal(persisted.body.integrations.find((entry: { service: string }) => entry.service === "github").state, "authorization_pending");

    // The workspace directories are deterministic: no duplicate subtree was allocated.
    const entries = await readdir(join(directory, "workspaces"));
    assert.deepEqual([...entries].sort(), [second.botId].sort());
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the console still requires its token for every zero-setup route", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-zero-setup-auth-"));
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const port = service.console?.port;
    assert.ok(port !== undefined);
    for (const path of ["/", "/api/bots", "/api/platform", "/api/integrations"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401, path);
    }
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
