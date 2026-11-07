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
// Errors: a configuration or startup failure rejects before the handle exists, after releasing
// whatever had been opened. A failure of the request loop rejects `done` after cleanup.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Models } from "@earendil-works/pi-ai/models";
import { openAgent } from "./agent.js";
import { BotManager } from "./bot-manager.js";
import { ConfigurationError, configureEnvProxy, readConfig, readLegacyCatalogEnabled, readMemoryConfig } from "./config.js";
import { startConsole, type ConsoleHandle } from "./console.js";
import { failureCode, StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import {
  buildPlatformCapabilities, buildProvisioningRuntime,
  localWorkspaceCheck, verifiedRemoteWorkspaceCheck,
} from "./platform-runtime.js";
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
      await agent?.close().catch(() => undefined);
      inbox?.close();
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
    inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
    const inboxDb = inbox;
    // The console is the only ingress. Existing Telegram-era tables and their rows are kept as
    // they are: no polling checkpoint, bot identity or delivery state is read or rewritten here.

    // Host-verified deployment facts become one frozen manifest. The integration extension must
    // exist before openAgent(), so it joins the governed registry before the harness opens.
    const legacy = options.allowLegacyCatalog === true || readLegacyCatalogEnabled(env);
    const platform = buildPlatformCapabilities({
      facts: config.platform.facts,
      integrations: inboxDb,
    });

    agent = await openAgent(config, options.models, undefined, {
      signal,
      memory: readMemoryConfig(env),
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
