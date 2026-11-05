import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, configureEnvProxy, readConfig } from "./config.js";
import { StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { ReminderScheduler, ReminderStore } from "./reminders.js";
import { failureCode, serveTelegram, TelegramClient } from "./telegram.js";
import { startTrace, type TraceRuntime } from "./trace.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

let trace: TraceRuntime | undefined;
try {
  configureEnvProxy();
  const config = readConfig();
  // Tracing is auxiliary: absent keys or an exporter failure must not stop the bot.
  trace = startTrace(config.trace);
  const client = new TelegramClient(config.token, config.telegramApiRoot);
  const botId = await client.identity(shutdown.signal);
  await mkdir(config.dataDir, { recursive: true });
  let inbox: Inbox | undefined;
  let reminders: ReminderStore | undefined;
  try {
    // Reminder state is separate from the Inbox: its lifecycle is a due time, not a user request.
    reminders = config.reminders === undefined
      ? undefined
      : new ReminderStore(join(config.dataDir, "reminders.sqlite"), { limits: config.reminders });
    inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
    inbox.bindIdentity(botId, config.ownerId);
    inbox.recover();
    // A sending row may already have reached Telegram; recovery records it as uncertain instead of resending.
    reminders?.recover();
    const agent = await openAgent(config, undefined, undefined, {
      signal: shutdown.signal,
      ...(reminders === undefined ? {} : { reminderStore: reminders }),
    });
    const scheduler = reminders === undefined ? undefined : new ReminderScheduler({
      store: reminders,
      client,
      signal: shutdown.signal,
      log: (line) => console.error(line),
    });
    scheduler?.start();
    try {
      console.info("Personal agent starting; single-owner private Telegram messages enabled.");
      await serveTelegram(config, botId, inbox, agent.reply, shutdown.signal, client);
    } finally {
      // Stop proactive sends before the agent and databases close; an in-flight send becomes uncertain.
      await scheduler?.stop();
      await agent.close();
    }
  } finally {
    inbox?.close();
    reminders?.close();
  }
} catch (error) {
  if (!shutdown.signal.aborted) {
    // SDK error objects can contain credentials and message content, so only messages this
    // application wrote are logged verbatim.
    console.error("Personal agent stopped:",
      error instanceof ConfigurationError || error instanceof StateError ? error.message : failureCode(error));
    process.exitCode = 1;
  }
} finally {
  await trace?.close();
}
