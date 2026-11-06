// The multi-bot runtime: one durable conversation per bot, one worker per bot, and the console's
// only path into the agent.
//
// Interface: `start()` registers the bootstrap bot and reconfigures every stored bot; `create()`
// adds one; `send()` durably accepts a request and returns its id; `cancel()` withdraws the bot's
// pending request and stops its run; `history()` and `watch()` expose what the conversation already
// recorded. The console calls only these methods.
//
// Zero-setup mode additionally owns provisioning: the platform manifest, capability resolver and
// durable health check decide the catalog. The browser cannot name a tool, a path, a credential or
// a conversation; `create()` needs only a name (and an optional direction prompt). A bot may chat
// only when its durable provisioning state is ready/degraded, never when it is failed or missing.
//
// Errors: an unknown or disabled bot is a StateError; a failed request is recorded with its own
// code and never reported as success. Cancelling one bot never touches another conversation.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { openAgent } from "./agent.js";
import { NotFoundError, StateError } from "./errors.js";
import {
  isBotId,
  parseBotTools,
  type BotRecord,
  type Inbox,
} from "./inbox.js";
import { failureCode } from "./telegram.js";
import {
  DEFAULT_CATALOG_PROFILE, catalogFor, legacyCapabilitiesForProfile,
  parseCatalogProfile, parseToolScope, type CatalogProfile, type ToolScope,
} from "./tool-catalog.js";
import {
  BotProvisioner, chatAllowed,
  type ProvisionTarget, type ProvisioningRecord, type ProvisioningRuntime, type ProvisioningState,
} from "./bot-provisioner.js";
import { resolveCatalog } from "./capability-resolver.js";
import { createProvisioningStore } from "./platform-runtime.js";
import type { IntegrationRegistry, IntegrationView } from "./integrations.js";
import type { CapabilityId, PlatformCapability, PlatformManifest } from "./platform-capabilities.js";

export type OpenAgent = Awaited<ReturnType<typeof openAgent>>;

/** Read-only projection of one bot's durable initialization state. */
export type BotProvisioningView = {
  readonly state: ProvisioningState | "not_provisioned";
  readonly attempt: number;
  readonly error: string | null;
  readonly unavailable: readonly CapabilityId[];
  readonly workspace: string | null;
};

export type BotView = {
  readonly botId: string;
  readonly name: string;
  readonly profile: CatalogProfile;
  readonly toolScope: ToolScope;
  readonly conversationId: string;
  readonly tools: readonly string[];
  readonly status: BotRecord["status"];
  readonly createdAt: string;
  readonly running: string | null;
  readonly pending: number;
  readonly loadedTools: readonly string[];
  /** Deployment-local tenant; workspace paths and views are scoped to it. */
  readonly userId: string;
  readonly provisioning: BotProvisioningView;
  /**
   * A platform readiness note rendered by the console. It is NOT a generated assistant turn and
   * is never appended to the durable transcript; the UI labels it as a status line.
   */
  readonly greeting: string | null;
};

export type PlatformView = {
  readonly capabilities: readonly PlatformCapability[];
  readonly unavailable: readonly CapabilityId[];
  readonly fingerprint: string;
  readonly checkedAt: string;
  readonly provisioning: readonly ProvisioningRecord[];
  readonly integrations: readonly IntegrationView[];
};

export type BotManagerOptions = {
  readonly inbox: Inbox;
  readonly agent: OpenAgent;
  /** Local deployments keep each bot's files under this directory. */
  readonly workspaceRoot: string;
  /** Remote deployments map each bot into this virtual directory instead. */
  readonly remoteWorkspaceRoot?: string;
  /**
   * The bootstrap bot keeps the deployment's existing working directory, so upgrading a single-bot
   * installation does not move its files; new bots get their own directory under the root.
   */
  readonly defaultWorkspace?: string;
  /** Where the bootstrap bot's replies go; the root conversation predates the console. */
  readonly bootstrapChannel?: "telegram" | "console";
  /** True when the deployment has code mode configured at all. */
  readonly ptc: boolean;
  /** True when the deployment has a configured Claude Code Router profile. */
  readonly web: boolean;
  readonly signal: AbortSignal;
  readonly log?: (line: string) => void;
  /** Zero-setup: host-verified platform manifest, integration registry and health-check runtime. */
  readonly manifest?: PlatformManifest;
  readonly integrations?: IntegrationRegistry;
  readonly provisioningRuntime?: ProvisioningRuntime;
  /** Deployment-local tenant. A separate DATA_DIR is still required for real multi-user isolation. */
  readonly userId?: string;
  /** Host-internal compatibility switch that keeps the pre-zero-setup catalog HTTP endpoints. */
  readonly allowLegacyCatalog?: boolean;
};

type Worker = {
  readonly botId: string;
  readonly controller: AbortController;
  readonly wake: Notifier;
  done: Promise<void>;
};

/** A one-shot wake-up used by a bot worker instead of polling. */
class Notifier {
  #waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }

  async wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#waiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

export class BotManager {
  readonly #options: BotManagerOptions;
  readonly #workers = new Map<string, Worker>();
  readonly #running = new Map<string, string>();
  readonly #loadedTools = new Map<string, readonly string[]>();
  readonly #configuring = new Set<string>();
  readonly #closed = new AbortController();
  readonly #provisioner: BotProvisioner | undefined;

  constructor(options: BotManagerOptions) {
    this.#options = options;
    // In legacy compatibility mode none of the zero-setup composition is installed, so existing
    // catalog HTTP callers keep exactly their previous behaviour and tool declarations.
    if (
      options.allowLegacyCatalog !== true
      && options.manifest !== undefined
      && options.integrations !== undefined
      && options.provisioningRuntime !== undefined
    ) {
      this.#provisioner = new BotProvisioner({
        store: createProvisioningStore(options.inbox),
        manifest: options.manifest,
        integrations: options.integrations,
        runtime: options.provisioningRuntime,
        log: options.log,
      });
    }
  }

  get #zeroSetup(): boolean {
    return this.#provisioner !== undefined;
  }

  /** Register the bootstrap bot, reconcile every stored bot and start its worker. */
  async start(): Promise<void> {
    const { inbox } = this.#options;
    const resolved = this.#zeroSetup ? this.#resolved() : undefined;
    const profile = resolved?.profile ?? DEFAULT_CATALOG_PROFILE;
    const toolScope = resolved?.scope ?? { allow: [], deny: [] };
    const tools = legacyCapabilitiesForProfile(profile, this.#options);
    const userId = this.#tenant();
    inbox.ensureBot({
      botId: "default",
      name: "Default",
      profile,
      toolScope,
      // The root conversation is the deployment's existing transcript; the bootstrap bot keeps it.
      conversationId: this.#options.agent.rootId,
      systemPrompt: "",
      tools,
      ...(userId === undefined ? {} : { userId }),
    });
    // The platform owns the catalog: a changed manifest must reconfigure the bootstrap bot too,
    // not leave stale switches from an earlier deployment fingerprint.
    if (resolved !== undefined) inbox.setBotCatalog("default", profile, toolScope);
    for (const bot of this.#bots()) await this.#activate(bot);
  }

  async create(input: { readonly name: unknown; readonly systemPrompt: unknown; readonly botId?: unknown; readonly profile?: unknown; readonly toolScope?: unknown }): Promise<BotView> {
    const allowed = this.#zeroSetup
      ? ["name", "systemPrompt", "botId"]
      : ["name", "systemPrompt", "botId", "profile", "toolScope"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new StateError("Bot configuration has unknown fields");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "" || name.length > 80) throw new StateError("Bot name must be 1-80 characters");
    const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
    if (systemPrompt.length > 8_000) throw new StateError("Bot prompt must be at most 8000 characters");
    const botId = input.botId === undefined ? this.#deriveId(name) : input.botId;
    if (!isBotId(botId)) throw new StateError("Bot id must be 1-32 lowercase letters, digits, '-' or '_'");
    if (this.#options.inbox.bot(botId) !== undefined) throw new StateError("Bot already exists");
    const userId = this.#tenant();
    let profile: CatalogProfile;
    let toolScope: ToolScope;
    if (this.#zeroSetup) {
      const resolved = this.#resolved();
      profile = resolved.profile;
      toolScope = resolved.scope;
    } else {
      try {
        profile = parseCatalogProfile(input.profile);
        toolScope = parseToolScope(input.toolScope ?? { allow: [], deny: [] });
      } catch (error) { throw new StateError(error instanceof Error ? error.message : "Bot catalog is invalid"); }
    }
    const tools = legacyCapabilitiesForProfile(profile, this.#options);

    if (this.#zeroSetup) {
      // Persist the bot row BEFORE the conversation exists. The placeholder cannot be mistaken for
      // a durable id, and provisioning replaces it with the transcript id it actually created.
      // A crash here leaves one row, never two workspaces or two transcripts.
      const pending = this.#options.inbox.createBot({
        botId,
        name,
        conversationId: `pending:${botId}`,
        systemPrompt,
        tools,
        profile,
        toolScope,
        ...(userId === undefined ? {} : { userId }),
      });
      await this.#provisioner!.provision(await this.#target(pending));
      const bot = this.#options.inbox.bot(botId)!;
      if (!this.#workers.has(botId)) this.#startWorker(botId);
      return this.view(bot);
    }

    // Legacy compatibility: the conversation is created before the row, so a bot never points at
    // a transcript that does not exist.
    const configured = await this.#options.agent.configureBot({
      botId,
      cwd: await this.#workspace(botId),
      channel: "console",
      prompt: systemPrompt,
      catalogProfile: profile,
      toolScope,
    });
    const bot = this.#options.inbox.createBot({
      botId,
      name,
      conversationId: configured.conversationId,
      systemPrompt,
      tools,
      profile,
      toolScope,
      ...(userId === undefined ? {} : { userId }),
    });
    this.#loadedTools.set(botId, configured.tools);
    await this.#activate(bot);
    return this.view(bot);
  }

  /** Reconfigure an idle bot without changing its identity or transcript (legacy compatibility). */
  async updateCatalog(botId: string, input: { readonly profile: unknown; readonly toolScope?: unknown }): Promise<BotView> {
    if (this.#zeroSetup) throw new StateError("Tool catalog is platform-managed in zero-setup mode");
    if (Object.keys(input).some((key) => key !== "profile" && key !== "toolScope")) throw new StateError("Bot catalog update has unknown fields");
    const bot = this.#activeBot(botId);
    if (this.#configuring.has(botId) || this.#options.inbox.pendingForBot(botId) > 0 || this.#running.has(botId)) {
      throw new StateError("Bot must be idle before changing its catalog");
    }
    let profile: CatalogProfile;
    let toolScope: ToolScope;
    try {
      profile = parseCatalogProfile(input.profile);
      toolScope = parseToolScope(input.toolScope === undefined ? bot.toolScope : input.toolScope);
    } catch (error) { throw new StateError(error instanceof Error ? error.message : "Bot catalog is invalid"); }
    this.#configuring.add(botId);
    try {
      await this.#activate({ ...bot, profile, toolScope: JSON.stringify(toolScope) });
      this.#options.inbox.setBotCatalog(botId, profile, toolScope);
      return this.view(this.#options.inbox.bot(botId)!);
    } finally {
      this.#configuring.delete(botId);
    }
  }

  /** Explicit operator retry after a failed initialization; reuses the same workspace/transcript. */
  async retry(botId: string): Promise<BotView> {
    const bot = this.#activeBot(botId);
    if (!this.#zeroSetup) throw new StateError("Provisioning is not enabled");
    await this.#provisioner!.retry(await this.#target(bot));
    return this.view(this.#options.inbox.bot(botId)!);
  }

  /** Durably accept one console request; the bot's worker answers it in arrival order. */
  send(botId: string, text: unknown): { readonly requestId: string } {
    const bot = this.#activeBot(botId);
    if (this.#zeroSetup && !chatAllowed(this.#provisioner?.state(botId))) {
      throw new StateError("Bot is not ready; initialization is incomplete or failed");
    }
    if (this.#configuring.has(botId)) throw new StateError("Bot catalog is being configured");
    const body = typeof text === "string" ? text.trim() : "";
    if (body === "") throw new StateError("Message text is required");
    if (body.length > 16_000) throw new StateError("Message text must be at most 16000 characters");
    const requestId = `console:${bot.botId}:${randomUUID()}`;
    this.#options.inbox.acceptConsole({
      requestId,
      conversationId: bot.conversationId,
      senderId: "console",
      text: body,
    });
    this.#workers.get(bot.botId)?.wake.notify();
    return { requestId };
  }

  /**
   * Withdraw the bot's running or pending request and stop its run. The request is marked terminal
   * first, so a run that finishes after the abort can never be saved as if it had been asked for.
   */
  async cancel(botId: string): Promise<{ readonly cancelled: boolean }> {
    const bot = this.#activeBot(botId);
    const pending = this.#options.inbox.nextForBot(bot.botId);
    const cancelled = pending === undefined ? false : this.#options.inbox.cancelConsole(pending.requestId);
    await this.#options.agent.abortConversation(bot.conversationId);
    if (cancelled) this.#workers.get(bot.botId)?.wake.notify();
    return { cancelled };
  }

  async history(botId: string, limit: number): Promise<Awaited<ReturnType<OpenAgent["history"]>>> {
    return this.#options.agent.history(this.#activeBot(botId).conversationId, limit);
  }

  async watch(botId: string, listener: (events: readonly AgentEvent[]) => void) {
    return this.#options.agent.watch(this.#activeBot(botId).conversationId, listener);
  }

  /** Read-only view of host-verified platform facts; no credential or path is ever included. */
  platform(): PlatformView {
    const manifest = this.#options.manifest;
    if (manifest === undefined) throw new StateError("Platform manifest is not configured");
    return Object.freeze({
      capabilities: manifest.capabilities,
      unavailable: Object.freeze(manifest.capabilities.filter((entry) => entry.state === "unavailable").map((entry) => entry.id)),
      fingerprint: manifest.fingerprint,
      checkedAt: manifest.checkedAt,
      provisioning: this.#provisioner?.records() ?? [],
      integrations: this.#options.integrations?.list() ?? [],
    });
  }

  /** Model-facing authorization request: records pending state, never claims a connection. */
  requestAuthorization(service: unknown) {
    if (this.#options.integrations === undefined) throw new StateError("Integrations are not configured");
    return this.#options.integrations.request(service);
  }

  view(bot: BotRecord): BotView {
    const record = this.#provisioner?.record(bot.botId);
    const provisioning: BotProvisioningView = record === undefined
      ? Object.freeze({ state: "not_provisioned" as const, attempt: 0, error: null, unavailable: [], workspace: null })
      : Object.freeze({
          state: record.state,
          attempt: record.attempt,
          error: record.error,
          unavailable: record.unavailable,
          workspace: record.workspace,
        });
    return {
      botId: bot.botId,
      name: bot.name,
      profile: bot.profile,
      toolScope: parseToolScope(bot.toolScope),
      conversationId: bot.conversationId,
      tools: parseBotTools(bot.tools).split(",").filter((name) => name !== ""),
      status: bot.status,
      createdAt: bot.createdAt,
      running: this.#running.get(bot.botId) ?? null,
      pending: this.#options.inbox.pendingForBot(bot.botId),
      loadedTools: this.#loadedTools.get(bot.botId) ?? (this.#zeroSetup ? this.#catalogNames() : []),
      userId: bot.userId,
      provisioning,
      greeting: chatAllowed(record?.state) ? "你好，我已经准备好了。" : null,
    };
  }

  views(): BotView[] {
    return [...this.#bots()].map((bot) => this.view(bot));
  }

  async close(): Promise<void> {
    this.#closed.abort();
    for (const worker of this.#workers.values()) {
      worker.controller.abort();
      worker.wake.notify();
    }
    await Promise.allSettled([...this.#workers.values()].map((worker) => worker.done));
    this.#workers.clear();
  }

  /** The host's one capability decision, recomputed from the immutable manifest on every call. */
  #resolved() {
    const { manifest, integrations } = this.#options;
    if (manifest === undefined || integrations === undefined) throw new StateError("Platform manifest is not configured");
    return resolveCatalog({ manifest, integrations });
  }

  /** Exact model-visible names after the resolved catalog; used when a restart skipped configure. */
  #catalogNames(): readonly string[] {
    const resolved = this.#resolved();
    const registry = this.#options.agent.registry;
    const entries = registry.snapshot().tools().map(({ tool }) => ({ tool, record: registry.lookup(tool.name) }));
    return Object.freeze([...catalogFor(entries, resolved.profile, resolved.scope).names].sort());
  }

  #tenant(): string | undefined {
    const userId = this.#options.userId;
    if (userId === undefined) return undefined;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(userId)) throw new StateError("Tenant id is invalid");
    return userId;
  }

  #bots(): readonly BotRecord[] {
    const userId = this.#tenant();
    return userId === undefined ? this.#options.inbox.bots() : this.#options.inbox.botsForUser(userId);
  }

  /** Host-derived target: no field here comes from the browser or the model. */
  async #target(bot: BotRecord): Promise<ProvisionTarget> {
    return Object.freeze({
      botId: bot.botId,
      name: bot.name,
      systemPrompt: bot.systemPrompt,
      conversationId: bot.conversationId,
      cwd: await this.#workspace(bot.botId),
      channel: bot.botId === "default" ? this.#options.bootstrapChannel ?? "telegram" : "console",
    });
  }

  /** The directory a bot works in: derived from its id, never from a request field. */
  async #workspace(botId: string): Promise<string> {
    if (!isBotId(botId)) throw new StateError("Bot id is invalid");
    if (botId === "default" && this.#options.defaultWorkspace !== undefined) {
      return this.#options.defaultWorkspace;
    }
    if (this.#options.remoteWorkspaceRoot !== undefined) {
      return `${this.#options.remoteWorkspaceRoot}/${botId}`;
    }
    const tenant = this.#tenant();
    // The single-owner deployment keeps its historical paths. A named tenant gets its own subtree,
    // so two tenants can never resolve to the same workspace directory.
    const root = tenant === undefined || tenant === "owner"
      ? this.#options.workspaceRoot
      : join(this.#options.workspaceRoot, tenant);
    const directory = join(root, botId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  #activeBot(botId: unknown): BotRecord {
    if (!isBotId(botId)) throw new StateError("Bot id is invalid");
    const bot = this.#options.inbox.bot(botId);
    if (bot === undefined) throw new NotFoundError("Bot not found");
    const tenant = this.#tenant();
    if (tenant !== undefined && bot.userId !== tenant) throw new NotFoundError("Bot not found");
    if (bot.status !== "active") throw new StateError("Bot is disabled");
    return bot;
  }

  /** Reconcile one row with the durable transcript and start its worker. */
  async #activate(bot: BotRecord): Promise<void> {
    if (bot.status !== "active") return;
    const resolved = this.#zeroSetup ? this.#resolved() : undefined;
    const profile = resolved?.profile ?? bot.profile;
    const toolScope = resolved?.scope ?? parseToolScope(bot.toolScope);
    const tools = legacyCapabilitiesForProfile(profile, this.#options);
    if (this.#zeroSetup) {
      // Force one configure per process: the governed registry's per-conversation catalog is
      // in-memory, so a restart MUST rebind it even when the durable row still says Ready.
      // configureBot reuses the stored conversation id, so no second transcript is allocated.
      await this.#provisioner!.provision(await this.#target(bot), { force: true });
    } else {
      const configured = await this.#options.agent.configureBot({
        botId: bot.botId,
        conversationId: bot.botId === "default" ? "root" : bot.conversationId,
        cwd: await this.#workspace(bot.botId),
        channel: bot.botId === "default" ? this.#options.bootstrapChannel ?? "telegram" : "console",
        prompt: bot.systemPrompt,
        catalogProfile: profile,
        toolScope,
      });
      if (configured.conversationId !== bot.conversationId) {
        // The transcript was lost (for example with a wiped agent database); the row follows the
        // replacement instead of pointing at a conversation that no longer exists.
        this.#options.inbox.setBotConversation(bot.botId, configured.conversationId);
      }
      this.#loadedTools.set(bot.botId, configured.tools);
    }
    if (tools !== bot.tools) this.#options.inbox.setBotTools(bot.botId, tools);
    if (!this.#workers.has(bot.botId)) this.#startWorker(bot.botId);
  }

  #startWorker(botId: string): void {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#options.signal, this.#closed.signal, controller.signal]);
    const wake = new Notifier();
    const done = this.#runWorker(botId, signal, wake);
    this.#workers.set(botId, { botId, controller, wake, done });
    void done.finally(() => {
      if (this.#workers.get(botId)?.done === done) this.#workers.delete(botId);
    });
  }

  async #runWorker(botId: string, signal: AbortSignal, wake: Notifier): Promise<void> {
    while (!signal.aborted) {
      const job = this.#options.inbox.nextForBot(botId);
      if (job === undefined) {
        await wake.wait(signal);
        continue;
      }
      this.#running.set(botId, job.requestId);
      try {
        const text = await this.#options.agent.replyFor(job.conversationId, {
          requestId: job.requestId,
          conversationId: job.conversationId,
          senderId: "console",
          text: job.text,
        }, signal);
        this.#options.inbox.saveConsoleReply(job.requestId, text);
      } catch (error) {
        if (signal.aborted) break;
        try {
          // Saving first distinguishes a real failure from a request the operator already withdrew:
          // only a still-pending row can be updated, and only that one is logged as a failure.
          const code = failureCode(error);
          this.#options.inbox.saveConsoleReply(job.requestId, `[request failed: ${code}]`, code);
          this.#options.log?.(`Bot request failed: ${job.requestId} (${code})`);
        } catch {
          // The request was cancelled while its run was ending; the row is already terminal.
        }
      } finally {
        this.#running.delete(botId);
      }
    }
  }

  #deriveId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    const base = slug === "" || !/^[a-z0-9]/.test(slug) ? `bot-${randomUUID().slice(0, 8)}` : slug;
    let candidate = base;
    for (let index = 2; this.#options.inbox.bot(candidate) !== undefined; index += 1) {
      candidate = `${base.slice(0, 26)}-${index}`;
    }
    return candidate;
  }
}
