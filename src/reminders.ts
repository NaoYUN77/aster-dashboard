import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { GrammyError } from "grammy";
import { failureCode, type TelegramClient } from "./telegram.js";

/** Model-visible limits. A reminder is one plain-text Telegram message. */
export const REMINDER_CONTENT_MAX_CHARS = 2_000;
export const REMINDER_CONTENT_MAX_BYTES = 8_000;
export const REMINDER_TIMEZONE_MAX_CHARS = 64;
/** One scheduler pass claims at most this many due rows, keeping shutdown latency bounded. */
const CLAIM_BATCH = 20;
const IDLE_WAKE_MS = 60_000;

export type ReminderLimits = {
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly horizonDays: number;
};

export const REMINDER_LIMITS: ReminderLimits = { maxPending: 100, maxPerHour: 20, horizonDays: 366 };

export type ReminderStatus =
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface Reminder {
  readonly id: number;
  readonly chatId: string;
  readonly ownerId: string;
  readonly content: string;
  /** ISO 8601 UTC; the only value the scheduler compares. */
  readonly dueAt: string;
  readonly timezone: string;
  readonly createdAt: string;
  readonly status: ReminderStatus;
  readonly attempts: number;
  readonly messageId: string | null;
  readonly sentAt: string | null;
  readonly failureCode: string | null;
}

/** A host-written failure class; the message is safe to show to the model and operators. */
export class ReminderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReminderError";
  }
}

export interface CreateReminderInput {
  readonly chatId: string;
  readonly ownerId: string;
  readonly content: string;
  /** ISO 8601 timestamp with an explicit offset or `Z`. Local times without an offset are refused. */
  readonly triggerAt: string;
  readonly timezone: string;
  /** Host tool-call identity; re-executing the same call returns the stored reminder instead of duplicating it. */
  readonly idempotencyKey?: string;
}

export interface CreateReminderResult {
  readonly reminder: Reminder;
  /** False when the idempotency key already named this reminder. */
  readonly created: boolean;
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;

function characterCount(text: string): number {
  return [...text].length;
}

function parseTrigger(value: string, now: Date, limits: ReminderLimits): Date {
  if (ISO_WITHOUT_OFFSET.test(value)) {
    throw new ReminderError(
      "REMINDER_TIME_AMBIGUOUS",
      "trigger_at must include an explicit UTC offset (for example +08:00) or Z; ask the user which instant they mean.",
    );
  }
  if (!ISO_WITH_OFFSET.test(value)) {
    throw new ReminderError("REMINDER_TIME_INVALID", "trigger_at must be an ISO 8601 timestamp with an explicit offset or Z");
  }
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) {
    throw new ReminderError("REMINDER_TIME_INVALID", "trigger_at is not a valid instant");
  }
  if (due.getTime() <= now.getTime()) {
    throw new ReminderError("REMINDER_TIME_IN_PAST", "trigger_at is not in the future; resolve the current time and retry");
  }
  if (due.getTime() - now.getTime() > limits.horizonDays * 86_400_000) {
    throw new ReminderError("REMINDER_TIME_TOO_FAR", `trigger_at must be within ${limits.horizonDays} days`);
  }
  return due;
}

/** `Intl` is the authority for IANA names; an unknown zone is a model error, not a default. */
function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new ReminderError("REMINDER_INVALID_TIMEZONE", "timezone must be a valid IANA time zone name");
  }
}

function validateContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new ReminderError("REMINDER_INVALID_CONTENT", "content must not be empty");
  if (characterCount(trimmed) > REMINDER_CONTENT_MAX_CHARS || Buffer.byteLength(trimmed, "utf8") > REMINDER_CONTENT_MAX_BYTES) {
    throw new ReminderError("REMINDER_INVALID_CONTENT", `content must be at most ${REMINDER_CONTENT_MAX_CHARS} characters and ${REMINDER_CONTENT_MAX_BYTES} bytes`);
  }
  return trimmed;
}

function row(value: unknown): Reminder {
  const record = value as Record<string, unknown>;
  return Object.freeze({
    id: Number(record.id),
    chatId: String(record.chatId),
    ownerId: String(record.ownerId),
    content: String(record.content),
    dueAt: String(record.dueAt),
    timezone: String(record.timezone),
    createdAt: String(record.createdAt),
    status: String(record.status) as ReminderStatus,
    attempts: Number(record.attempts),
    messageId: record.messageId === null ? null : String(record.messageId),
    sentAt: record.sentAt === null ? null : String(record.sentAt),
    failureCode: record.failureCode === null ? null : String(record.failureCode),
  });
}

/**
 * Durable reminder state. SQLite is the only source of truth; the scheduler's timer only decides
 * when to look. Every transition is a conditional update inside one immediate transaction, so a
 * repeated scan cannot queue or send the same reminder twice.
 */
export class ReminderStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #limits: ReminderLimits;
  readonly #listeners = new Set<() => void>();

  constructor(path: string, options: { readonly now?: () => Date; readonly limits?: ReminderLimits } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    this.#limits = options.limits ?? REMINDER_LIMITS;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        content TEXT NOT NULL,
        dueAt TEXT NOT NULL,
        timezone TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        messageId TEXT,
        sentAt TEXT,
        failureCode TEXT,
        idempotencyKey TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, dueAt);
    `);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Validate and persist one reminder. Time is resolved by the host from an ISO instant and an
   * IANA zone; the model cannot pick a target chat. The idempotency key makes replay after a crash
   * return the original row instead of creating a second reminder.
   */
  create(input: CreateReminderInput): CreateReminderResult {
    const now = this.#now();
    const content = validateContent(input.content);
    const timezone = input.timezone.trim();
    if (!timezone || timezone.length > REMINDER_TIMEZONE_MAX_CHARS) {
      throw new ReminderError("REMINDER_INVALID_TIMEZONE", "timezone must be a non-empty IANA time zone name");
    }
    assertTimezone(timezone);
    const due = parseTrigger(input.triggerAt.trim(), now, this.#limits);
    const nowIso = now.toISOString();
    const key = input.idempotencyKey === undefined || input.idempotencyKey === ""
      ? null
      : createHash("sha256").update(input.idempotencyKey).digest("hex");

    return this.transaction((): CreateReminderResult => {
      if (key !== null) {
        const existing = this.#db.prepare("SELECT * FROM reminders WHERE idempotencyKey = ?").get(key);
        if (existing) return { reminder: row(existing), created: false };
      }
      const active = Number((this.#db.prepare(
        "SELECT COUNT(*) AS n FROM reminders WHERE chatId = ? AND status IN ('pending', 'queued', 'sending')",
      ).get(input.chatId) as { n: number }).n);
      if (active >= this.#limits.maxPending) {
        throw new ReminderError("REMINDER_LIMIT_EXCEEDED", `at most ${this.#limits.maxPending} active reminders are allowed`);
      }
      const hourly = Number((this.#db.prepare(
        "SELECT COUNT(*) AS n FROM reminders WHERE chatId = ? AND createdAt >= ?",
      ).get(input.chatId, new Date(now.getTime() - 3_600_000).toISOString()) as { n: number }).n);
      if (hourly >= this.#limits.maxPerHour) {
        throw new ReminderError("REMINDER_RATE_LIMITED", `at most ${this.#limits.maxPerHour} reminders can be created per hour`);
      }
      const inserted = this.#db.prepare(`INSERT INTO reminders
        (chatId, ownerId, content, dueAt, timezone, createdAt, status, idempotencyKey)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
        input.chatId, input.ownerId, content, due.toISOString(), timezone, nowIso, key,
      );
      const stored = this.#db.prepare("SELECT * FROM reminders WHERE id = ?").get(Number(inserted.lastInsertRowid));
      return { reminder: row(stored), created: true };
    });
  }

  /** Active reminders first, then optionally the most recent finished ones. */
  list(chatId: string, options: { readonly includeFinished?: boolean; readonly limit?: number } = {}): Reminder[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const active = this.#db.prepare(`SELECT * FROM reminders
      WHERE chatId = ? AND status IN ('pending', 'queued', 'sending')
      ORDER BY dueAt, id LIMIT ?`).all(chatId, limit) as unknown[];
    if (options.includeFinished !== true) return active.map(row);
    const finished = this.#db.prepare(`SELECT * FROM reminders
      WHERE chatId = ? AND status IN ('sent', 'failed', 'uncertain', 'cancelled')
      ORDER BY createdAt DESC, id DESC LIMIT ?`).all(chatId, limit) as unknown[];
    return [...active.map(row), ...finished.map(row)];
  }

  /** Operator view: rows that need reconciliation first, then active and finished history. */
  listAll(limit = 200): Reminder[] {
    return (this.#db.prepare(`SELECT * FROM reminders
      ORDER BY CASE status WHEN 'sending' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'failed' THEN 2
        WHEN 'queued' THEN 3 WHEN 'pending' THEN 4 ELSE 5 END, dueAt, id LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 1_000))) as unknown[]).map(row);
  }

  /**
   * Cancel only before a send starts. A cancelled reminder is terminal; repeating the same cancel
   * is idempotent so a replayed tool call still reports the stored outcome.
   */
  cancel(chatId: string, id: number): Reminder {
    return this.transaction(() => {
      const existing = this.#db.prepare("SELECT * FROM reminders WHERE id = ? AND chatId = ?").get(id, chatId);
      if (!existing) throw new ReminderError("REMINDER_NOT_FOUND", `reminder ${id} was not found`);
      const reminder = row(existing);
      if (reminder.status === "cancelled") return reminder;
      if (reminder.status !== "pending" && reminder.status !== "queued") {
        throw new ReminderError(
          "REMINDER_NOT_CANCELLABLE",
          `reminder ${id} is ${reminder.status} and can no longer be cancelled`,
        );
      }
      const changed = this.#db.prepare(
        "UPDATE reminders SET status = 'cancelled' WHERE id = ? AND chatId = ? AND status IN ('pending', 'queued')",
      ).run(id, chatId);
      if (changed.changes !== 1) throw new ReminderError("REMINDER_NOT_CANCELLABLE", `reminder ${id} is already being sent`);
      return row(this.#db.prepare("SELECT * FROM reminders WHERE id = ?").get(id));
    });
  }

  /**
   * One scan step: pending rows that are due become queued, then every queued row is returned in
   * due order. The conditional update is what prevents two scans from claiming the same row.
   */
  claimDue(nowIso = this.#now().toISOString(), limit = CLAIM_BATCH): Reminder[] {
    return this.transaction(() => {
      const due = this.#db.prepare(`SELECT id FROM reminders
        WHERE status = 'pending' AND dueAt <= ? ORDER BY dueAt, id LIMIT ?`).all(nowIso, limit) as { id: number }[];
      const claim = this.#db.prepare("UPDATE reminders SET status = 'queued' WHERE id = ? AND status = 'pending'");
      for (const { id } of due) claim.run(id);
      return (this.#db.prepare("SELECT * FROM reminders WHERE status = 'queued' ORDER BY dueAt, id LIMIT ?")
        .all(limit) as unknown[]).map(row);
    });
  }

  /** Conditional `queued -> sending`; only the winner may call Telegram. */
  beginSend(id: number): boolean {
    const changed = this.#db.prepare(
      "UPDATE reminders SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
    ).run(id);
    return changed.changes === 1;
  }

  markSent(id: number, messageId: string): void {
    this.transaction(() => {
      const changed = this.#db.prepare(
        "UPDATE reminders SET status = 'sent', messageId = ?, sentAt = ?, failureCode = NULL WHERE id = ? AND status = 'sending'",
      ).run(messageId, this.#now().toISOString(), id);
      if (changed.changes !== 1) throw new Error("Reminder is not in the sending state");
    });
  }

  /**
   * Explicit Telegram rejection is `failed`; a transport error or shutdown, where Telegram may have
   * accepted the message, is `uncertain`. Neither is retried automatically.
   */
  markFailure(id: number, status: "failed" | "uncertain", code: string): void {
    const changed = this.#db.prepare(
      "UPDATE reminders SET status = ?, failureCode = ? WHERE id = ? AND status = 'sending'",
    ).run(status, code.slice(0, 128), id);
    if (changed.changes !== 1) throw new Error("Reminder is not in the sending state");
  }

  /** Earliest time a pass has work, used only to choose the next wake-up. Queued rows count so a
   * batch larger than CLAIM_BATCH is drained immediately instead of waiting for the idle wake. */
  nextDueAt(): string | undefined {
    const value = this.#db.prepare("SELECT MIN(dueAt) AS dueAt FROM reminders WHERE status IN ('pending', 'queued')").get() as { dueAt: string | null };
    return value.dueAt === null ? undefined : value.dueAt;
  }

  /**
   * Startup recovery. A queued row never reached Telegram, so it returns to pending. A sending row
   * may have reached Telegram before the process died; it becomes uncertain and is never resent
   * automatically.
   */
  recover(): void {
    this.transaction(() => {
      this.#db.prepare("UPDATE reminders SET status = 'uncertain', failureCode = 'PROCESS_INTERRUPTED' WHERE status = 'sending'").run();
      this.#db.prepare("UPDATE reminders SET status = 'pending' WHERE status = 'queued'").run();
    });
    this.notify();
  }

  /** Operator reconciliation after checking Telegram: confirm delivery or make one retry possible. */
  resolve(id: number, action: "sent" | "retry"): Reminder {
    return this.transaction(() => {
      const existing = this.#db.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
      if (!existing) throw new ReminderError("REMINDER_NOT_FOUND", `reminder ${id} was not found`);
      const reminder = row(existing);
      if (reminder.status !== "failed" && reminder.status !== "uncertain") {
        throw new ReminderError("REMINDER_NOT_RECONCILABLE", `reminder ${id} is ${reminder.status}`);
      }
      if (action === "sent") {
        this.#db.prepare("UPDATE reminders SET status = 'sent', sentAt = ?, failureCode = NULL WHERE id = ? AND status = ?")
          .run(this.#now().toISOString(), id, reminder.status);
      } else {
        this.#db.prepare("UPDATE reminders SET status = 'pending', sentAt = NULL, messageId = NULL, failureCode = NULL WHERE id = ? AND status = ?")
          .run(id, reminder.status);
      }
      return row(this.#db.prepare("SELECT * FROM reminders WHERE id = ?").get(id));
    });
  }

  close(): void {
    this.#db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** One plain-text notification; the reminder body is data, never interpreted as instructions. */
export function reminderText(reminder: Pick<Reminder, "content">): string {
  return `提醒：${reminder.content}`;
}

/** Telegram 4xx is a definite refusal; anything else may have been accepted. */
export function classifySendFailure(error: unknown): "failed" | "uncertain" {
  return error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 ? "failed" : "uncertain";
}

export type ReminderSchedulerOptions = {
  readonly store: ReminderStore;
  readonly client: Pick<TelegramClient, "send">;
  /** Shutdown signal; a send aborted by it becomes uncertain, never failed. */
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
};

/**
 * In-process scheduler. It holds no reminder state: each pass reads SQLite, claims due rows and
 * sends them one at a time. Every failure is caught and logged, so a broken Telegram call cannot
 * affect the agent session or the polling loop.
 */
export class ReminderScheduler {
  readonly #store: ReminderStore;
  readonly #client: Pick<TelegramClient, "send">;
  readonly #signal?: AbortSignal;
  readonly #log: (line: string) => void;
  readonly #now: () => Date;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;
  #started = false;
  #wake: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: ReminderSchedulerOptions) {
    this.#store = options.store;
    this.#client = options.client;
    this.#signal = options.signal;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#now = options.now ?? (() => new Date());
  }

  private signal(): AbortSignal {
    return this.#signal === undefined ? this.#stop.signal : AbortSignal.any([this.#signal, this.#stop.signal]);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = this.#store.subscribe(() => this.#wake?.());
    this.#loop = this.loop(this.signal()).catch((error: unknown) => {
      this.#log(`Reminder scheduler stopped (${failureCode(error)})`);
    });
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    this.#wake?.();
    await this.#loop?.catch(() => undefined);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#started = false;
  }

  /**
   * One deterministic pass, exposed for tests and for an operator-triggered flush. Returns the
   * number of reminders Telegram accepted.
   */
  async runDue(signal: AbortSignal = this.signal()): Promise<number> {
    const claimed = this.#store.claimDue(this.#now().toISOString());
    let sent = 0;
    for (const reminder of claimed) {
      if (signal.aborted) break;
      if (!this.#store.beginSend(reminder.id)) continue;
      try {
        const messageId = await this.#client.send(reminder.chatId, reminderText(reminder), signal);
        this.#store.markSent(reminder.id, messageId);
        sent += 1;
      } catch (error) {
        const status = classifySendFailure(error);
        try {
          this.#store.markFailure(reminder.id, status, failureCode(error));
        } catch (recordError) {
          // Leaving the row in `sending` is safe: the next startup records it as uncertain.
          this.#log(`Reminder ${reminder.id} outcome could not be recorded (${failureCode(recordError)})`);
        }
        this.#log(`Reminder delivery ${status}: ${reminder.id} (${failureCode(error)})`);
      }
    }
    return sent;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runDue(signal);
      } catch (error) {
        this.#log(`Reminder scheduler pass failed (${failureCode(error)})`);
      }
      if (signal.aborted) break;
      const next = this.#store.nextDueAt();
      const delay = next === undefined
        ? IDLE_WAKE_MS
        : Math.max(0, Math.min(IDLE_WAKE_MS, Date.parse(next) - this.#now().getTime()));
      await this.sleep(delay, signal);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.#wake === finish) this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#wake = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

function toolFailure(error: unknown): ToolExecutionResult {
  const code = error instanceof ReminderError ? error.code : "REMINDER_STORE_ERROR";
  const message = error instanceof ReminderError ? error.message : "the reminder store could not complete the operation";
  return {
    isError: true,
    output: [{ type: "text", text: `Reminder operation failed (${code}): ${message}` }],
    details: { code },
    diagnostics: [{ severity: "error", code, message }],
  };
}

function toolText(text: string, details: Record<string, string | number | boolean | null>): ToolExecutionResult {
  return { output: [{ type: "text", text }], details };
}

function formatReminder(reminder: Reminder): string {
  return `#${reminder.id} | ${reminder.status} | ${reminder.dueAt} | ${reminder.timezone} | ${reminder.content}`;
}

/**
 * Reminder tools. The target chat is captured from the host configuration once; it is never a
 * model parameter, so the model cannot redirect a reminder to another conversation.
 */
export function createReminderExtension(store: ReminderStore, options: { readonly chatId: string; readonly ownerId?: string }): Extension {
  const chatId = options.chatId;
  const ownerId = options.ownerId ?? options.chatId;
  const create = defineTool({
    name: "reminder_create",
    description: "Create a one-time reminder that the host will deliver to this Telegram conversation. trigger_at must be an ISO 8601 instant with an explicit offset or Z; timezone is an IANA name such as Asia/Shanghai. The host rejects past or out-of-range times.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 2_000 }),
      trigger_at: Type.String({ description: "ISO 8601 instant with an explicit offset or Z, e.g. 2026-11-05T09:00:00+08:00" }),
      timezone: Type.String({ maxLength: 64, description: "IANA time zone name, e.g. Asia/Shanghai" }),
    }, { additionalProperties: false }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = store.create({
          chatId,
          ownerId,
          content: args.content,
          triggerAt: args.trigger_at,
          timezone: args.timezone,
          idempotencyKey: `reminder-create:${String(api.conversationId)}:${api.callId}`,
        });
        const reminder = result.reminder;
        const text = result.created
          ? `Reminder #${reminder.id} stored for ${reminder.dueAt} (${reminder.timezone}), status pending.`
          : `Reminder #${reminder.id} was already stored for ${reminder.dueAt} (${reminder.timezone}), status ${reminder.status}.`;
        return toolText(text, { id: reminder.id, dueAt: reminder.dueAt, timezone: reminder.timezone, status: reminder.status, created: result.created });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });
  const list = defineTool({
    name: "reminder_list",
    description: "List this conversation's active reminders in due order. Set include_finished=true to append recent sent, failed, uncertain and cancelled reminders.",
    parameters: Type.Object({
      include_finished: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    replay: "safe",
    execute: async (args) => {
      try {
        const reminders = store.list(chatId, { includeFinished: args.include_finished === true });
        if (reminders.length === 0) return toolText("No reminders.", { count: 0 });
        return toolText(reminders.map(formatReminder).join("\n"), { count: reminders.length });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });
  const cancel = defineTool({
    name: "reminder_cancel",
    description: "Cancel a pending reminder by its numeric ID. A reminder already being sent or finished cannot be cancelled.",
    parameters: Type.Object({
      id: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: false }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const reminder = store.cancel(chatId, args.id);
        return toolText(`Reminder #${reminder.id} is ${reminder.status}.`, { id: reminder.id, status: reminder.status });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });
  return defineExtension({ name: "reminders", tools: [create, list, cancel] });
}
