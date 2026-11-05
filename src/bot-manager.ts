// The multi-bot runtime: one durable conversation per bot, one worker per bot, and the console's
// only path into the agent.
//
// Interface: `start()` registers the bootstrap bot and reconfigures every stored bot; `create()`
// adds one; `send()` durably accepts a request and returns its id; `cancel()` withdraws the bot's
// pending request and stops its run; `history()` and `watch()` expose what the conversation already
// recorded. The console calls only these methods.
//
// Inputs: the Inbox (bots and requests share one database), the open agent, the deployment's
// workspace root and the shutdown signal. A bot's directory is always derived here from its id;
// nothing the browser sends selects a path, a model or a tool.
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
  type BotRole,
  type Inbox,
} from "./inbox.js";
import { failureCode } from "./telegram.js";
import { legacyCapabilitiesForRole, parseToolScope, profileForRole, type CatalogProfileId, type ToolScope } from "./tool-catalog.js";

export type OpenAgent = Awaited<ReturnType<typeof openAgent>>;

/** Compatibility projection; catalog profile defaults are defined in tool-catalog.ts. */
export function toolsForRole(role: BotRole, deployment: { readonly ptc: boolean; readonly web: boolean }): string {
  return legacyCapabilitiesForRole(role, deployment);
}

export type BotView = {
  readonly botId: string;
  readonly name: string;
  readonly role: BotRole;
  readonly profile: CatalogProfileId;
  readonly toolScope: ToolScope;
  readonly conversationId: string;
  readonly tools: readonly string[];
  readonly status: BotRecord["status"];
  readonly createdAt: string;
  readonly running: string | null;
  readonly pending: number;
  readonly loadedTools: readonly string[];
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
  readonly #closed = new AbortController();

  constructor(options: BotManagerOptions) {
    this.#options = options;
  }

  /** Register the bootstrap bot, reconfigure every stored bot and start its worker. */
  async start(): Promise<void> {
    const { inbox } = this.#options;
    const tools = toolsForRole("assistant", { ptc: this.#options.ptc, web: this.#options.web });
    inbox.ensureBot({
      botId: "default",
      name: "Default",
      role: "assistant",
      // The root conversation is the deployment's existing transcript; the bootstrap bot keeps it.
      conversationId: this.#options.agent.rootId,
      systemPrompt: "",
      tools,
    });
    for (const bot of inbox.bots()) await this.#activate(bot);
  }

  async create(input: { readonly name: unknown; readonly role: unknown; readonly systemPrompt: unknown; readonly botId?: unknown; readonly toolScope?: unknown }): Promise<BotView> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "" || name.length > 80) throw new StateError("Bot name must be 1-80 characters");
    const role = input.role;
    if (role !== "assistant" && role !== "researcher" && role !== "programmer") {
      throw new StateError("Bot role must be assistant, researcher or programmer");
    }
    const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
    if (systemPrompt.length > 8_000) throw new StateError("Bot prompt must be at most 8000 characters");
    const botId = input.botId === undefined ? this.#deriveId(name) : input.botId;
    if (!isBotId(botId)) throw new StateError("Bot id must be 1-32 lowercase letters, digits, '-' or '_'");
    if (this.#options.inbox.bot(botId) !== undefined) throw new StateError("Bot already exists");
    const tools = parseBotTools(toolsForRole(role, { ptc: this.#options.ptc, web: this.#options.web }));
    const profile = profileForRole(role);
    let toolScope: ToolScope;
    try { toolScope = parseToolScope(input.toolScope ?? { allow: [], deny: [] }); }
    catch (error) { throw new StateError(error instanceof Error ? error.message : "Bot tool scope is invalid"); }
    // The conversation is created before the row: a bot never points at a transcript that does not exist.
    const configured = await this.#options.agent.configureBot({
      botId,
      cwd: await this.#workspace(botId),
      channel: "console",
      prompt: systemPrompt,
      tools: tools.split(","),
      catalogProfile: profile,
      toolScope,
    });
    const bot = this.#options.inbox.createBot({
      botId,
      name,
      role,
      conversationId: configured.conversationId,
      systemPrompt,
      tools,
      profile,
      toolScope,
    });
    this.#loadedTools.set(botId, configured.tools);
    await this.#activate(bot);
    return this.view(bot);
  }

  /** Durably accept one console request; the bot's worker answers it in arrival order. */
  send(botId: string, text: unknown): { readonly requestId: string } {
    const bot = this.#activeBot(botId);
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

  view(bot: BotRecord): BotView {
    return {
      botId: bot.botId,
      name: bot.name,
      role: bot.role,
      profile: bot.profile,
      toolScope: parseToolScope(bot.toolScope),
      conversationId: bot.conversationId,
      tools: parseBotTools(bot.tools).split(",").filter((name) => name !== ""),
      status: bot.status,
      createdAt: bot.createdAt,
      running: this.#running.get(bot.botId) ?? null,
      pending: this.#options.inbox.pendingForBot(bot.botId),
      loadedTools: this.#loadedTools.get(bot.botId) ?? [],
    };
  }

  views(): BotView[] {
    return this.#options.inbox.bots().map((bot) => this.view(bot));
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

  /** The directory a bot works in: derived from its id, never from a request field. */
  async #workspace(botId: string): Promise<string> {
    if (!isBotId(botId)) throw new StateError("Bot id is invalid");
    if (botId === "default" && this.#options.defaultWorkspace !== undefined) {
      return this.#options.defaultWorkspace;
    }
    if (this.#options.remoteWorkspaceRoot !== undefined) {
      return `${this.#options.remoteWorkspaceRoot}/${botId}`;
    }
    const directory = join(this.#options.workspaceRoot, botId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  #activeBot(botId: unknown): BotRecord {
    if (!isBotId(botId)) throw new StateError("Bot id is invalid");
    const bot = this.#options.inbox.bot(botId);
    if (bot === undefined) throw new NotFoundError("Bot not found");
    if (bot.status !== "active") throw new StateError("Bot is disabled");
    return bot;
  }

  /** Reconcile one row with the durable transcript and start its worker. */
  async #activate(bot: BotRecord): Promise<void> {
    if (bot.status !== "active") return;
    // Role maps to the durable catalog profile; capability strings remain a compatibility projection.
    const profile = profileForRole(bot.role);
    const toolScope = parseToolScope(bot.toolScope);
    const tools = parseBotTools(toolsForRole(bot.role, { ptc: this.#options.ptc, web: this.#options.web }));
    if (tools !== bot.tools) this.#options.inbox.setBotTools(bot.botId, tools);
    if (profile !== bot.profile) this.#options.inbox.setBotCatalog(bot.botId, profile, toolScope);
    const configured = await this.#options.agent.configureBot({
      botId: bot.botId,
      conversationId: bot.botId === "default" ? "root" : bot.conversationId,
      cwd: await this.#workspace(bot.botId),
      channel: bot.botId === "default" ? this.#options.bootstrapChannel ?? "telegram" : "console",
      prompt: bot.systemPrompt,
      tools: tools.split(",").filter((name) => name !== ""),
      catalogProfile: profile,
      toolScope,
    });
    if (configured.conversationId !== bot.conversationId) {
      // The transcript was lost (for example with a wiped agent database); the row follows the
      // replacement instead of pointing at a conversation that no longer exists.
      this.#options.inbox.setBotConversation(bot.botId, configured.conversationId);
    }
    this.#loadedTools.set(bot.botId, configured.tools);
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
