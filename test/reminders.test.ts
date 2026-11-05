import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { GrammyError } from "grammy";
import { ConfigurationError, readReminderConfig } from "../src/config.js";
import {
  createReminderExtension,
  ReminderError,
  ReminderScheduler,
  ReminderStore,
  REMINDER_LIMITS,
  type ReminderLimits,
} from "../src/reminders.js";
import { createToolRegistry } from "../src/tools.js";

const context = BACKGROUND_CONTEXT;

function fixedClock(start = "2026-11-05T00:00:00.000Z") {
  const clock = { time: new Date(start) };
  return { clock, now: () => clock.time };
}

async function withStore(run: (store: ReminderStore, directory: string) => Promise<void>, options: { limits?: ReminderLimits; now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aster-reminders-"));
  const store = new ReminderStore(join(directory, "reminders.sqlite"), options);
  try {
    await run(store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function createInput(now: () => Date, overrides: Partial<Parameters<ReminderStore["create"]>[0]> = {}) {
  return {
    chatId: "42",
    ownerId: "42",
    content: "check the PR",
    triggerAt: new Date(now().getTime() + 60_000).toISOString(),
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof ReminderError ? error.code : undefined;
}

/** Run an operation expected to be rejected and return its host error code. */
function rejected(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return code(error);
  }
  assert.fail("expected the operation to be rejected");
}

function lastResult(messages: readonly Message[]) {
  return messages.findLast((message) => message.role === "toolResult");
}

test("reminder config defaults on and validates every bound", () => {
  assert.deepEqual(readReminderConfig({}), { enabled: true, maxPending: 100, maxPerHour: 20, horizonDays: 366 });
  assert.equal(readReminderConfig({ REMINDERS_ENABLED: "0" }).enabled, false);
  assert.equal(readReminderConfig({ REMINDERS_MAX_PENDING: "5", REMINDERS_MAX_PER_HOUR: "3", REMINDERS_MAX_HORIZON_DAYS: "7" }).maxPending, 5);
  assert.throws(() => readReminderConfig({ REMINDERS_ENABLED: "yes" }), (error: unknown) => error instanceof ConfigurationError);
  assert.throws(() => readReminderConfig({ REMINDERS_MAX_PENDING: "0" }), /REMINDERS_MAX_PENDING/);
  assert.throws(() => readReminderConfig({ REMINDERS_MAX_PER_HOUR: "x" }), /REMINDERS_MAX_PER_HOUR/);
  assert.throws(() => readReminderConfig({ REMINDERS_MAX_HORIZON_DAYS: "99999" }), /REMINDERS_MAX_HORIZON_DAYS/);
});

test("create validates content, instant, timezone and idempotency", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const first = store.create(createInput(now, { idempotencyKey: "call-1" }));
    assert.equal(first.created, true);
    assert.equal(first.reminder.status, "pending");
    assert.equal(first.reminder.dueAt, "2026-11-05T00:01:00.000Z");
    assert.equal(first.reminder.timezone, "Asia/Shanghai");

    const replay = store.create(createInput(now, { idempotencyKey: "call-1", content: "different body" }));
    assert.equal(replay.created, false);
    assert.equal(replay.reminder.id, first.reminder.id);
    assert.equal(replay.reminder.content, "check the PR", "replay returns the stored row, not the new arguments");

    assert.equal(rejected(() => store.create(createInput(now, { content: "   " }))), "REMINDER_INVALID_CONTENT");
    assert.equal(rejected(() => store.create(createInput(now, { content: "x".repeat(2_001) }))), "REMINDER_INVALID_CONTENT");
    assert.equal(rejected(() => store.create(createInput(now, { timezone: "Mars/Olympus" }))), "REMINDER_INVALID_TIMEZONE");
    assert.equal(rejected(() => store.create(createInput(now, { triggerAt: "2026-11-05T08:00:00" }))), "REMINDER_TIME_AMBIGUOUS");
    assert.equal(rejected(() => store.create(createInput(now, { triggerAt: "tomorrow" }))), "REMINDER_TIME_INVALID");
    assert.equal(rejected(() => store.create(createInput(now, { triggerAt: new Date(now().getTime() - 1_000).toISOString() }))), "REMINDER_TIME_IN_PAST");
    assert.equal(rejected(() => store.create(createInput(now, {
      triggerAt: new Date(now().getTime() + REMINDER_LIMITS.horizonDays * 86_400_000 + 1_000).toISOString(),
    }))), "REMINDER_TIME_TOO_FAR");
  }, { now });
});

test("active count and hourly creation rate are bounded per conversation", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    store.create(createInput(now));
    store.create(createInput(now));
    assert.equal(rejected(() => store.create(createInput(now))), "REMINDER_LIMIT_EXCEEDED");
  }, { limits: { maxPending: 2, maxPerHour: 100, horizonDays: 30 }, now });
  await withStore(async (store) => {
    store.create(createInput(now));
    store.create(createInput(now));
    assert.equal(rejected(() => store.create(createInput(now))), "REMINDER_RATE_LIMITED");
  }, { limits: { maxPending: 100, maxPerHour: 2, horizonDays: 30 }, now });
});

test("due claiming is conditional, ordered and never repeats a delivery", async () => {
  const { clock, now } = fixedClock();
  await withStore(async (store) => {
    const late = store.create(createInput(now, { content: "late" }));
    const early = store.create(createInput(now, { content: "early", triggerAt: new Date(now().getTime() + 30_000).toISOString() }));
    assert.equal(store.claimDue(now().toISOString()).length, 0, "not due yet");

    clock.time = new Date(now().getTime() + 60_000);
    const claimed = store.claimDue(now().toISOString());
    assert.deepEqual(claimed.map(({ id }) => id), [early.reminder.id, late.reminder.id]);
    assert.deepEqual(claimed.map(({ status }) => status), ["queued", "queued"]);
    assert.equal(store.claimDue(now().toISOString()).length, 2, "leftover queued rows are returned, pending rows are not re-claimed");

    assert.equal(store.beginSend(early.reminder.id), true);
    assert.equal(store.beginSend(early.reminder.id), false, "only the winner may send");
    store.markSent(early.reminder.id, "9001");
    assert.equal(store.claimDue(now().toISOString()).length, 1);
    assert.equal(store.list("42")[0]?.status, "queued");
    assert.equal(store.list("42", { includeFinished: true }).find(({ id }) => id === early.reminder.id)?.messageId, "9001");
  }, { now });
});

test("cancel wins before sending and loses once sending has begun", async () => {
  const { clock, now } = fixedClock();
  await withStore(async (store) => {
    const reminder = store.create(createInput(now)).reminder;
    assert.equal(store.cancel("42", reminder.id).status, "cancelled");
    assert.equal(store.cancel("42", reminder.id).status, "cancelled", "cancel is idempotent");
    const racing = store.create(createInput(now)).reminder;
    clock.time = new Date(now().getTime() + 60_000);
    assert.equal(store.claimDue(now().toISOString()).length, 1, "cancelled rows are never claimed");

    assert.equal(store.beginSend(racing.id), true);
    assert.equal(rejected(() => store.cancel("42", racing.id)), "REMINDER_NOT_CANCELLABLE");
    assert.equal(rejected(() => store.cancel("99", racing.id)), "REMINDER_NOT_FOUND");
  }, { now });
});

test("restart recovery returns unsent rows to pending and marks interrupted sends uncertain", async () => {
  const { clock, now } = fixedClock();
  const directory = await mkdtemp(join(tmpdir(), "aster-reminders-recovery-"));
  try {
    const path = join(directory, "reminders.sqlite");
    const first = new ReminderStore(path, { now });
    const unsent = first.create(createInput(now, { content: "unsent" })).reminder;
    const interrupted = first.create(createInput(now, { content: "interrupted" })).reminder;
    clock.time = new Date(now().getTime() + 60_000);
    first.claimDue(now().toISOString());
    assert.equal(first.beginSend(interrupted.id), true);
    first.close();

    const second = new ReminderStore(path, { now });
    second.recover();
    const rows = second.list("42", { includeFinished: true });
    assert.equal(rows.find(({ id }) => id === unsent.id)?.status, "pending");
    const unknown = rows.find(({ id }) => id === interrupted.id);
    assert.equal(unknown?.status, "uncertain");
    assert.equal(unknown?.failureCode, "PROCESS_INTERRUPTED");

    const sends: string[] = [];
    const scheduler = new ReminderScheduler({ store: second, client: { send: async (_chat, text) => { sends.push(text); return "1"; } }, now });
    await scheduler.runDue();
    assert.deepEqual(sends, ["提醒：unsent"], "an uncertain reminder is never resent automatically");
    assert.equal(second.resolve(interrupted.id, "sent").status, "sent");
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduler sends due reminders in order and records Telegram outcomes", async () => {
  const { clock, now } = fixedClock();
  await withStore(async (store) => {
    store.create(createInput(now, { content: "second", triggerAt: new Date(now().getTime() + 50_000).toISOString() }));
    store.create(createInput(now, { content: "first", triggerAt: new Date(now().getTime() + 20_000).toISOString() }));
    clock.time = new Date(now().getTime() + 60_000);

    const sent: { chatId: string; text: string }[] = [];
    const scheduler = new ReminderScheduler({
      store,
      now,
      log: () => {},
      client: { send: async (chatId, text) => { sent.push({ chatId, text }); return String(7 + sent.length); } },
    });
    assert.equal(await scheduler.runDue(), 2);
    assert.deepEqual(sent, [
      { chatId: "42", text: "提醒：first" },
      { chatId: "42", text: "提醒：second" },
    ]);
    assert.deepEqual(store.listAll().map(({ status }) => status), ["sent", "sent"]);
    assert.equal(await scheduler.runDue(), 0, "a second scan does not resend");
  }, { now });
});

test("cancelled reminders never reach Telegram", async () => {
  const { clock, now } = fixedClock();
  await withStore(async (store) => {
    const reminder = store.create(createInput(now)).reminder;
    store.cancel("42", reminder.id);
    clock.time = new Date(now().getTime() + 60_000);
    let sends = 0;
    const scheduler = new ReminderScheduler({ store, now, log: () => {}, client: { send: async () => { sends++; return "1"; } } });
    await scheduler.runDue();
    assert.equal(sends, 0);
  }, { now });
});

test("explicit Telegram rejection is failed while transport failure is uncertain", async () => {
  const { clock, now } = fixedClock();
  await withStore(async (store) => {
    store.create(createInput(now, { content: "rejected" }));
    store.create(createInput(now, { content: "timeout" }));
    clock.time = new Date(now().getTime() + 60_000);
    let calls = 0;
    const scheduler = new ReminderScheduler({
      store,
      now,
      log: () => {},
      client: {
        send: async () => {
          calls += 1;
          if (calls === 1) throw new GrammyError("rejected", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {});
          throw Object.assign(new Error("socket closed"), { name: "TimeoutError" });
        },
      },
    });
    assert.equal(await scheduler.runDue(), 0);
    const rows = store.listAll();
    const rejectedRow = rows.find(({ content }) => content === "rejected");
    const timeoutRow = rows.find(({ content }) => content === "timeout");
    assert.equal(rejectedRow?.status, "failed");
    assert.equal(rejectedRow?.failureCode, "TELEGRAM_400");
    assert.equal(timeoutRow?.status, "uncertain");
    assert.equal(timeoutRow?.failureCode, "TIMEOUT");
  }, { now });
});

test("reminder tools persist the stored row and cannot choose another chat", async () => {
  const { clock, now } = fixedClock();
  await withStore(async (store) => {
    const extension = createReminderExtension(store, { chatId: "42" });
    const registry = createToolRegistry([extension], { log: () => {} });
    assert.equal(registry.lookup("reminder_create")?.authz, "write");
    assert.equal(registry.lookup("reminder_cancel")?.authz, "write");
    assert.equal(registry.lookup("reminder_list")?.authz, "read");

    const faux = fauxProvider({ provider: "faux" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("reminder_create", {
        content: "check the PR",
        trigger_at: new Date(now().getTime() + 60_000).toISOString(),
        timezone: "Asia/Shanghai",
      }), { stopReason: "toolUse" }),
      (transcript) => {
        const result = lastResult(transcript.messages);
        assert.equal(result?.isError, false);
        assert.match(JSON.stringify(result?.content), /Reminder #1 stored for 2026-11-05T00:01:00\.000Z/);
        return fauxAssistantMessage("Reminder set.");
      },
      fauxAssistantMessage(fauxToolCall("reminder_create", {
        content: "wrong target",
        trigger_at: new Date(now().getTime() + 120_000).toISOString(),
        timezone: "Asia/Shanghai",
        chat_id: "999",
      }), { stopReason: "toolUse" }),
      (transcript) => {
        assert.match(JSON.stringify(lastResult(transcript.messages)?.content), /chat_id/);
        return fauxAssistantMessage("Invalid arguments rejected.");
      },
    ]);
    const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
    try {
      const root = await harness.root(context);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      assert.equal((await (await root.submit({ type: "input", content: "remind me" }, context)).wait(context)).status, "done");
      const stored = store.list("42");
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.content, "check the PR");
      assert.equal(stored[0]?.chatId, "42");
      assert.equal(clock.time.toISOString(), "2026-11-05T00:00:00.000Z", "tests drive time explicitly");
    } finally {
      await harness.close(context);
    }
  }, { now });
});

test("restricted authority can list reminders but not create or cancel them", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const registry = createToolRegistry([createReminderExtension(store, { chatId: "42" })], { authority: "restricted", log: () => {} });
    const faux = fauxProvider({ provider: "faux" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("reminder_create", {
        content: "blocked",
        trigger_at: new Date(now().getTime() + 60_000).toISOString(),
        timezone: "Asia/Shanghai",
      }), { stopReason: "toolUse" }),
      (transcript) => {
        const result = lastResult(transcript.messages);
        assert.equal(result?.isError, true);
        assert.equal((result?.details as { code?: string }).code, "TOOL_AUTHZ_DENIED");
        return fauxAssistantMessage("Denied.");
      },
    ]);
    const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
    try {
      const root = await harness.root(context);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      await (await root.submit({ type: "input", content: "try creating" }, context)).wait(context);
      assert.equal(store.listAll().length, 0);
    } finally {
      await harness.close(context);
    }
  }, { now });
});
