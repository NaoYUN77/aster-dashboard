import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionFailed } from "@earendil-works/pi-durable";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { Inbox } from "../src/inbox.js";
import { StateError } from "../src/errors.js";
import { readConfig } from "../src/config.js";
import { createProviderModels, PROVIDERS, requireModel } from "../src/providers.js";
import { splitReply } from "../src/messages.js";
import { serveTelegram, toRequest } from "../src/telegram.js";

const update: Update = {
  update_id: 12,
  message: {
    message_id: 7, date: 1, text: "hello",
    chat: { id: 42, type: "private", first_name: "Owner" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
  },
};
const request = toRequest(update, "42", "99")!;

test("Telegram boundary admits only owner private text and namespaces identifiers", () => {
  assert.deepEqual(request, {
    requestId: "telegram:99:12", conversationId: "42", senderId: "42", text: "hello",
  });
  assert.equal(toRequest(update, "43", "99"), undefined);
  assert.equal(toRequest({ ...update, message: { ...update.message!, chat: { id: -1, type: "group", title: "Group" } } }, "42", "99"), undefined);
  assert.notEqual(toRequest(update, "42", "100")!.requestId, request.requestId);
});

test("reply chunking preserves text including Unicode surrogate pairs", () => {
  const text = "你".repeat(3999) + "😀" + "a".repeat(8000);
  const chunks = splitReply(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
});

test("inbox rejects identity and request-content conflicts without advancing offset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inbox-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.bindIdentity("99", "42");
    // Operator-facing: the startup log prints this message instead of a generic failure code.
    assert.throws(() => inbox.bindIdentity("100", "42"), StateError);
    assert.throws(() => inbox.bindIdentity("99", "43"), StateError);
    inbox.accept(13, request);
    inbox.accept(13, request);
    assert.throws(() => inbox.accept(14, { ...request, text: "different" }));
    assert.equal(inbox.offset, 13);
    // Telegram may reset the update sequence after a week without updates.
    inbox.accept(2);
    assert.equal(inbox.offset, 2);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart preserves confirmed segments and quarantines only the interrupted send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inbox-"));
  const path = join(directory, "inbox.sqlite");
  let inbox = new Inbox(path);
  try {
    inbox.accept(13, request);
    inbox.saveReply(request.requestId, "a".repeat(8001));
    inbox.beginPart(request.requestId, 0);
    inbox.confirmPart(request.requestId, 0, "101");
    inbox.beginPart(request.requestId, 1);
    inbox.close();
    inbox = new Inbox(path);
    inbox.recover();
    assert.equal(inbox.offset, 13);
    assert.equal(inbox.next(), undefined);
    assert.equal(inbox.blocked()[0]?.part, 1);
    assert.equal(inbox.nextPart(request.requestId)?.part, 2);
    inbox.resolvePart(request.requestId, 1, "retry");
    assert.equal(inbox.nextPart(request.requestId)?.part, 1);
    inbox.beginPart(request.requestId, 1);
    inbox.confirmPart(request.requestId, 1, "102");
    inbox.beginPart(request.requestId, 2);
    inbox.confirmPart(request.requestId, 2, "103");
    assert.equal(inbox.next(), undefined);
    assert.equal(inbox.blocked().length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciling partial delivery sends stored remainder without rerunning agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-delivery-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  let executions = 0;
  const firstShutdown = new AbortController();
  const sent: string[] = [];
  try {
    inbox.accept(13, request);
    await serveTelegram(config, "99", inbox, async () => { executions++; return "a".repeat(4000) + "remaining"; }, firstShutdown.signal, {
      send: async (_chat, text) => {
        if (sent.length === 1) throw new Error("lost response");
        sent.push(text);
        return "101";
      },
      updates: async () => { firstShutdown.abort(); return []; },
    });
    assert.equal(executions, 1);
    assert.equal(inbox.blocked()[0]?.part, 1);
    inbox.resolvePart(request.requestId, 1, "retry");
    const secondShutdown = new AbortController();
    await serveTelegram(config, "99", inbox, async () => { throw new Error("must not rerun"); }, secondShutdown.signal, {
      send: async (_chat, text) => { sent.push(text); return "102"; },
      updates: async () => { secondShutdown.abort(); return []; },
    });
    assert.deepEqual(sent, ["a".repeat(4000), "remaining"]);
    assert.equal(executions, 1);
    assert.equal(inbox.blocked().length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inbox keeps identical text under different request IDs as separate requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-duplicate-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    inbox.accept(2, { ...request, requestId: "telegram:99:2" });
    const first = inbox.next();
    inbox.saveReply(first!.requestId, "first");
    inbox.beginPart(first!.requestId, 0);
    inbox.confirmPart(first!.requestId, 0, "1");
    assert.equal(inbox.next()?.requestId, "telegram:99:2");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration failures name the missing or invalid setting", () => {
  assert.throws(() => readConfig({}), /Missing configuration: TELEGRAM_OWNER_ID/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "not-a-number" }), /positive numeric user ID/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "42" }), /Missing configuration: MODEL_PROVIDER/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "other" }), /MODEL_PROVIDER must be one of: anthropic, openai/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "openai" }), /Missing configuration: OPENAI_API_KEY/);
  assert.throws(() => readConfig({
    TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key",
  }), /Missing configuration: TELEGRAM_BOT_TOKEN/);
});

test("the provider registry only names providers shipped with pi-ai", () => {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  for (const [id, entry] of Object.entries(PROVIDERS)) {
    assert.ok(builtin.has(id), `registered provider ${id} is not built into pi-ai`);
    assert.match(entry.apiKeyEnv, /^[A-Z0-9_]+_API_KEY$/, `${id} must name an API-key variable`);
  }
});

test("a registered provider requires only its own API key", () => {
  const config = readConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_OWNER_ID: "42",
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash",
    DEEPSEEK_API_KEY: "secret",
  });
  assert.equal(config.provider, "deepseek");
  assert.equal(config.webApiKey, undefined);
  assert.equal(readConfig({
    TELEGRAM_BOT_TOKEN: "token", TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "secret", DEEPSEEK_WEB_API_KEY: " web-secret ",
  }).webApiKey, "web-secret");
  assert.throws(() => readConfig({
    TELEGRAM_BOT_TOKEN: "token", TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash",
  }), /Missing configuration: DEEPSEEK_API_KEY/);
});

test("an unknown model id is rejected with provider examples", () => {
  assert.throws(
    () => requireModel(createProviderModels("deepseek"), "deepseek", "not-a-model"),
    /Unknown MODEL_ID "not-a-model" for MODEL_PROVIDER=deepseek; examples: /,
  );
});

test("oversized input is refused explicitly instead of being silently dropped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-input-limit-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  try {
    inbox.accept(1, { ...request, text: "x".repeat(16_001) });
    const shutdown = new AbortController();
    const sent: string[] = [];
    let executions = 0;
    await serveTelegram(config, "99", inbox, async () => { executions++; return "must not run"; }, shutdown.signal, {
      send: async (_chat, text) => { sent.push(text); return "1"; },
      updates: async () => { shutdown.abort(); return []; },
    });
    assert.equal(executions, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /消息过长/);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual confirmation marks only the named segment sent and continues with later parts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-confirm-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(13, request);
    inbox.saveReply(request.requestId, "a".repeat(4001) + "b".repeat(4001) + "tail");
    inbox.beginPart(request.requestId, 0);
    inbox.confirmPart(request.requestId, 0, "101");
    inbox.beginPart(request.requestId, 1);
    inbox.failPart(request.requestId, 1, "uncertain", "TIMEOUT");
    inbox.resolvePart(request.requestId, 1, "sent");
    assert.equal(inbox.nextPart(request.requestId)?.part, 2);
    assert.equal(inbox.next()?.status, "ready", "the request stays ready for the remaining part, not pending");
    assert.equal(inbox.blocked().length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inbox timestamps record when a request arrived, was answered, and was last attempted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-timestamps-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(1, request);
    const received = inbox.next();
    assert.ok(received?.receivedAt, "receivedAt is set when the request is accepted");
    assert.equal(received.repliedAt, null);
    assert.ok(!Number.isNaN(Date.parse(received.receivedAt!)));

    inbox.saveReply(request.requestId, "hello back");
    const replied = inbox.next();
    assert.equal(replied?.repliedAt?.startsWith(received.receivedAt!.slice(0, 10)), true);
    assert.ok(Date.parse(replied.repliedAt!) >= Date.parse(received.receivedAt!));

    const part = inbox.nextPart(request.requestId);
    assert.ok(part?.createdAt, "delivery parts carry their creation time");
    assert.ok(part.updatedAt);
    inbox.beginPart(request.requestId, 0);
    const sending = inbox.nextPart(request.requestId);
    assert.equal(sending, undefined, "beginPart moved the part out of pending");
    inbox.failPart(request.requestId, 0, "failed", "TELEGRAM_400");
    const [blocked] = inbox.blocked() as { receivedAt: string; updatedAt: string }[];
    assert.ok(blocked?.updatedAt, "the attempt time survives on a blocked delivery");
    assert.ok(Date.parse(blocked.updatedAt) >= Date.parse(part.updatedAt!));
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a database written before timestamps keeps the old rows unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-migrate-"));
  const path = join(directory, "inbox.sqlite");
  // The schema as shipped before timestamps existed, including one already-delivered request.
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL);
    INSERT INTO checkpoint VALUES (1, 5);
    CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK (id = 1), botId TEXT NOT NULL, ownerId TEXT NOT NULL);
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
  let current: Inbox | undefined = inbox;
  try {
    // Migration must not invent a time for a row the process never saw arrive.
    assert.equal(inbox.offset, 5);
    inbox.accept(6, { ...request, requestId: "telegram:99:5" });
    const rows = new DatabaseSync(path);
    try {
      assert.equal(rows.prepare("SELECT receivedAt FROM inbox WHERE requestId = ?").get("telegram:99:4")?.["receivedAt"], null);
      assert.equal(rows.prepare("SELECT createdAt FROM deliveries WHERE requestId = ?").get("telegram:99:4")?.["createdAt"], null);
      assert.ok(rows.prepare("SELECT receivedAt FROM inbox WHERE requestId = ?").get("telegram:99:5")?.["receivedAt"]);
    } finally {
      rows.close();
    }
    // Reopening an already-migrated database must stay a no-op.
    inbox.close();
    current = new Inbox(path);
    assert.equal(current.offset, 6);
  } finally {
    current?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("prune retains the newest 100 sent requests and every unfinished request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-prune-"));
  const path = join(directory, "inbox.sqlite");
  const inbox = new Inbox(path);
  try {
    // 120 completed requests: the oldest 20 must be pruned, including their deliveries and diagnostics.
    for (let index = 0; index < 120; index++) {
      const id = `telegram:99:${1000 + index}`;
      inbox.accept(1000 + index, { ...request, requestId: id });
      inbox.saveReply(id, `reply ${index}`, index === 0 ? "TEST_FAILURE" : undefined);
      inbox.beginPart(id, 0);
      inbox.confirmPart(id, 0, String(index));
    }
    const unfinished = ["telegram:99:5000", "telegram:99:5001", "telegram:99:5002", "telegram:99:5003"];
    inbox.accept(5000, { ...request, requestId: unfinished[0]! }); // pending
    inbox.accept(5001, { ...request, requestId: unfinished[1]! });
    inbox.saveReply(unfinished[1]!, "ready"); // ready, not yet sent
    inbox.accept(5002, { ...request, requestId: unfinished[2]! });
    inbox.saveReply(unfinished[2]!, "failed"); // explicit failure
    inbox.beginPart(unfinished[2]!, 0);
    inbox.failPart(unfinished[2]!, 0, "failed", "TELEGRAM_403");
    inbox.accept(5003, { ...request, requestId: unfinished[3]! });
    inbox.saveReply(unfinished[3]!, "uncertain"); // unknown outcome
    inbox.beginPart(unfinished[3]!, 0);
    inbox.failPart(unfinished[3]!, 0, "uncertain", "TIMEOUT");

    inbox.prune();

    const db = new DatabaseSync(path);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE status = 'sent'").get() as { count: number }).count, 100);
      assert.equal(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get("telegram:99:1000"), undefined);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE requestId = ?").get("telegram:99:1000")?.["count"], 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM failures WHERE requestId = ?").get("telegram:99:1000")?.["count"], 0);
      assert.ok(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get("telegram:99:1020"));
      for (const id of ["telegram:99:5000", "telegram:99:5001", "telegram:99:5002", "telegram:99:5003"])
        assert.ok(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get(id), `unfinished request ${id} must survive`);
    } finally {
      db.close();
    }

    assert.equal(inbox.diagnostics().some((row) => row.code === "TEST_FAILURE"), false);
    assert.deepEqual(inbox.blocked().map((row) => row.requestId), [unfinished[2], unfinished[3]]);
    assert.equal(inbox.next()?.requestId, unfinished[0]);
    inbox.saveReply(unfinished[0]!, "pending done");
    inbox.beginPart(unfinished[0]!, 0);
    inbox.confirmPart(unfinished[0]!, 0, "5000");
    assert.equal(inbox.next()?.requestId, unfinished[1]);
  } finally {
    inbox.close();
  }
  await rm(directory, { recursive: true, force: true });
});

test("Telegram rejection is failed while a transport failure is uncertain, and neither resends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-send-errors-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  try {
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    inbox.accept(2, { ...request, requestId: "telegram:99:2" });
    inbox.accept(3, { ...request, requestId: "telegram:99:3" });
    const shutdown = new AbortController();
    let executions = 0;
    let sends = 0;
    await serveTelegram(config, "99", inbox, async (job) => {
      executions++;
      return `reply ${job.requestId}`;
    }, shutdown.signal, {
      send: async () => {
        sends++;
        if (sends === 1) throw new GrammyError("rejected", { ok: false, error_code: 403, description: "bot was blocked" }, "sendMessage", {});
        if (sends === 2) throw new Error("socket hang up");
        return "103";
      },
      updates: async () => { shutdown.abort(); return []; },
    });
    assert.equal(executions, 3, "a blocked delivery must not stop later independent requests");
    const rows = inbox.blocked();
    assert.deepEqual(rows.map((row) => [row.requestId, row.status, row.error]), [
      ["telegram:99:1", "failed", "TELEGRAM_403"],
      ["telegram:99:2", "uncertain", "EXECUTION_ERROR"],
    ]);
    assert.equal(sends, 3, "blocked parts are not retried automatically");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a truncated agent answer is delivered with an explicit incompleteness notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-truncated-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  try {
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    const sent: string[] = [];
    const shutdown = new AbortController();
    await serveTelegram(config, "99", inbox, async () => {
      throw Object.assign(new Error("Agent reply was truncated"), { code: "AGENT_TRUNCATED", partialReply: "partial answer" });
    }, shutdown.signal, {
      updates: async () => { shutdown.abort(); return []; },
      send: async (_chat, text) => { sent.push(text); return "1"; },
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /partial answer/);
    assert.match(sent[0]!, /截断/);
    assert.deepEqual(inbox.diagnostics().map((row) => [row.requestId, row.code]), [["telegram:99:1", "AGENT_TRUNCATED"]]);
    const db = new DatabaseSync(join(directory, "inbox.sqlite"));
    try {
      assert.match(String(db.prepare("SELECT reply FROM inbox WHERE requestId = ?").get("telegram:99:1")?.["reply"]), /截断/);
    } finally {
      db.close();
    }
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed Telegram updates are rejected at the boundary", () => {
  const message = update.message!;
  const malformed = (candidate: unknown) => toRequest(candidate as Update, "42", "99");
  assert.equal(malformed({ message }), undefined, "a missing update_id cannot form a request id");
  assert.equal(malformed({ ...update, update_id: "12" }), undefined);
  assert.equal(malformed({ ...update, message: { ...message, chat: { type: "private" } } }), undefined);
  assert.equal(malformed({ ...update, message: { ...message, from: undefined } }), undefined);
  assert.equal(malformed({ ...update, message: { ...message, text: { toString: () => "hello" } } }), undefined);
  assert.equal(malformed({ ...update, message: { ...message, text: "" } }), undefined);
  const stringIds = { ...update, message: { ...message, chat: { ...message.chat, id: "42" }, from: { ...message.from!, id: "42" } } };
  assert.equal(malformed(stringIds)?.conversationId, "42", "numeric strings are normalized");
  assert.equal(malformed(stringIds)?.senderId, "42");
});

test("invalid updates are skipped without writing an unusable checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-invalid-update-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  try {
    const sent: string[] = [];
    const shutdown = new AbortController();
    let polls = 0;
    await serveTelegram(config, "99", inbox, async () => "answer", shutdown.signal, {
      updates: async () => {
        polls++;
        if (polls > 1) {
          shutdown.abort();
          return [];
        }
        return [
          { message: update.message } as unknown as Update,
          { ...update, update_id: 19 },
          { ...update, update_id: 20, message: { ...update.message!, text: { bad: true } } } as unknown as Update,
          // A well-formed update from someone other than the owner: skipped, but its id still advances the offset.
          { ...update, update_id: 21, message: { ...update.message!, from: { ...update.message!.from!, id: 7 } } } as unknown as Update,
        ];
      },
      send: async (_chat, text) => { sent.push(text); return "1"; },
    });
    assert.equal(inbox.offset, 22, "only valid update ids advance the checkpoint");
    assert.deepEqual(sent, ["answer"], "the well-formed owner message is still processed");

    const empty = new Inbox(join(directory, "empty.sqlite"));
    try {
      let polls = 0;
      const stop = new AbortController();
      await serveTelegram(config, "99", empty, async () => "unused", stop.signal, {
        updates: async () => {
          polls++;
          if (polls === 1) return [{ message: update.message } as unknown as Update];
          stop.abort();
          return [];
        },
        send: async () => "1",
      });
      assert.equal(polls, 2, "an invalid update must not stall the poll loop");
      assert.equal(empty.offset, 0, "the checkpoint never receives an invalid id");
      assert.equal(empty.next(), undefined);
    } finally {
      empty.close();
    }
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed agent session stops polling and leaves the request pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-session-failure-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  try {
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    const fatal = Object.assign(
      new Error("Agent session failed; restart the process to recover"),
      { code: "AGENT_SESSION_FAILED", cause: new SessionFailed(new Error("simulated storage failure")) },
    );
    let sends = 0;
    await assert.rejects(
      serveTelegram(config, "99", inbox, async () => { throw fatal; }, new AbortController().signal, {
        updates: async () => { throw new Error("must not keep polling after a fatal error"); },
        send: async () => { sends++; return "1"; },
      }),
      (error: unknown) => error === fatal,
    );
    assert.equal(sends, 0, "a fatal error must not produce a delivery");
    assert.equal(inbox.next()?.status, "pending", "the request stays available for recovery");
    assert.equal(inbox.blocked().length, 0);
    const db = new DatabaseSync(join(directory, "inbox.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deliveries").get()?.["count"], 0);
    } finally {
      db.close();
    }
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a local storage failure while saving a reply is fatal", async () => {
  const inbox = {
    blocked: () => [],
    next: () => ({ ...request, requestId: "telegram:99:1", status: "pending", reply: null }),
    saveReply: () => { throw new Error("database is locked"); },
  } as unknown as Inbox;
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: "unused", mcpConfigPath: "unused/mcp.json", mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  await assert.rejects(
    serveTelegram(config, "99", inbox, async () => "reply", new AbortController().signal, {
      updates: async () => [],
      send: async () => "1",
    }),
    /database is locked/,
  );
});

test("a model failure is delivered as a notice and later requests still run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-model-failure-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config: ReturnType<typeof readConfig> = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } };
  try {
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    inbox.accept(2, { ...request, requestId: "telegram:99:2" });
    const sent: string[] = [];
    const shutdown = new AbortController();
    await serveTelegram(config, "99", inbox, async (job) => {
      if (job.requestId === "telegram:99:1") throw Object.assign(new Error("model failed"), { code: "AGENT_UNANSWERED" });
      return "second answer";
    }, shutdown.signal, {
      updates: async () => { shutdown.abort(); return []; },
      send: async (_chat, text) => { sent.push(text); return String(sent.length); },
    });
    assert.equal(sent.length, 2);
    assert.match(sent[0]!, /未能完成/);
    assert.equal(sent[1], "second answer");
    assert.deepEqual(inbox.diagnostics().map((row) => [row.requestId, row.code]), [["telegram:99:1", "AGENT_UNANSWERED"]]);
    assert.equal(inbox.next(), undefined);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});
