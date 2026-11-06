import { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.js";
import { splitReply, type TextRequest } from "./messages.js";
import { profileForRole, parseCatalogProfile, serializeCatalogProfile, parseToolScope, serializeToolScope, type CatalogProfile, type ToolScope } from "./tool-catalog.js";

export interface Job extends TextRequest {
  status: "pending" | "ready" | "sent" | "failed" | "uncertain";
  reply: string | null;
  /** ISO 8601 UTC; null only for rows written before timestamps existed. */
  receivedAt: string | null;
  repliedAt: string | null;
}

/** Legacy role metadata, used only to supply defaults when no catalog profile was provided. */
export type BotRole = "assistant" | "researcher" | "programmer";

export type BotStatus = "active" | "disabled";

/**
 * One bot and the conversation it owns. `tools` is a comma-separated capability list (`bash`,
 * `files`, `ptc`, `web`) rather than free text, so the host can validate it instead of trusting a prompt.
 */
export interface BotRecord {
  botId: string;
  name: string;
  role: BotRole;
  conversationId: string;
  systemPrompt: string;
  /** Legacy capability projection retained for configureBot and older clients. */
  tools: string;
  profile: CatalogProfile;
  toolScope: string;
  status: BotStatus;
  createdAt: string;
}

export interface BotRegistration {
  botId: string;
  name: string;
  role: BotRole;
  conversationId: string;
  systemPrompt: string;
  tools: string;
  /** Optional to keep direct legacy Inbox callers source-compatible. */
  profile?: CatalogProfile;
  toolScope?: ToolScope;
}

const BOT_ROLES: ReadonlySet<string> = new Set(["assistant", "researcher", "programmer"]);
const BOT_TOOLS: ReadonlySet<string> = new Set(["bash", "files", "ptc", "web"]);
/** Bot ids are directory names under the workspace root, so the shape is fixed and short. */
export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface Delivery {
  requestId: string;
  part: number;
  text: string;
  status: "pending" | "sending" | "sent" | "failed" | "uncertain";
  messageId: string | null;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function timestamp(): string {
  return new Date().toISOString();
}

export class Inbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL);
      INSERT OR IGNORE INTO checkpoint VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK (id = 1), botId TEXT NOT NULL, ownerId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        requestId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        senderId TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reply TEXT,
        receivedAt TEXT,
        repliedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        requestId TEXT NOT NULL REFERENCES inbox(requestId) ON DELETE CASCADE,
        part INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        messageId TEXT,
        error TEXT,
        createdAt TEXT,
        updatedAt TEXT,
        PRIMARY KEY (requestId, part)
      );
      CREATE TABLE IF NOT EXISTS failures (
        requestId TEXT PRIMARY KEY REFERENCES inbox(requestId) ON DELETE CASCADE,
        code TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bots (
        botId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        conversationId TEXT NOT NULL UNIQUE,
        systemPrompt TEXT NOT NULL,
        tools TEXT NOT NULL,
        profile TEXT,
        toolScope TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt TEXT NOT NULL
      );
    `);
    // Existing databases predate the timestamps. Adding a nullable column leaves those rows unknown
    // instead of backfilling them with a time the process never observed.
    addColumn(this.db, "inbox", "receivedAt", "TEXT");
    addColumn(this.db, "inbox", "repliedAt", "TEXT");
    addColumn(this.db, "deliveries", "createdAt", "TEXT");
    addColumn(this.db, "deliveries", "updatedAt", "TEXT");
    addColumn(this.db, "bots", "profile", "TEXT");
    addColumn(this.db, "bots", "toolScope", "TEXT");
    // Only legacy rows are migrated; an explicit switch pack survives every subsequent startup.
    this.transaction(() => {
      const legacy = this.db.prepare(`SELECT botId, role, profile FROM bots
        WHERE profile IS NULL OR profile = '' OR profile IN ('research', 'chief', 'programmer')`).all();
      const update = this.db.prepare("UPDATE bots SET profile = ? WHERE botId = ?");
      for (const row of legacy) {
        const role = row.profile === "research" ? "researcher"
          : row.profile === "chief" ? "assistant"
          : row.profile === "programmer" ? "programmer" : row.role;
        if (role !== "assistant" && role !== "researcher" && role !== "programmer") throw new StateError("Bot role is invalid during catalog migration");
        if (typeof row.botId !== "string") throw new StateError("Bot id is invalid during catalog migration");
        update.run(serializeCatalogProfile(profileForRole(role)), row.botId);
      }
      this.db.prepare("UPDATE bots SET toolScope = '{\"allow\":[],\"deny\":[]}' WHERE toolScope IS NULL OR toolScope = ''").run();
    });
  }

  bindIdentity(botId: string, ownerId: string): void {
    const previous = this.db.prepare("SELECT botId, ownerId FROM identity WHERE id = 1").get();
    if (previous && (previous.botId !== botId || previous.ownerId !== ownerId)) {
      throw new StateError("Data directory belongs to another Telegram bot or owner; use a separate DATA_DIR");
    }
    this.db.prepare("INSERT OR IGNORE INTO identity VALUES (1, ?, ?)").run(botId, ownerId);
  }

  recover(): void {
    this.transaction(() => {
      this.db.prepare("UPDATE deliveries SET status = 'uncertain', error = 'PROCESS_INTERRUPTED' WHERE status = 'sending'").run();
      this.db.prepare(`UPDATE inbox SET status = 'uncertain' WHERE status = 'sending'
        OR requestId IN (SELECT requestId FROM deliveries WHERE status = 'uncertain')`).run();
      // Earlier MVP builds saved whole replies without per-part records.
      const legacy = this.db.prepare(`SELECT requestId, reply FROM inbox WHERE status = 'ready'
        AND requestId NOT IN (SELECT requestId FROM deliveries)`).all();
      for (const row of legacy) this.insertParts(String(row.requestId), String(row.reply));
    });
  }

  get offset(): number {
    return (this.db.prepare("SELECT offset FROM checkpoint WHERE id = 1").get() as { offset: number }).offset;
  }

  accept(nextOffset: number, request?: TextRequest): void {
    this.transaction(() => {
      if (request) {
        const existing = this.db.prepare("SELECT * FROM inbox WHERE requestId = ?").get(request.requestId);
        if (existing && (existing.text !== request.text || existing.conversationId !== request.conversationId || existing.senderId !== request.senderId)) {
          throw new Error("Request ID reused with different content");
        }
        this.db.prepare(`INSERT OR IGNORE INTO inbox (requestId, conversationId, senderId, text, receivedAt)
          VALUES (?, ?, ?, ?, ?)`).run(request.requestId, request.conversationId, request.senderId, request.text, timestamp());
      }
      // Telegram can randomize update IDs after an idle week; do not use MAX(offset).
      this.db.prepare("UPDATE checkpoint SET offset = ? WHERE id = 1").run(nextOffset);
    });
  }

  /** Telegram's queue: console requests are answered by their bot worker, never sent to a chat. */
  next(): Job | undefined {
    return this.db.prepare(`SELECT * FROM inbox WHERE status IN ('pending', 'ready')
      AND requestId NOT LIKE 'console:%' ORDER BY rowid LIMIT 1`).get() as Job | undefined;
  }

  /**
   * The next request a bot's own worker should answer. Ordering by rowid keeps one bot's requests
   * in arrival order; each bot has its own queue, so two bots run at the same time.
   */
  nextForBot(botId: string): Job | undefined {
    return this.db.prepare(`SELECT * FROM inbox WHERE status = 'pending' AND requestId LIKE ?
      ORDER BY rowid LIMIT 1`).get(`${consoleRequestPrefix(botId)}%`) as Job | undefined;
  }

  /** Durably accept a console request before the console answers its caller. */
  acceptConsole(request: TextRequest): void {
    const botId = consoleRequestBot(request.requestId);
    if (botId === undefined || request.senderId !== "console") {
      throw new StateError("A console request must be addressed to one bot");
    }
    this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM inbox WHERE requestId = ?").get(request.requestId);
      if (existing && (existing.text !== request.text || existing.conversationId !== request.conversationId)) {
        throw new StateError("Request ID reused with different content");
      }
      this.db.prepare(`INSERT OR IGNORE INTO inbox (requestId, conversationId, senderId, text, receivedAt)
        VALUES (?, ?, ?, ?, ?)`).run(request.requestId, request.conversationId, request.senderId, request.text, timestamp());
    });
  }

  /**
   * A console reply is terminal at once: it is read back from the conversation and streamed to the
   * browser, so no delivery row is created and no part is ever sent to Telegram.
   */
  saveConsoleReply(requestId: string, reply: string, errorCode?: string): void {
    const text = reply.trim() ? reply : "(no reply)";
    this.transaction(() => {
      const changed = this.db.prepare(`UPDATE inbox SET reply = ?, status = 'sent', repliedAt = ?
        WHERE requestId = ? AND status = 'pending'`).run(text, timestamp(), requestId);
      if (changed.changes !== 1) throw new StateError("Reply already saved or request missing");
      if (errorCode) this.db.prepare("INSERT INTO failures VALUES (?, ?)").run(requestId, errorCode);
    });
  }

  /** A withdrawn console request is terminal; it is never executed later. */
  cancelConsole(requestId: string): boolean {
    const changed = this.db.prepare(`UPDATE inbox SET status = 'failed' WHERE requestId = ? AND status = 'pending'`)
      .run(requestId);
    return changed.changes === 1;
  }

  /** Requests this bot still has to answer, including the one its worker is running. */
  pendingForBot(botId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM inbox WHERE status = 'pending' AND requestId LIKE ?`)
      .get(`${consoleRequestPrefix(botId)}%`) as { count: number };
    return Number(row.count);
  }

  consoleRequests(botId: string, limit = 20): Job[] {
    return this.db.prepare(`SELECT * FROM inbox WHERE requestId LIKE ? ORDER BY rowid DESC LIMIT ?`)
      .all(`${consoleRequestPrefix(botId)}%`, limit) as unknown as Job[];
  }

  /** The bot this request belongs to, from its own request id; never from a caller-supplied field. */
  botOfRequest(requestId: string): BotRecord | undefined {
    const botId = consoleRequestBot(requestId);
    if (botId !== undefined) return this.bot(botId);
    const job = this.db.prepare("SELECT conversationId FROM inbox WHERE requestId = ?").get(requestId);
    return job === undefined ? undefined : this.botByConversation(String(job.conversationId));
  }

  /** Register the bootstrap bot without overwriting an operator's later edits. */
  ensureBot(registration: BotRegistration): BotRecord {
    validateBot(registration);
    const profile = serializeCatalogProfile(registration.profile === undefined ? profileForRole(registration.role) : registration.profile);
    const toolScope = serializeToolScope(registration.toolScope ?? { allow: [], deny: [] });
    this.db.prepare(`INSERT OR IGNORE INTO bots (botId, name, role, conversationId, systemPrompt, tools, profile, toolScope, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      registration.botId,
      registration.name,
      registration.role,
      registration.conversationId,
      registration.systemPrompt,
      registration.tools,
      profile,
      toolScope,
      timestamp(),
    );
    return this.bot(registration.botId) as BotRecord;
  }

  createBot(registration: BotRegistration): BotRecord {
    validateBot(registration);
    if (this.bot(registration.botId) !== undefined) throw new StateError("Bot already exists");
    const profile = serializeCatalogProfile(registration.profile === undefined ? profileForRole(registration.role) : registration.profile);
    const toolScope = serializeToolScope(registration.toolScope ?? { allow: [], deny: [] });
    this.db.prepare(`INSERT INTO bots (botId, name, role, conversationId, systemPrompt, tools, profile, toolScope, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      registration.botId,
      registration.name,
      registration.role,
      registration.conversationId,
      registration.systemPrompt,
      registration.tools,
      profile,
      toolScope,
      timestamp(),
    );
    return this.bot(registration.botId) as BotRecord;
  }

  bot(botId: string): BotRecord | undefined {
    const row = this.db.prepare("SELECT * FROM bots WHERE botId = ?").get(botId);
    return row === undefined ? undefined : decodeBot(row);
  }

  botByConversation(conversationId: string): BotRecord | undefined {
    const row = this.db.prepare("SELECT * FROM bots WHERE conversationId = ?").get(conversationId);
    return row === undefined ? undefined : decodeBot(row);
  }

  bots(): BotRecord[] {
    return this.db.prepare("SELECT * FROM bots ORDER BY rowid").all().map(decodeBot);
  }

  /** Point a bot at the conversation its durable transcript actually lives in. */
  setBotConversation(botId: string, conversationId: string): void {
    this.db.prepare("UPDATE bots SET conversationId = ? WHERE botId = ?").run(conversationId, botId);
  }

  setBotStatus(botId: string, status: BotStatus): void {
    const changed = this.db.prepare("UPDATE bots SET status = ? WHERE botId = ?").run(status, botId);
    if (changed.changes !== 1) throw new StateError("Bot not found");
  }
  setBotTools(botId: string, tools: string): void {
    const normalized = parseBotTools(tools);
    this.db.prepare(`UPDATE bots SET tools = ? WHERE botId = ?`).run(normalized, botId);
  }

  setBotCatalog(botId: string, profile: CatalogProfile, toolScope: ToolScope): void {
    const scope = serializeToolScope(toolScope);
    const changed = this.db.prepare("UPDATE bots SET profile = ?, toolScope = ? WHERE botId = ?").run(serializeCatalogProfile(profile), scope, botId);
    if (changed.changes !== 1) throw new StateError("Bot not found");
  }


  saveReply(requestId: string, reply: string, errorCode?: string): void {
    if (!reply.trim()) throw new Error("Cannot deliver an empty reply");
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE inbox SET reply = ?, status = 'ready', repliedAt = ? WHERE requestId = ? AND status = 'pending'").run(reply, timestamp(), requestId);
      if (changed.changes !== 1) throw new Error("Reply already saved or request missing");
      this.insertParts(requestId, reply);
      if (errorCode) this.db.prepare("INSERT INTO failures VALUES (?, ?)").run(requestId, errorCode);
    });
  }

  nextPart(requestId: string): Delivery | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE requestId = ? AND status = 'pending' ORDER BY part LIMIT 1").get(requestId) as Delivery | undefined;
  }

  beginPart(requestId: string, part: number): void {
    const now = timestamp();
    const changed = this.db.prepare("UPDATE deliveries SET status = 'sending', error = NULL, updatedAt = ? WHERE requestId = ? AND part = ? AND status = 'pending'").run(now, requestId, part);
    if (changed.changes !== 1) throw new Error("Delivery part is not pending");
  }

  confirmPart(requestId: string, part: number, messageId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE deliveries SET status = 'sent', messageId = ?, error = NULL, updatedAt = ? WHERE requestId = ? AND part = ?").run(messageId, timestamp(), requestId, part);
      this.finishIfDelivered(requestId);
    });
  }

  failPart(requestId: string, part: number, status: "failed" | "uncertain", error: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE deliveries SET status = ?, error = ?, updatedAt = ? WHERE requestId = ? AND part = ?").run(status, error, timestamp(), requestId, part);
      this.db.prepare("UPDATE inbox SET status = ? WHERE requestId = ?").run(status, requestId);
    });
  }

  blocked() {
    return this.db.prepare(`SELECT i.requestId, i.status, d.part, d.messageId, d.error, i.receivedAt, d.updatedAt
      FROM inbox i LEFT JOIN deliveries d ON d.requestId = i.requestId AND d.status IN ('failed', 'uncertain')
      WHERE i.status IN ('failed', 'uncertain') ORDER BY i.rowid, d.part`).all();
  }

  diagnostics() {
    return this.db.prepare("SELECT requestId, code FROM failures ORDER BY rowid DESC LIMIT 100").all();
  }

  resolvePart(requestId: string, part: number, action: "retry" | "sent"): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT status FROM deliveries WHERE requestId = ? AND part = ?").get(requestId, part);
      if (!row || !["failed", "uncertain"].includes(String(row.status))) throw new Error("Part is not failed or uncertain");
      this.db.prepare("UPDATE deliveries SET status = ?, error = NULL, updatedAt = ? WHERE requestId = ? AND part = ?").run(action === "retry" ? "pending" : "sent", timestamp(), requestId, part);
      this.db.prepare("UPDATE inbox SET status = 'ready' WHERE requestId = ?").run(requestId);
      this.finishIfDelivered(requestId);
    });
  }

  prune(): void {
    // Retain the newest 100 sent requests for local diagnostics; unfinished requests are never pruned.
    // Deliveries and failures go with their request through ON DELETE CASCADE.
    this.db.prepare(`DELETE FROM inbox WHERE status = 'sent' AND requestId NOT IN
      (SELECT requestId FROM inbox WHERE status = 'sent' ORDER BY rowid DESC LIMIT 100)`).run();
  }

  close(): void {
    this.db.close();
  }

  private insertParts(requestId: string, reply: string): void {
    const now = timestamp();
    const insert = this.db.prepare("INSERT INTO deliveries (requestId, part, text, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)");
    splitReply(reply).forEach((text, part) => insert.run(requestId, part, text, now, now));
  }

  private finishIfDelivered(requestId: string): void {
    this.db.prepare(`UPDATE inbox SET status = 'sent' WHERE requestId = ?
      AND NOT EXISTS (SELECT 1 FROM deliveries WHERE requestId = ? AND status != 'sent')`).run(requestId, requestId);
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Request ids name their channel and their bot, so a queue is never shared by accident. */
export function consoleRequestPrefix(botId: string): string {
  if (!BOT_ID_PATTERN.test(botId)) throw new StateError("Bot id is invalid");
  return `console:${botId}:`;
}

/** The bot id inside a console request id, or undefined when this is not a console request. */
export function consoleRequestBot(requestId: string): string | undefined {
  const match = /^console:([a-z0-9][a-z0-9_-]{0,31}):[A-Za-z0-9-]{8,64}$/.exec(requestId);
  return match?.[1];
}

/** Normalize and validate a bot's capability list: `bash`, `files`, `ptc`, `web`, comma separated. */
export function parseBotTools(value: unknown): string {
  if (typeof value !== "string") throw new StateError("Bot tools must be a comma-separated string");
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter((name) => name !== ""))];
  for (const name of names) {
    if (!BOT_TOOLS.has(name)) throw new StateError(`Unknown bot tool: ${name.slice(0, 32)}`);
  }
  // Order is fixed by the host, so the same capability set is always stored the same way.
  return ["bash", "files", "ptc", "web"].filter((name) => names.includes(name)).join(",");
}

export function isBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID_PATTERN.test(value);
}

function validateBot(registration: BotRegistration): void {
  if (!isBotId(registration.botId)) {
    throw new StateError("Bot id must be 1-32 lowercase letters, digits, '-' or '_'");
  }
  if (registration.name.trim() === "" || registration.name.length > 80) {
    throw new StateError("Bot name must be 1-80 characters");
  }
  if (!BOT_ROLES.has(registration.role)) throw new StateError("Bot role must be assistant, researcher or programmer");
  if (registration.conversationId.trim() === "") throw new StateError("Bot conversation is required");
  if (registration.systemPrompt.length > 8_000) throw new StateError("Bot prompt must be at most 8000 characters");
  const tools = parseBotTools(registration.tools);
  if (tools !== registration.tools) throw new StateError("Bot tools must be normalized before storage");
  try {
    parseCatalogProfile(registration.profile === undefined ? profileForRole(registration.role) : registration.profile);
    parseToolScope(registration.toolScope ?? { allow: [], deny: [] });
  } catch (error) { throw new StateError(error instanceof Error ? error.message : "Bot catalog is invalid"); }
}

function decodeBot(row: object): BotRecord {
  const stored = row as Omit<BotRecord, "profile"> & { profile: unknown };
  return { ...stored, profile: parseCatalogProfile(stored.profile) };
}

/** SQLite has no `ADD COLUMN IF NOT EXISTS`; re-running the migration must stay a no-op. */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
