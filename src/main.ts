// Process composition: configuration, storage, the agent, the bots and the surfaces that read them.
//
// Interface: `startService()` opens everything in dependency order and returns a handle with the
// live objects and `done`, which resolves when the request loop ends and the process has cleaned
// up. `close()` stops the service now. The command-line entry at the bottom of this file is the
// only place that installs process-level signal handlers.
//
// Inputs: the environment (a plain object in tests), an optional offline model registry, an
// external abort signal and a log sink. Nothing else is injectable: every path is derived from
// DATA_DIR, and every model, tool and directory a bot may use is decided by the host.
//
// Errors: a configuration or startup failure rejects before the handle exists, after releasing
// whatever had been opened. A failure of the request loop rejects `done` after cleanup.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Models } from "@earendil-works/pi-ai/models";
import { openAgent } from "./agent.js";
import { BotManager } from "./bot-manager.js";
import { ConfigurationError, configureEnvProxy, readConfig, readMemoryConfig } from "./config.js";
import { startConsole, type ConsoleHandle } from "./console.js";
import { StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { ReminderScheduler, ReminderStore } from "./reminders.js";
import { failureCode, serveTelegram, TelegramClient } from "./telegram.js";
import { startTrace, type TraceRuntime } from "./trace.js";

export type ServiceConfig = ReturnType<typeof readConfig>;
export type OpenServiceAgent = Awaited<ReturnType<typeof openAgent>>;

export type ServiceOptions = {
  readonly env?: NodeJS.ProcessEnv;
  /** Offline model registry for tests; a deployment builds one from its provider configuration. */
  readonly models?: Models;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
};

export type ServiceHandle = {
  readonly config: ServiceConfig;
  readonly agent: OpenServiceAgent;
  readonly bots: BotManager;
  readonly console: ConsoleHandle | undefined;
  /** Resolves once the request loop ended and cleanup finished; rejects if the loop failed. */
  readonly done: Promise<void>;
  close(): Promise<void>;
};

export async function startService(options: ServiceOptions = {}): Promise<ServiceHandle> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.info(line));
  // One controller owns shutdown, so an external signal and close() follow the same path.
  const stop = new AbortController();
  const forward = (): void => stop.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) stop.abort();
    else options.signal.addEventListener("abort", forward, { once: true });
  }
  const signal = stop.signal;

  let trace: TraceRuntime | undefined;
  let inbox: Inbox | undefined;
  let reminderStore: ReminderStore | undefined;
  let agent: OpenServiceAgent | undefined;
  let scheduler: ReminderScheduler | undefined;
  let bots: BotManager | undefined;
  let consoleHandle: ConsoleHandle | undefined;
  let shuttingDown: Promise<void> | undefined;

  /** Release everything in reverse dependency order; safe to call twice and from either path. */
  const shutdown = async (): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    shuttingDown = (async () => {
      stop.abort();
      // The console accepts no new work while the workers and the agent stop.
      await consoleHandle?.close().catch(() => undefined);
      await bots?.close().catch(() => undefined);
      await scheduler?.stop().catch(() => undefined);
      await agent?.close().catch(() => undefined);
      inbox?.close();
      reminderStore?.close();
      options.signal?.removeEventListener("abort", forward);
      await trace?.close().catch(() => undefined);
    })();
    return shuttingDown;
  };

  try {
    configureEnvProxy(env);
    const config = readConfig(env);
    // Tracing is auxiliary: absent keys or an exporter failure must not stop the bot.
    trace = startTrace(config.trace);
    await mkdir(config.dataDir, { recursive: true });
    reminderStore = config.reminders === undefined
      ? undefined
      : new ReminderStore(join(config.dataDir, "reminders.sqlite"), { limits: config.reminders });
    inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));

    // Telegram is optional: a console-only host has no bot identity to present and no polling loop.
    let client: TelegramClient | undefined;
    let botId: string;
    if (config.telegramEnabled) {
      client = new TelegramClient(config.token, config.telegramApiRoot);
      botId = await client.identity(signal);
    } else {
      botId = "console";
    }
    inbox.bindIdentity(botId, config.ownerId);
    inbox.recover();
    // A sending row may already have reached Telegram; recovery records it as uncertain instead of resending.
    reminderStore?.recover();

    agent = await openAgent(config, options.models, undefined, {
      signal,
      memory: readMemoryConfig(env),
      ...(reminderStore === undefined ? {} : { reminderStore }),
    });
    scheduler = reminderStore === undefined || client === undefined
      ? undefined
      : new ReminderScheduler({ store: reminderStore, client, signal, log: console.error });
    scheduler?.start();

    bots = new BotManager({
      inbox,
      agent,
      workspaceRoot: join(config.dataDir, "workspaces"),
      ...(config.execution === undefined ? {} : { remoteWorkspaceRoot: config.execution.remoteCwd }),
      // The bootstrap bot keeps the single-bot installation's directory; new bots get their own.
      defaultWorkspace: config.execution?.remoteCwd ?? join(config.dataDir, "workspace"),
      bootstrapChannel: config.telegramEnabled ? "telegram" : "console",
      ptc: config.codemode !== undefined,
      signal,
      log: console.error,
    });
    await bots.start();

    if (config.console !== undefined) {
      consoleHandle = await startConsole({
        config: config.console,
        bots,
        signal,
        log: console.error,
      });
      log(`Console listening on ${consoleHandle.address}; open it with the WEB_TOKEN from the environment.`);
    }

    // The Telegram poller is one long-running loop; the console waits for shutdown instead.
    const loop = client === undefined
      ? new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        })
      : serveTelegram(config, botId, inbox, agent.reply, signal, client);
    if (config.telegramEnabled) {
      log("Personal agent starting; single-owner private Telegram messages enabled.");
    }

    const done = (async () => {
      try {
        await loop;
      } finally {
        await shutdown();
      }
    })();

    return {
      config,
      agent,
      bots,
      console: consoleHandle,
      done,
      close: async () => {
        stop.abort();
        // A failing loop is reported by `done`; close() only guarantees the resources are released.
        await done.catch(() => undefined);
      },
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** The command-line entry: signal handlers, one start, and a message this application wrote. */
async function main(): Promise<void> {
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  try {
    const service = await startService({ signal: shutdown.signal });
    await service.done;
  } catch (error) {
    if (!shutdown.signal.aborted) {
      // SDK error objects can contain credentials and message content, so only messages this
      // application wrote are logged verbatim.
      console.error("Personal agent stopped:",
        error instanceof ConfigurationError || error instanceof StateError ? error.message : failureCode(error));
      process.exitCode = 1;
    }
  }
}

// Only the real entry point runs the service; importing this module for startService does not.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
