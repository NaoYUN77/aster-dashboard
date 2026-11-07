import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Inbox, consoleRequestBot, consoleRequestPrefix, isBotId, parseBotTools } from "../src/inbox.js";
import { parseCatalogProfile } from "../src/tool-catalog.js";
import { StateError } from "../src/errors.js";
import { readConfig } from "../src/config.js";
import { createProviderModels, PROVIDERS, requireModel } from "../src/providers.js";
import { splitReply } from "../src/messages.js";
import type { TextRequest } from "../src/messages.js";

// Frozen historical expectations, independent of current bootstrap defaults and migration code.
// Retired PTC/reminders keys stay present but off: the migration always writes them as false.
const migratedBase = {
  core: true, shell: true, files: true, web: false, ptc: false,
  memory: true, reminders: false, mcp: true,
};

/** A well-formed console request. The id suffix must be 8-64 URL-safe characters. */
function consoleRequest(botId: string, id: string, text = "hello"): TextRequest {
  return { requestId: `console:${botId}:${id}`, conversationId: botId, senderId: "console", text };
}

function assertNoLegacyColumn(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    assert.ok(raw.prepare("PRAGMA table_info(bots)").all().every((column) => (column as { name: string }).name !== "role"));
  } finally { raw.close(); }
}

test("legacy bot rows convert to switches and physically drop the old column", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-bot-profile-migration-"));
  const path = join(directory, "inbox.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE bots (
    botId TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, conversationId TEXT NOT NULL UNIQUE,
    systemPrompt TEXT NOT NULL, tools TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', createdAt TEXT NOT NULL
  );`);
  const insert = legacy.prepare("INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?, 'active', ?)");
  for (const role of ["assistant", "researcher", "programmer"]) {
    insert.run(role, role, role, role, "kept prompt", "bash,files", "2026-11-06T00:00:00.000Z");
  }
  legacy.close();
  let inbox: Inbox | undefined;
  try {
    inbox = new Inbox(path);
    assert.deepEqual(inbox.bot("assistant")?.profile, migratedBase);
    assert.deepEqual(inbox.bot("researcher")?.profile, { ...migratedBase, web: true });
    // "programmer" no longer grants the retired PTC group; it maps to the base profile.
    assert.deepEqual(inbox.bot("programmer")?.profile, migratedBase);
    for (const bot of inbox.bots()) {
      assert.equal(Object.hasOwn(bot, "role"), false);
      assert.equal(bot.toolScope, '{"allow":[],"deny":[]}');
    }
    assertNoLegacyColumn(path);
  } finally {
    inbox?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored profiles take precedence and survive reopening after the old column is removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-bot-switch-migration-"));
  const path = join(directory, "inbox.sqlite");
  const custom = parseCatalogProfile({ ...migratedBase, shell: false, web: true, ptc: true, mcp: false });
  const scope = { allow: ["web_search"], deny: ["web_fetch"] };
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE bots (
    botId TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, conversationId TEXT NOT NULL UNIQUE,
    systemPrompt TEXT NOT NULL, tools TEXT NOT NULL, profile TEXT, toolScope TEXT,
    status TEXT NOT NULL DEFAULT 'active', createdAt TEXT NOT NULL
  );`);
  const insert = legacy.prepare("INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)");
  for (const [id, profile] of [["chief", "chief"], ["research", "research"], ["programmer", "programmer"], ["custom", JSON.stringify(custom)]]) {
    // A valid stored profile must not depend on the obsolete column, even if it is invalid.
    insert.run(id!, id!, id === "custom" ? "obsolete-invalid" : "assistant", id!, "kept prompt", "bash,files", profile!, JSON.stringify(scope), "2026-11-06T00:00:00.000Z");
  }
  legacy.close();
  let inbox: Inbox | undefined;
  try {
    for (let reopen = 0; reopen < 2; reopen++) {
      inbox = new Inbox(path);
      assert.deepEqual(inbox.bot("chief")?.profile, migratedBase);
      assert.deepEqual(inbox.bot("research")?.profile, { ...migratedBase, web: true });
      assert.deepEqual(inbox.bot("programmer")?.profile, migratedBase);
      assert.deepEqual(inbox.bot("custom")?.profile, custom);
      for (const bot of inbox.bots()) {
        assert.equal(Object.hasOwn(bot, "role"), false);
        assert.equal(bot.tools, "bash,files");
        assert.equal(bot.systemPrompt, "kept prompt");
        assert.equal(bot.conversationId, bot.botId);
        assert.deepEqual(JSON.parse(bot.toolScope), scope);
        assert.equal(bot.createdAt, "2026-11-06T00:00:00.000Z");
      }
      assertNoLegacyColumn(path);
      inbox.close(); inbox = undefined;
    }
    const raw = new DatabaseSync(path);
    assert.equal((raw.prepare("SELECT profile FROM bots WHERE botId = 'custom'").get() as { profile: string }).profile, JSON.stringify(custom));
    raw.prepare("UPDATE bots SET profile = ? WHERE botId = 'custom'").run('{"shell":"yes"}');
    raw.close();
    inbox = new Inbox(path);
    assert.throws(() => inbox!.bot("custom"), /must be a boolean/);
  } finally {
    inbox?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid legacy data rolls back earlier conversions and retains the old column for repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-bot-migration-rollback-"));
  try {
    for (const [index, bad] of [
      { role: "unknown", profile: null, scope: null },
      { role: "assistant", profile: '{"shell":"yes"}', scope: null },
      { role: "assistant", profile: "chief", scope: '{"allow":42}' },
    ].entries()) {
      const path = join(directory, `${index}.sqlite`);
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE bots (
        botId TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, conversationId TEXT NOT NULL UNIQUE,
        systemPrompt TEXT NOT NULL, tools TEXT NOT NULL, profile TEXT, toolScope TEXT,
        status TEXT NOT NULL DEFAULT 'active', createdAt TEXT NOT NULL
      );`);
      const insert = legacy.prepare("INSERT INTO bots VALUES (?, ?, ?, ?, '', 'bash,files', ?, ?, 'active', '2026-11-06T00:00:00.000Z')");
      insert.run("first", "First", "researcher", "1", null, null);
      insert.run("bad", "Bad", bad.role, "2", bad.profile, bad.scope);
      const before = legacy.prepare("SELECT * FROM bots").all();
      legacy.close();
      assert.throws(() => new Inbox(path), /catalog profile|tool scope/);
      const raw = new DatabaseSync(path);
      try {
        assert.ok(raw.prepare("PRAGMA table_info(bots)").all().some((column) => (column as { name: string }).name === "role"));
        assert.deepEqual(raw.prepare("SELECT * FROM bots").all(), before);
        raw.prepare("UPDATE bots SET profile = ?, toolScope = ? WHERE botId = 'bad'").run(JSON.stringify(migratedBase), '{"allow":[],"deny":[]}');
      } finally { raw.close(); }
      const repaired = new Inbox(path);
      try {
        assert.deepEqual(repaired.bot("first")?.profile, { ...migratedBase, web: true });
        assertNoLegacyColumn(path);
      } finally { repaired.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new databases register bots with required switches and reject obsolete fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-bot-new-schema-"));
  const path = join(directory, "inbox.sqlite");
  const inbox = new Inbox(path);
  const registration = { botId: "new", name: "New", conversationId: "1", systemPrompt: "", tools: "bash,files", profile: migratedBase };
  try {
    assertNoLegacyColumn(path);
    const { profile: _profile, ...missing } = registration;
    assert.throws(() => inbox.createBot(missing as Parameters<Inbox["createBot"]>[0]), /catalog profile/);
    assert.throws(() => inbox.ensureBot({ ...registration, role: "assistant" } as Parameters<Inbox["ensureBot"]>[0]), /unknown fields/);
    assert.throws(() => inbox.createBot({ ...registration, role: "assistant" } as Parameters<Inbox["createBot"]>[0]), /unknown fields/);
    const bot = inbox.createBot(registration);
    assert.equal(Object.hasOwn(bot, "role"), false);
    inbox.setBotCatalog(bot.botId, { ...migratedBase, web: true }, { allow: ["web_search"], deny: [] });
    assert.deepEqual(inbox.bot(bot.botId)?.profile, { ...migratedBase, web: true });
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("console request ids name their bot and are validated at the boundary", () => {
  assert.equal(consoleRequestPrefix("bot-one"), "console:bot-one:");
  assert.throws(() => consoleRequestPrefix("Bad_Id"), StateError);
  assert.equal(consoleRequestBot("console:bot-one:req-00000001"), "bot-one");
  assert.equal(consoleRequestBot("telegram:99:12"), undefined, "a legacy Telegram id is not a console request");
  assert.equal(consoleRequestBot("console:bot-one:short"), undefined, "an id shorter than 8 chars is refused");
  assert.equal(consoleRequestBot("console:BAD:req-00000001"), undefined, "bot ids are lowercase");
});

test("bot tool lists are validated, normalized and keep the retired ptc compatibility value", () => {
  assert.equal(parseBotTools("web,bash,bash"), "bash,web");
  assert.equal(parseBotTools("files, ptc"), "files,ptc");
  assert.throws(() => parseBotTools("bash,unknown"), /Unknown bot tool/);
  assert.throws(() => parseBotTools(42), StateError);
  assert.equal(isBotId("bot-one"), true);
  assert.equal(isBotId("Bad"), false);
  assert.equal(isBotId(""), false);
});

test("the console ingress accepts only console-addressed requests and rejects content conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-console-accept-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    const request = consoleRequest("alpha", "req-00000001");
    inbox.acceptConsole(request);
    inbox.acceptConsole(request); // A duplicate accept is idempotent (INSERT OR IGNORE).
    assert.equal(inbox.pendingForBot("alpha"), 1, "a retry never creates a second request");

    assert.throws(() => inbox.acceptConsole({ ...request, senderId: "telegram" }), StateError);
    assert.throws(() => inbox.acceptConsole({ ...request, requestId: "telegram:99:12" }), StateError);
    assert.throws(() => inbox.acceptConsole({ ...request, text: "different" }), /Request ID reused with different content/);
    assert.throws(() => inbox.acceptConsole({ ...request, conversationId: "other" }), /Request ID reused with different content/);
    assert.equal(inbox.pendingForBot("alpha"), 1, "rejected inputs never add a row");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("each bot has its own ordered console queue and identical text stays separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-console-queue-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.acceptConsole(consoleRequest("alpha", "req-00000001", "same"));
    inbox.acceptConsole(consoleRequest("beta", "req-00000001", "b1"));
    inbox.acceptConsole(consoleRequest("alpha", "req-00000002", "same"));
    assert.equal(inbox.pendingForBot("alpha"), 2, "identical text under distinct ids stays two requests");
    assert.equal(inbox.pendingForBot("beta"), 1);
    assert.equal(inbox.pendingForBot("gamma"), 0);

    const first = inbox.nextForBot("alpha");
    assert.equal(first?.requestId, "console:alpha:req-00000001");
    assert.equal(first?.text, "same");
    assert.equal(first?.status, "pending");
    assert.ok(first?.receivedAt, "a console request records its arrival time");
    assert.equal(first?.repliedAt, null);
    assert.equal(inbox.nextForBot("beta")?.text, "b1", "another bot's queue is independent");

    inbox.saveConsoleReply(first!.requestId, "answer a1");
    assert.equal(inbox.nextForBot("alpha")?.text, "same", "the next request in arrival order follows");
    assert.equal(inbox.pendingForBot("alpha"), 1, "pendingForBot counts the remaining work only");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a console reply is terminal, creates no delivery row and records a failure code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-console-reply-"));
  const path = join(directory, "inbox.sqlite");
  const inbox = new Inbox(path);
  const ok = consoleRequest("alpha", "req-00000001");
  const failed = consoleRequest("alpha", "req-00000002");
  const blank = consoleRequest("alpha", "req-00000003");
  try {
    inbox.acceptConsole(ok);
    inbox.acceptConsole(failed);
    inbox.acceptConsole(blank);
    inbox.saveConsoleReply(ok.requestId, "the answer");
    inbox.saveConsoleReply(failed.requestId, "(no reply)", "AGENT_UNANSWERED");
    inbox.saveConsoleReply(blank.requestId, "   ");

    assert.throws(() => inbox.saveConsoleReply(ok.requestId, "again"), /Reply already saved or request missing/);
    assert.throws(() => inbox.saveConsoleReply("console:alpha:req-99999999", "x"), /Reply already saved or request missing/);
    assert.equal(inbox.nextForBot("alpha"), undefined, "sent requests never return to the queue");
    assert.equal(inbox.pendingForBot("alpha"), 0);

    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare("SELECT requestId, status, reply, receivedAt, repliedAt FROM inbox ORDER BY requestId").all() as
        { requestId: string; status: string; reply: string; receivedAt: string | null; repliedAt: string | null }[];
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.status === "sent" && row.receivedAt && row.repliedAt));
      assert.equal(rows.find((row) => row.requestId === ok.requestId)?.reply, "the answer");
      assert.equal(rows.find((row) => row.requestId === blank.requestId)?.reply, "(no reply)", "an empty reply is explicit");
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count, 0,
        "a console reply is terminal; no external delivery is created");
      const failures = db.prepare("SELECT requestId, code FROM failures").all() as
        { requestId: string; code: string }[];
      assert.deepEqual(failures.map(({ requestId, code }) => ({ requestId, code })), [
        { requestId: failed.requestId, code: "AGENT_UNANSWERED" },
      ]);
    } finally { db.close(); }
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a withdrawn console request is terminal and never executed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-console-cancel-"));
  const path = join(directory, "inbox.sqlite");
  const inbox = new Inbox(path);
  const request = consoleRequest("alpha", "req-00000001");
  try {
    inbox.acceptConsole(request);
    assert.equal(inbox.cancelConsole(request.requestId), true);
    assert.equal(inbox.cancelConsole(request.requestId), false, "cancelling twice is a no-op");
    assert.equal(inbox.nextForBot("alpha"), undefined);
    assert.equal(inbox.pendingForBot("alpha"), 0);
    assert.throws(() => inbox.saveConsoleReply(request.requestId, "too late"), /Reply already saved or request missing/);
    const db = new DatabaseSync(path);
    try {
      assert.equal((db.prepare("SELECT status FROM inbox WHERE requestId = ?").get(request.requestId) as { status: string }).status, "failed");
    } finally { db.close(); }
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a pre-console database preserves legacy rows, tables and unknown timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-migrate-"));
  const path = join(directory, "inbox.sqlite");
  // The schema as shipped before the console existed, including one already-delivered request.
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL);
    INSERT INTO checkpoint VALUES (1, 5);
    CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK (id = 1), botId TEXT NOT NULL, ownerId TEXT NOT NULL);
    INSERT INTO identity VALUES (1, '99', '42');
    CREATE TABLE inbox (requestId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT);
    CREATE TABLE deliveries (requestId TEXT NOT NULL REFERENCES inbox(requestId) ON DELETE CASCADE,
      part INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', messageId TEXT, error TEXT,
      PRIMARY KEY (requestId, part));
    CREATE TABLE failures (requestId TEXT PRIMARY KEY REFERENCES inbox(requestId) ON DELETE CASCADE, code TEXT NOT NULL);
    INSERT INTO inbox VALUES ('telegram:99:4', '42', '42', 'old question', 'sent', 'old answer');
    INSERT INTO deliveries VALUES ('telegram:99:4', 0, 'old answer', 'sent', '77', NULL);
  `);
  legacy.close();

  const inbox = new Inbox(path);
  try {
    const db = new DatabaseSync(path);
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
      for (const name of ["checkpoint", "identity", "inbox", "deliveries", "failures", "bots", "bot_provisioning", "integrations"]) {
        assert.ok(tables.includes(name), `compatibility table ${name} is preserved`);
      }
      // Migration does not invent a time for a row the process never saw arrive, nor rewrite its state.
      const old = db.prepare("SELECT status, reply, receivedAt, repliedAt FROM inbox WHERE requestId = 'telegram:99:4'").get() as
        { status: string; reply: string; receivedAt: string | null; repliedAt: string | null };
      assert.equal(old.status, "sent");
      assert.equal(old.reply, "old answer");
      assert.equal(old.receivedAt, null);
      assert.equal(old.repliedAt, null);
      assert.equal((db.prepare("SELECT createdAt FROM deliveries WHERE requestId = 'telegram:99:4'").get() as { createdAt: string | null }).createdAt, null);
      assert.equal((db.prepare("SELECT offset FROM checkpoint").get() as { offset: number }).offset, 5);
      assert.equal((db.prepare("SELECT ownerId FROM identity").get() as { ownerId: string }).ownerId, "42");
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count, 1);
    } finally { db.close(); }

    assert.equal(inbox.nextForBot("99"), undefined, "a legacy Telegram row is never replayed through a console queue");
    const fresh = consoleRequest("alpha", "req-00000001");
    inbox.acceptConsole(fresh);
    const job = inbox.nextForBot("alpha");
    assert.equal(job?.requestId, fresh.requestId);
    assert.ok(job?.receivedAt, "new console rows get a receivedAt");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reply chunking preserves text including Unicode surrogate pairs", () => {
  const text = "你".repeat(3999) + "😀" + "a".repeat(8000);
  const chunks = splitReply(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
});

test("configuration failures name the missing or invalid setting", () => {
  assert.throws(() => readConfig({}), /Missing configuration: MODEL_PROVIDER/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "other" }), /MODEL_PROVIDER must be one of: anthropic, openai/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "openai" }), /Missing configuration: OPENAI_API_KEY/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "key" }), /Missing configuration: MODEL_ID/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "__vault_bad__", MODEL_ID: "m" }), /malformed vault placeholder/);
  assert.throws(() => readConfig({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed/);
});

test("the provider registry only names providers shipped with pi-ai", () => {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  for (const [id, entry] of Object.entries(PROVIDERS)) {
    assert.ok(builtin.has(id), `registered provider ${id} is not built into pi-ai`);
    assert.match(entry.apiKeyEnv, /^[A-Z0-9_]+_API_KEY$/, `${id} must name an API-key variable`);
  }
});

test("a registered provider requires only its own API key and a model id", () => {
  const config = readConfig({
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash",
    DEEPSEEK_API_KEY: "secret",
  });
  assert.equal(config.provider, "deepseek");
  assert.equal(config.model, "deepseek-flash");
  assert.equal(config.ccrProfile, undefined);
  assert.equal(config.console, undefined, "the console is off unless explicitly enabled");
  assert.equal(readConfig({
    MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "secret",
    DEEPSEEK_WEB_API_KEY: " web-secret ",
  }).ccrProfile, undefined);
  assert.throws(() => readConfig({
    MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash",
  }), /Missing configuration: DEEPSEEK_API_KEY/);
});

test("the console refuses an unauthenticated listener and stays off by default", () => {
  const base = { MODEL_PROVIDER: "openai", OPENAI_API_KEY: "key", MODEL_ID: "m" };
  assert.equal(readConfig(base).console, undefined);
  assert.throws(() => readConfig({ ...base, CONSOLE_ENABLED: "1" }), /WEB_TOKEN must be 16-256/);
  const enabled = readConfig({ ...base, CONSOLE_ENABLED: "1", WEB_TOKEN: "0123456789abcdef" });
  assert.equal(enabled.console?.host, "0.0.0.0");
  assert.equal(enabled.console?.maxBots, 8);
});

test("an unknown model id is rejected with provider examples", () => {
  assert.throws(
    () => requireModel(createProviderModels("deepseek"), "deepseek", "not-a-model"),
    /Unknown MODEL_ID "not-a-model" for MODEL_PROVIDER=deepseek; examples: /,
  );
});
