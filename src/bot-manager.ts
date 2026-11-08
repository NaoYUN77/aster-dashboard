// The multi-bot runtime: one durable conversation per bot, one worker per bot, and the console's
// only path into the agent.
//
// Interface: `start()` registers the bootstrap bot and reconfigures every stored bot; `create()`
// adds one; `remove()` accepts the operator's decision to delete one; `send()` durably accepts a
// request and returns its id; `cancel()` withdraws the bot's pending request and stops its run;
// `history()` and `watch()` expose what the conversation already recorded. The console calls only
// these methods.
//
// Removal: `remove()` writes the tombstone and the durable intent, and nothing else — the rows leave
// the conversation store at the next process boundary, before the harness opens (see
// `conversation-purge.ts` and `bot-removal.ts`). A tombstoned bot disappears from `views()` and every
// other call answers 410 for it; its id is never reused. The reserved bootstrap bot cannot be
// deleted, only reset, so its removal keeps the bot row and the root conversation row.
//
// Zero-setup mode additionally owns provisioning: the platform manifest, capability resolver and
// durable health check decide the catalog. The browser cannot name a tool, a path, a credential or
// a conversation; `create()` needs only a name (and an optional direction prompt). A bot may chat
// only when its durable provisioning state is ready/degraded, never when it is failed or missing.
//
// Errors: an unknown bot is a StateError; a removed one is a GoneError; a request that conflicts
// with live or unexplained work is a ConflictError with a reason the console answers verbatim. A
// failed request is recorded with its own code and never reported as success. Cancelling one bot
// never touches another conversation.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { openAgent } from "./agent.js";
import { ConflictError, failureCode, GoneError, NotFoundError, StateError } from "./errors.js";
import { DURABLE_CONVERSATION_ID, type ConversationPurger } from "./conversation-purge.js";
import {
  isBotId,
  parseBotTools,
  type BotRecord,
  type BotRemoval,
  type BotRemovalKind,
  type Inbox,
} from "./inbox.js";
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
import type { BackgroundJobs, BotJobsView } from "./jobs/service.js";
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

/** One bot's accepted removal, as the console may show it. */
export type BotRemovalView = {
  readonly kind: BotRemovalKind;
  readonly requestedAt: string;
  readonly forced: boolean;
  readonly reason: string | null;
  /** `pending_purge` means the intent is durable but the rows are still in the conversation store. */
  readonly state: "pending_purge" | "purged";
  /** The last failed pass, until a later one succeeds; null while nothing has failed. */
  readonly error: string | null;
};

/** One bot the optional self-restart would interrupt, and why. */
export type BusyBotView = {
  readonly botId: string;
  readonly reason: "running" | "pending_input" | "background_jobs";
};

/** The outcome of one removal request; `restart` asks the caller to exit once its response is out. */
export type BotRemovalResult = {
  readonly bot: BotView;
  readonly removal: BotRemovalView;
  /** True when this call recorded the intent; false when it repeats one already accepted. */
  readonly accepted: boolean;
  readonly restart: boolean;
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
   * This bot's background jobs, its completion notices and the unread count. A read-only projection:
   * the console shows them and can mark notices read, but it never starts or stops a job.
   */
  readonly jobs: BotJobsView;
  /** Null while the bot is live. A bot is hidden from `views()` once this is a delete. */
  readonly removal: BotRemovalView | null;
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
  /** Removals whose rows are still in the conversation store, waiting for the next pass. */
  readonly pendingPurge: number;
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
  /**
   * The conversation store, for the two questions only it can answer: whether a bot still holds
   * unfinished or unexplained work, and whether anything inherits from its conversation.
   */
  readonly purger?: ConversationPurger;
  /**
   * The background-job host. Without it no job can be dispatched (the `job.*` tools are absent from
   * the registry) and one live job no longer counts as work a restart would interrupt.
   */
  readonly jobs?: BackgroundJobs;
};

type Worker = {
  readonly botId: string;
  readonly controller: AbortController;
  readonly wake: Notifier;
  done: Promise<void>;
};

/** The one bot that cannot be deleted: the deployment's root conversation belongs to it. */
const RESERVED_BOT_ID = "default";
/** Bounded because it is kept forever on the tombstone; it is a note, never an authorization. */
const REMOVAL_REASON_LIMIT = 500;

/** The projection a deployment without background jobs reports: nothing was ever dispatched. */
const NO_JOBS: BotJobsView = Object.freeze({ jobs: Object.freeze([]), notices: Object.freeze([]), unread: 0, live: 0 });

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

/** The read-only projection of one bot's removal, or null while the bot is live. */
function removalView(removal: BotRemoval | null): BotRemovalView | null {
  if (removal === null) return null;
  return Object.freeze({
    kind: removal.kind,
    requestedAt: removal.requestedAt,
    forced: removal.forced,
    reason: removal.reason,
    // The intent is durable from the moment it is written; the rows are not gone until a pass
    // reports them removed. The two must never read as the same thing.
    state: removal.report === null ? "pending_purge" as const : "purged" as const,
    error: removal.error,
  });
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
      botId: RESERVED_BOT_ID,
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
    if (resolved !== undefined) inbox.setBotCatalog(RESERVED_BOT_ID, profile, toolScope);
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
    const existing = this.#options.inbox.bot(botId);
    // A deleted bot's id stays retired: its tombstone is the record that the id was used, and ids are
    // never reused in this deployment.
    if (existing !== undefined) {
      if (existing.removal !== null) throw new ConflictError("bot_id_retired");
      throw new StateError("Bot already exists");
    }
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

  /**
   * Accept the operator's decision to remove one bot. Nothing is physically deleted here, and the
   * response must not claim it was: this writes the tombstone and the durable intent, which makes
   * the bot unreachable from the console immediately, while the rows it names leave the conversation
   * store at the next process boundary, before the harness opens (`bot-removal.ts`).
   *
   * The reserved bot is reset rather than deleted — its row and its root conversation stay, so the
   * deployment keeps its transcript identity and its memory — and its id is never retired. The
   * refusals separate a condition the operator can clear (stop the run, answer the queued input)
   * from one only an explicit `force` may override (work whose outcome will never be known): a
   * refusal nobody can act on is a dead end.
   */
  remove(botId: unknown, input: { readonly force?: unknown; readonly purge?: unknown; readonly reason?: unknown }): BotRemovalResult {
    if (Object.keys(input).some((key) => key !== "force" && key !== "purge" && key !== "reason")) {
      throw new StateError("Removal request has unknown fields");
    }
    const force = input.force === undefined ? false : input.force;
    if (typeof force !== "boolean") throw new StateError("Removal force must be a boolean");
    const purge = input.purge === undefined ? "later" : input.purge;
    if (purge !== "later" && purge !== "now") throw new StateError("Removal purge must be \"later\" or \"now\"");
    const reason = input.reason === undefined ? null : input.reason;
    if (reason !== null && typeof reason !== "string") throw new StateError("Removal reason must be a string");
    if (typeof reason === "string" && reason.length > REMOVAL_REASON_LIMIT) {
      throw new StateError(`Removal reason must be at most ${REMOVAL_REASON_LIMIT} characters`);
    }
    const bot = this.#removableBot(botId);
    const existing = bot.removal;
    if (existing !== null) {
      // Idempotent by design: the first decision stands, its timestamp never moves and a repeat can
      // never enqueue a second removal. The one thing a repeat may do is supply the `force` the
      // first call did not have — how an operator overrides an outcome nobody has seen yet.
      const upgraded = existing.report === null && force && !existing.forced
        ? this.#options.inbox.requestRemoval(bot.botId, { kind: existing.kind, force: true, reason: existing.reason })
        : bot;
      return this.#removalResult(upgraded, false, false);
    }
    const kind: BotRemovalKind = bot.botId === RESERVED_BOT_ID ? "reset" : "delete";
    if (this.#running.has(bot.botId)) throw new ConflictError("bot_is_running");
    if (this.#options.inbox.pendingForBot(bot.botId) > 0) throw new ConflictError("bot_has_pending_input");
    this.#assertRemovable(bot, force);
    // One process carries every bot, so reclaiming now interrupts the others. Refused while any of
    // them is mid-work, naming whom to cancel first; it is never silently forced through.
    if (purge === "now") {
      const busy = this.busyBots(bot.botId);
      if (busy.length > 0) throw new ConflictError("busy_bots", { bots: busy });
    }
    return this.#removalResult(this.#options.inbox.requestRemoval(bot.botId, { kind, force, reason }), true, purge === "now");
  }

  /**
   * Bots with work in flight that the removal of `except` would interrupt. Identifiers only; the
   * three reasons are the caller's actionable list — stop the run, answer the queued input, or wait
   * for (or cancel) a job.
   */
  busyBots(except: string): readonly BusyBotView[] {
    return Object.freeze(this.#bots()
      .filter((bot) => bot.botId !== except && bot.status !== "deleted")
      .flatMap((bot) => {
        const reason: BusyBotView["reason"] | null = this.#running.has(bot.botId)
          ? "running"
          : this.#options.inbox.pendingForBot(bot.botId) > 0
            ? "pending_input"
            // A restart stops every command this process is running, background ones included: the
            // job would resume at the next start as work whose outcome is unknown, so it counts.
            : (this.#options.jobs?.view(bot.botId).live ?? 0) > 0 ? "background_jobs" : null;
        return reason === null ? [] : [Object.freeze({ botId: bot.botId, reason })];
      }));
  }

  /** One bot's background jobs, notices and unread count, for the console's panel and badge. */
  jobsView(botId: unknown): BotJobsView {
    const bot = this.#activeBot(botId);
    return this.#jobs().view(bot.botId);
  }

  /**
   * Mark this bot's completion notices read. Bounded by the ids the caller names, which are looked
   * up under this bot: a notice of another bot is never touched, and an unknown id changes nothing.
   */
  markJobNoticesRead(botId: unknown, noticeIds?: readonly string[]): { readonly read: number } {
    const bot = this.#activeBot(botId);
    if (noticeIds !== undefined && (noticeIds.length > 100 || noticeIds.some((id) => typeof id !== "string" || id === ""))) {
      throw new StateError("Notice ids must be at most 100 non-empty strings");
    }
    return { read: this.#jobs().markRead(bot.botId, noticeIds) };
  }

  #jobs(): BackgroundJobs {
    const jobs = this.#options.jobs;
    if (jobs === undefined) throw new StateError("Background jobs are not configured");
    return jobs;
  }

  /**
   * Assert that a route may address this bot at all, with no other effect. The console answers the
   * event stream with 200 headers before it can learn the bot is gone, so the 410/404/400 mapping has
   * to be reachable while a JSON answer is still possible.
   */
  requireActive(botId: unknown): void {
    this.#activeBot(botId);
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
      pendingPurge: this.#options.inbox.pendingRemovals().length,
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
      jobs: this.#options.jobs?.view(bot.botId) ?? NO_JOBS,
      removal: removalView(bot.removal),
      greeting: chatAllowed(record?.state) ? "你好，我已经准备好了。" : null,
    };
  }

  /** What the console lists: a bot whose deletion was accepted has left the operator's view. */
  views(): BotView[] {
    return [...this.#bots()].filter((bot) => bot.status !== "deleted").map((bot) => this.view(bot));
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

  /**
   * Every stored bot, tombstones included: the reconciliation and id-derivation paths must see a
   * retired id so it is never handed out again. `views()` is the filtered projection for the console.
   */
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
      channel: "console",
    });
  }

  /** The directory a bot works in: derived from its id, never from a request field. */
  async #workspace(botId: string): Promise<string> {
    if (!isBotId(botId)) throw new StateError("Bot id is invalid");
    if (botId === RESERVED_BOT_ID && this.#options.defaultWorkspace !== undefined) {
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
    // A removed bot is gone, not switched off; "disabled" would tell the operator the wrong story.
    if (bot.status === "deleted") throw new GoneError("bot_deleted");
    if (bot.status !== "active") throw new StateError("Bot is disabled");
    return bot;
  }

  /**
   * The bot a removal may act on: it must exist and belong to this tenant. Unlike `#activeBot`, a
   * disabled bot is removable — switching one off is no reason to be unable to delete it — and a
   * tombstoned one reaches the caller's repeat branch rather than an error.
   */
  #removableBot(botId: unknown): BotRecord {
    if (!isBotId(botId)) throw new StateError("Bot id is invalid");
    const bot = this.#options.inbox.bot(botId);
    if (bot === undefined) throw new NotFoundError("Bot not found");
    const tenant = this.#tenant();
    if (tenant !== undefined && bot.userId !== tenant) throw new NotFoundError("Bot not found");
    return bot;
  }

  /**
   * What only the conversation store can answer: whether this bot still holds unfinished or
   * unexplained work, and whether anything inherits its history. A bot whose transcript was never
   * created has nothing there — which is not the same as a clean one, and is why the check is
   * skipped only for the `pending:<id>` placeholder a failed provisioning leaves behind.
   */
  #assertRemovable(bot: BotRecord, force: boolean): void {
    const purger = this.#options.purger;
    // Fail closed. Without the store there is no way to tell a settled bot from one holding work,
    // and guessing is the one thing this feature must never do.
    if (purger === undefined) throw new StateError("The conversation store is not available for removal");
    if (!DURABLE_CONVERSATION_ID.test(bot.conversationId)) return;
    const inspection = purger.inspect(bot.conversationId);
    // A task that is not terminal belongs to a run this process still owns, so refusing is
    // actionable: cancel it and ask again. The same row at the next process boundary is work that
    // stopped without an answer, which `force` covers — which is why the two refusals differ.
    if (inspection.liveTasks > 0 || inspection.liveSubmissions > 0) {
      throw new ConflictError("work_in_flight", { tasks: inspection.liveTasks, submissions: inspection.liveSubmissions });
    }
    if (inspection.unknownOutcomes > 0 && !force) {
      throw new ConflictError("unknown_outcome", { records: inspection.unknownOutcomes });
    }
    // Nothing in this deployment forks, but a conversation that inherits from this one would be
    // left with a transcript that cannot be read, so it is refused unless the operator forces it.
    if (inspection.dependents.length > 0 && !force) {
      throw new ConflictError("fork_survivor", { conversations: inspection.dependents.length });
    }
  }

  /** A recorded removal, as the console is answered. There is always one by the time this is called. */
  #removalResult(bot: BotRecord, accepted: boolean, restart: boolean): BotRemovalResult {
    const removal = removalView(bot.removal);
    if (removal === null) throw new StateError("Bot removal was not recorded");
    return Object.freeze({ bot: this.view(bot), removal, accepted, restart });
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
        conversationId: bot.botId === RESERVED_BOT_ID ? "root" : bot.conversationId,
        cwd: await this.#workspace(bot.botId),
        channel: "console",
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
      const request = this.#options.inbox.nextForBot(botId);
      if (request === undefined) {
        await wake.wait(signal);
        continue;
      }
      this.#running.set(botId, request.requestId);
      try {
        const text = await this.#options.agent.replyFor(request.conversationId, {
          requestId: request.requestId,
          conversationId: request.conversationId,
          senderId: "console",
          text: request.text,
        }, signal);
        this.#options.inbox.saveConsoleReply(request.requestId, text);
      } catch (error) {
        if (signal.aborted) break;
        try {
          // Saving first distinguishes a real failure from a request the operator already withdrew:
          // only a still-pending row can be updated, and only that one is logged as a failure.
          const code = failureCode(error);
          this.#options.inbox.saveConsoleReply(request.requestId, `[request failed: ${code}]`, code);
          this.#options.log?.(`Bot request failed: ${request.requestId} (${code})`);
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
