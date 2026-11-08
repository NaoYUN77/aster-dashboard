// Process composition: configuration, storage, the agent, the bots and the dashboard surface.
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
// Removal: this process holds `DATA_DIR/service.lock` for as long as it runs, which is what makes
// "am I the only writer?" answerable rather than a guess. Between taking that lock and opening the
// agent it runs one bounded removal pass over the bots whose deletion was already accepted — the only
// point at which the conversation store may be rewritten, because the harness keeps every
// conversation open for the life of the process and the reclaim needs exclusive access.
//
// Errors: a configuration or startup failure rejects before the handle exists, after releasing
// whatever had been opened. A failure of the request loop rejects `done` after cleanup. A removal
// that fails does neither: the intent stays pending, the reason is logged, and the service starts.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Models } from "@earendil-works/pi-ai/models";
import { openAgent } from "./agent.js";
import { BotManager } from "./bot-manager.js";
import { runPendingRemovals } from "./bot-removal.js";
import { ConfigurationError, configureEnvProxy, readConfig, readLegacyCatalogEnabled, readMemoryConfig } from "./config.js";
import { startConsole, type ConsoleHandle } from "./console.js";
import { openConversationPurger, type SqliteConversationPurger } from "./conversation-purge.js";
import { failureCode, StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { jobTimeoutSeconds } from "./jobs/contracts.js";
import { BackgroundJobs } from "./jobs/service.js";
import {
  buildPlatformCapabilities, buildProvisioningRuntime,
  localWorkspaceCheck, verifiedRemoteWorkspaceCheck,
} from "./platform-runtime.js";
import { acquireServiceLock, type ServiceLock } from "./service-lock.js";
import { startTrace, type TraceRuntime } from "./trace.js";

export type ServiceConfig = ReturnType<typeof readConfig>;
export type OpenServiceAgent = Awaited<ReturnType<typeof openAgent>>;

export type ServiceOptions = {
  readonly env?: NodeJS.ProcessEnv;
  /** Offline model registry for tests; a deployment builds one from its provider configuration. */
  readonly models?: Models;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  /**
   * Host-internal compatibility switch for the pre-zero-setup catalog HTTP surface. Tests set it;
   * a deployment does not, so the browser cannot choose capabilities or tool scopes.
   */
  readonly allowLegacyCatalog?: boolean;
};

export type ServiceHandle = {
  readonly config: ServiceConfig;
  readonly agent: OpenServiceAgent;
  readonly bots: BotManager;
  readonly jobs: BackgroundJobs;
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
  let serviceLock: ServiceLock | undefined;
  let purger: SqliteConversationPurger | undefined;
  let inbox: Inbox | undefined;
  let agent: OpenServiceAgent | undefined;
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
      // The harness closes before the store does: the purger holds the same file the agent writes.
      await agent?.close().catch(() => undefined);
      purger?.close();
      inbox?.close();
      // The lock goes last: a second process must not be able to start while these are still closing.
      serviceLock?.release();
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
    // The bootstrap bot's workspace is the single-bot installation's directory. Create it here so
    // a fresh DATA_DIR can pass the provisioning health check instead of booting a failed bot.
    // A remote deployment's cwd belongs to the execution side and is never created locally.
    if (config.execution === undefined) {
      await mkdir(join(config.dataDir, "workspace"), { recursive: true, mode: 0o700 });
    }
    // One writer per data directory. The lock is claimed before any store is opened and released
    // last, so the offline removal command can tell a stopped service from a running one instead of
    // guessing at the database's writability.
    serviceLock = acquireServiceLock(config.dataDir);
    inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
    const inboxDb = inbox;
    // The console is the only ingress. Existing Telegram-era tables and their rows are kept as
    // they are: no polling checkpoint, bot identity or delivery state is read or rewritten here.

    // The one window in which a bot's rows may be removed: the harness keeps every conversation open
    // for the life of the process, so this has to happen before `openAgent()` and must never be
    // added to the running path. The tombstone is the durable intent, and a pass that fails leaves it
    // in place, reports why and keeps the deployment starting.
    try {
      purger = openConversationPurger(join(config.dataDir, "agent.sqlite"));
    } catch (error) {
      // A store whose layout this build does not recognize refuses removals rather than guessing at
      // it. That is a reason to refuse deletion, never a reason to refuse to start.
      log(`Conversation removal is unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (purger !== undefined) {
      const pass = runPendingRemovals({ store: inboxDb, purger, log });
      if (pass.vacuumError !== null) log(`Reclaiming space did not complete: ${pass.vacuumError}`);
    }

    // Host-verified deployment facts become one frozen manifest. The integration extension must
    // exist before openAgent(), so it joins the governed registry before the harness opens.
    const legacy = options.allowLegacyCatalog === true || readLegacyCatalogEnabled(env);
    const platform = buildPlatformCapabilities({
      facts: config.platform.facts,
      integrations: inboxDb,
    });

    // Background jobs (ADR-0024): the durable command task, its index rows and its completion
    // notices. The per-command limit is a host fact derived from the configured transport here, not
    // from a tool call, and the extension is installed before the harness opens.
    const jobs = new BackgroundJobs({
      index: inboxDb,
      timeoutSeconds: jobTimeoutSeconds(config.execution),
      log,
    });

    agent = await openAgent(config, options.models, undefined, {
      signal,
      memory: readMemoryConfig(env),
      jobs,
      ...(legacy ? {} : { extraExtensions: [platform.integrationExtension] }),
    });
    // A local workspace is checked on disk. A remote one is checked against the execution-face
    // health probe that openAgent() already performed at startup; an unverifiable face stays
    // fail-closed and retryable instead of being reported as Ready.
    const provisioningRuntime = buildProvisioningRuntime({
      agent,
      registry: agent.registry,
      workspaceCheck: config.execution === undefined
        ? localWorkspaceCheck
        : verifiedRemoteWorkspaceCheck(agent.executionProbe),
      rootConversationId: agent.rootId,
      // configureBot may have allocated a replacement transcript (or a brand-new bot's first one).
      // Persist that id before the health check, so a retry never allocates a second conversation.
      onConfigured: (id, conversationId) => inboxDb.setBotConversation(id, conversationId),
    });

    bots = new BotManager({
      inbox,
      agent,
      workspaceRoot: join(config.dataDir, "workspaces"),
      ...(config.execution === undefined ? {} : { remoteWorkspaceRoot: config.execution.remoteCwd }),
      // The bootstrap bot keeps the single-bot installation's directory; new bots get their own.
      // In shared-host mode that legacy path is `/workspaces` itself, i.e. the parent of every other
      // bot's directory, so the default bot's file tools can reach sibling workspaces. This is the
      // single-user MVP's known lack of per-bot isolation, not a per-bot sandbox. Moving it to
      // `/workspaces/default` would strand existing files at the root, so it needs an explicit
      // data-migration decision rather than a silent startup change.
      defaultWorkspace: config.execution?.remoteCwd ?? join(config.dataDir, "workspace"),
      web: config.ccrProfile !== undefined,
      manifest: platform.manifest,
      integrations: platform.integrations,
      ...(legacy ? {} : { provisioningRuntime }),
      // A single deployment is one tenant. Real multi-user isolation still requires a separate
      // DATA_DIR per user; the column and the workspace subtree keep the seam explicit.
      userId: "owner",
      ...(legacy ? { allowLegacyCatalog: true } : {}),
      // The console can only accept a removal the host can carry out; without the seam it refuses.
      ...(purger === undefined ? {} : { purger }),
      // Background jobs: the console reads them for its panel and badge; a live job also counts as
      // work an immediate reclaim would interrupt.
      jobs,
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
        ...(legacy ? { allowLegacyCatalog: true } : {}),
        // A removal that asked to reclaim now exits through the same graceful path as SIGTERM, from
        // inside this process: the console writes and flushes its answer first, and the container's
        // restart policy brings the service back to run the pass above.
        onRequestShutdown: () => { void shutdown(); },
      });
      log(
        config.console.token === null
          ? `Console listening on ${consoleHandle.address} with WEB_AUTH=off; the host has disabled token authentication.`
          : `Console listening on ${consoleHandle.address}; open it with the WEB_TOKEN from the environment.`,
      );
    }

    // The dashboard is the only ingress. Each bot's own worker answers its console requests, so
    // the service waits for shutdown; there is no external poller or delivery loop to reconcile.
    const loop = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });

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
      jobs,
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
