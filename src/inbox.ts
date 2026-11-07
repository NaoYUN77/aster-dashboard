import { DatabaseSync } from "node:sqlite";
import { NotFoundError, StateError } from "./errors.js";
import type { TextRequest } from "./messages.js";
import { parseCatalogProfile, serializeCatalogProfile, parseToolScope, serializeToolScope, type CatalogProfile, type ToolScope } from "./tool-catalog.js";
import { migrateBotCatalog } from "./bot-catalog-migration.js";
import { CAPABILITY_IDS, type CapabilityId } from "./platform-capabilities.js";
import { INTEGRATION_IDS, type IntegrationId, type IntegrationRow } from "./integrations.js";
import type {
  ProvisioningRecord, ProvisioningSettlement, ProvisioningState,
} from "./bot-provisioner.js";

export type { ProvisioningRecord, ProvisioningSettlement } from "./bot-provisioner.js";

export interface Job extends TextRequest {
  status: "pending" | "ready" | "sent" | "failed" | "uncertain";
  reply: string | null;
  /** ISO 8601 UTC; null only for rows written before timestamps existed. */
  receivedAt: string | null;
  repliedAt: string | null;
}

export type BotStatus = "active" | "disabled" | "deleted";

export type BotRemovalKind = "delete" | "reset";

/**
 * One bot's accepted removal. The row is the durable intent, written when the operator asks and
 * long before the rows it names are touched: `report` stays null until a purge pass has removed
 * them, so a crash in between leaves retryable work instead of a forgotten delete. `error` keeps the
 * last failed attempt until a later one succeeds.
 */
export interface BotRemoval {
  readonly kind: BotRemovalKind;
  readonly requestedAt: string;
  readonly forced: boolean;
  readonly reason: string | null;
  readonly report: string | null;
  readonly error: string | null;
}

/**
 * One bot and the conversation it owns. `tools` is a comma-separated capability list (`bash`,
 * `files`, `web`) rather than free text, so the host can validate it instead of trusting a prompt.
 */
export interface BotRecord {
  botId: string;
  name: string;
  conversationId: string;
  systemPrompt: string;
  /** Compatibility projection for older readers; profile switches govern authorization. */
  tools: string;
  profile: CatalogProfile;
  toolScope: string;
  status: BotStatus;
  createdAt: string;
  /** Deployment-local tenant. Workspaces and credentials are never shared across this value. */
  userId: string;
  /** Null while the bot is live; set for the whole life of an accepted removal. */
  removal: BotRemoval | null;
}

export interface BotRegistration {
  botId: string;
  name: string;
  conversationId: string;
  systemPrompt: string;
  tools: string;
  profile: CatalogProfile;
  toolScope?: ToolScope;
  /** Host-assigned; never accepted from a browser body. Defaults to the single owner. */
  userId?: string;
}

// "ptc" stays a retired compatibility value for rows written before PTC was retired.
const BOT_TOOLS: ReadonlySet<string> = new Set(["bash", "files", "ptc", "web"]);
/** Bot ids are directory names under the workspace root, so the shape is fixed and short. */
export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function timestamp(): string {
  return new Date().toISOString();
}

export class Inbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // The dashboard console is the only ingress. Every table from earlier builds is still
    // created as-is: existing SQLite rows and their delivery/identity state are preserved, never
    // rewritten or replayed by this build. The console path only writes inbox, failures, bots,
    // bot_provisioning and integrations rows.
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
        conversationId TEXT NOT NULL UNIQUE,
        systemPrompt TEXT NOT NULL,
        tools TEXT NOT NULL,
        profile TEXT NOT NULL,
        toolScope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_provisioning (
        botId TEXT PRIMARY KEY REFERENCES bots(botId) ON DELETE CASCADE,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        manifestFingerprint TEXT NOT NULL,
        workspace TEXT,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        error TEXT,
        unavailable TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS integrations (
        service TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        requestId TEXT,
        requestedAt TEXT,
        updatedAt TEXT
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
    try {
      this.transaction(() => migrateBotCatalog(this.db));
    } catch (error) {
      this.db.close();
      throw error;
    }
    // Added only after a successful catalog upgrade, so a failed legacy conversion leaves the
    // original table byte-for-byte recoverable. An existing single-owner installation keeps its
    // one tenant; new rows can name another.
    addColumn(this.db, "bots", "userId", "TEXT NOT NULL DEFAULT 'owner'");
    // A removal is written here, on the bot row itself, so the intent survives a crash and a restart
    // without a second table to keep in step. `removalReport` is the only field a purge pass writes,
    // and its presence is what tells a later pass there is nothing left to do.
    addColumn(this.db, "bots", "removalKind", "TEXT");
    addColumn(this.db, "bots", "removalAt", "TEXT");
    addColumn(this.db, "bots", "removalForced", "INTEGER");
    addColumn(this.db, "bots", "removalReason", "TEXT");
    addColumn(this.db, "bots", "removalReport", "TEXT");
    addColumn(this.db, "bots", "removalError", "TEXT");
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
   * browser, so no delivery row is created and no external message is ever sent.
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

  /** Register the bootstrap bot without overwriting an operator's later edits. */
  ensureBot(registration: BotRegistration): BotRecord {
    validateBot(registration);
    const profile = serializeCatalogProfile(registration.profile);
    const toolScope = serializeToolScope(registration.toolScope ?? { allow: [], deny: [] });
    this.db.prepare(`INSERT OR IGNORE INTO bots (botId, name, conversationId, systemPrompt, tools, profile, toolScope, createdAt, userId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      registration.botId,
      registration.name,
      registration.conversationId,
      registration.systemPrompt,
      registration.tools,
      profile,
      toolScope,
      timestamp(),
      registration.userId ?? "owner",
    );
    return this.bot(registration.botId) as BotRecord;
  }

  createBot(registration: BotRegistration): BotRecord {
    validateBot(registration);
    if (this.bot(registration.botId) !== undefined) throw new StateError("Bot already exists");
    const profile = serializeCatalogProfile(registration.profile);
    const toolScope = serializeToolScope(registration.toolScope ?? { allow: [], deny: [] });
    this.db.prepare(`INSERT INTO bots (botId, name, conversationId, systemPrompt, tools, profile, toolScope, createdAt, userId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      registration.botId,
      registration.name,
      registration.conversationId,
      registration.systemPrompt,
      registration.tools,
      profile,
      toolScope,
      timestamp(),
      registration.userId ?? "owner",
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

  /** Bots belonging to one deployment-local tenant; a caller never enumerates another's. */
  botsForUser(userId: string): readonly BotRecord[] {
    return this.db.prepare("SELECT * FROM bots WHERE userId = ? ORDER BY rowid").all(userId).map(decodeBot);
  }

  // --- Zero-setup provisioning: one durable row per bot, written only inside BEGIN IMMEDIATE. ---

  /** An interrupted `provisioning` row is an unknown result; a new claim increments the attempt. */
  claimProvisioning(botId: string, fingerprint: string, startedAt: string): ProvisioningRecord {
    return this.transaction(() => {
      const previous = this.provisioning(botId);
      const attempt = (previous?.attempt ?? 0) + 1;
      this.db.prepare(`INSERT INTO bot_provisioning
        (botId, state, attempt, manifestFingerprint, workspace, startedAt, finishedAt, error, unavailable)
        VALUES (?, 'provisioning', ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(botId) DO UPDATE SET
          state = 'provisioning', attempt = excluded.attempt,
          manifestFingerprint = excluded.manifestFingerprint, workspace = excluded.workspace,
          startedAt = excluded.startedAt, finishedAt = NULL, error = NULL,
          unavailable = excluded.unavailable`).run(
        botId, attempt, fingerprint, previous?.workspace ?? null, startedAt,
        JSON.stringify(previous?.unavailable ?? []),
      );
      return this.provisioning(botId)!;
    });
  }

  finishProvisioning(botId: string, result: ProvisioningSettlement): ProvisioningRecord {
    return this.transaction(() => {
      if (this.provisioning(botId) === undefined) throw new StateError("Provisioning claim is missing");
      const changed = this.db.prepare(`UPDATE bot_provisioning SET state = ?, workspace = ?,
        finishedAt = ?, error = ?, unavailable = ? WHERE botId = ?`).run(
        result.state, result.workspace, result.finishedAt, result.error,
        JSON.stringify(result.unavailable), botId,
      );
      if (changed.changes !== 1) throw new StateError("Provisioning record not found");
      return this.provisioning(botId)!;
    });
  }

  provisioning(botId: string): ProvisioningRecord | undefined {
    const row = this.db.prepare("SELECT * FROM bot_provisioning WHERE botId = ?").get(botId);
    return row === undefined ? undefined : decodeProvisioning(row);
  }

  provisioningRecords(): readonly ProvisioningRecord[] {
    return this.db.prepare("SELECT * FROM bot_provisioning ORDER BY botId").all().map(decodeProvisioning);
  }

  // --- External integration state: this phase has no path that fabricates a connection. ---

  integrations(): readonly IntegrationRow[] {
    return this.db.prepare("SELECT * FROM integrations ORDER BY service").all().map(decodeIntegration);
  }

  setIntegration(row: IntegrationRow): void {
    if (!INTEGRATION_IDS.includes(row.service)) throw new StateError("Unknown external integration");
    if (!INTEGRATION_STATES.includes(row.state)) throw new StateError("Invalid integration state");
    // No OAuth flow exists yet. Refusing the write keeps the durable state honest even if a future
    // caller tries to shortcut the authorization step.
    if (row.state === "connected") throw new StateError("OAuth integration is not implemented; a service cannot be connected in this phase");
    this.transaction(() => {
      this.db.prepare(`INSERT INTO integrations (service, state, reason, requestId, requestedAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(service) DO UPDATE SET
          state = excluded.state, reason = excluded.reason, requestId = excluded.requestId,
          requestedAt = excluded.requestedAt, updatedAt = excluded.updatedAt`).run(
        row.service, row.state, row.reason, row.requestId, row.requestedAt, row.updatedAt,
      );
    });
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

  // --- Removal: one durable intent per bot, written before anything is deleted. ---

  /**
   * Record the operator's decision to remove one bot. Repeating a request is idempotent: the first
   * decision stands, and only an explicit `force` can be added to it later — an operator may need to
   * override an outcome the first request did not know about.
   */
  requestRemoval(botId: string, request: { readonly kind: BotRemovalKind; readonly force: boolean; readonly reason: string | null }): BotRecord {
    const bot = this.bot(botId);
    if (bot === undefined) throw new NotFoundError("Bot not found");
    const pending = bot.removal;
    if (pending !== null) {
      if (pending.report === null && request.force && !pending.forced) {
        this.db.prepare("UPDATE bots SET removalForced = 1 WHERE botId = ?").run(botId);
        return this.bot(botId) as BotRecord;
      }
      return bot;
    }
    this.db.prepare(`UPDATE bots SET status = ?, removalKind = ?, removalAt = ?, removalForced = ?,
      removalReason = ?, removalReport = NULL, removalError = NULL WHERE botId = ?`).run(
      request.kind === "delete" ? "deleted" : bot.status,
      request.kind,
      timestamp(),
      request.force ? 1 : 0,
      request.reason,
      botId,
    );
    return this.bot(botId) as BotRecord;
  }

  /** Accepted removals whose rows are still in the store, oldest first. */
  pendingRemovals(): readonly BotRecord[] {
    return this.db.prepare("SELECT * FROM bots WHERE removalKind IS NOT NULL AND removalReport IS NULL ORDER BY rowid")
      .all().map(decodeBot);
  }

  /** Mark one removal's rows as gone. Called only after the store reported them removed. */
  finishRemoval(botId: string, report: string): void {
    const changed = this.db.prepare("UPDATE bots SET removalReport = ?, removalError = NULL WHERE botId = ?").run(report, botId);
    if (changed.changes !== 1) throw new StateError("Bot not found");
  }

  /** Keep a failed pass visible until a later one succeeds; the intent itself stays pending. */
  failRemoval(botId: string, code: string): void {
    const changed = this.db.prepare("UPDATE bots SET removalError = ? WHERE botId = ?").run(code, botId);
    if (changed.changes !== 1) throw new StateError("Bot not found");
  }

  /** Drop a bot's provisioning row: a tombstone keeps the bot row, so no cascade ever runs for it. */
  removeProvisioning(botId: string): void {
    this.db.prepare("DELETE FROM bot_provisioning WHERE botId = ?").run(botId);
  }

  /**
   * Delete one bot's console requests and their delivery rows. Called by the removal pass once the
   * conversation's rows are gone, never at request time: the tombstone is immediate, but the user's
   * own message is part of what the reclaim erases, and a surviving row would also keep
   * `pendingForBot` permanently nonzero for an id that can never be used again.
   */
  deleteBotRequests(botId: string): { readonly requests: number; readonly deliveries: number; readonly failures: number } {
    const prefix = `${consoleRequestPrefix(botId)}%`;
    return this.transaction(() => {
      const count = (sql: string): number => Number((this.db.prepare(sql).get(prefix) as { count: number }).count);
      const requests = count("SELECT count(*) AS count FROM inbox WHERE requestId LIKE ?");
      const deliveries = count("SELECT count(*) AS count FROM deliveries WHERE requestId IN (SELECT requestId FROM inbox WHERE requestId LIKE ?)");
      const failures = count("SELECT count(*) AS count FROM failures WHERE requestId IN (SELECT requestId FROM inbox WHERE requestId LIKE ?)");
      // deliveries and failures reference inbox rows with ON DELETE CASCADE and this connection
      // enables foreign keys, so one delete removes the parts in the same transaction.
      this.db.prepare("DELETE FROM inbox WHERE requestId LIKE ?").run(prefix);
      return { requests, deliveries, failures };
    });
  }

  /** Reclaim free pages after rows were deleted. Safe only while no other process writes this file. */
  vacuum(): { readonly vacuumed: boolean; readonly error: string | null } {
    try {
      this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      this.db.exec("VACUUM");
      return { vacuumed: true, error: null };
    } catch (error) {
      return { vacuumed: false, error: error instanceof Error ? error.message : "unknown error" };
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
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

/** Normalize and validate a bot's capability list; `ptc` is a retired compatibility value. */
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
  if (Object.keys(registration).some((key) => !["botId", "name", "conversationId", "systemPrompt", "tools", "profile", "toolScope", "userId"].includes(key))) throw new StateError("Bot registration has unknown fields");
  if (!isBotId(registration.botId)) {
    throw new StateError("Bot id must be 1-32 lowercase letters, digits, '-' or '_'");
  }
  if (registration.name.trim() === "" || registration.name.length > 80) {
    throw new StateError("Bot name must be 1-80 characters");
  }
  if (registration.conversationId.trim() === "") throw new StateError("Bot conversation is required");
  if (registration.systemPrompt.length > 8_000) throw new StateError("Bot prompt must be at most 8000 characters");
  const tools = parseBotTools(registration.tools);
  if (tools !== registration.tools) throw new StateError("Bot tools must be normalized before storage");
  try {
    parseCatalogProfile(registration.profile);
    parseToolScope(registration.toolScope ?? { allow: [], deny: [] });
  } catch (error) { throw new StateError(error instanceof Error ? error.message : "Bot catalog is invalid"); }
}

/** Durable rows are untrusted at the storage boundary: an invalid enum is a host error, not a default. */
function decodeBot(row: object): BotRecord {
  const raw = row as Record<string, unknown>;
  if (!BOT_STATUSES.includes(String(raw.status))) throw new StateError("Invalid bot status");
  return Object.freeze({
    botId: String(raw.botId),
    name: String(raw.name),
    conversationId: String(raw.conversationId),
    systemPrompt: String(raw.systemPrompt),
    tools: String(raw.tools),
    profile: parseCatalogProfile(raw.profile),
    toolScope: String(raw.toolScope),
    status: raw.status as BotStatus,
    createdAt: String(raw.createdAt),
    userId: String(raw.userId),
    removal: decodeRemoval(raw),
  });
}

function decodeRemoval(raw: Record<string, unknown>): BotRemoval | null {
  if (raw.removalKind == null) return null;
  if (!REMOVAL_KINDS.includes(String(raw.removalKind))) throw new StateError("Invalid bot removal kind");
  const requestedAt = raw.removalAt;
  if (typeof requestedAt !== "string" || requestedAt === "") throw new StateError("Bot removal has no request time");
  const forced = Number(raw.removalForced ?? 0);
  if (forced !== 0 && forced !== 1) throw new StateError("Invalid bot removal flag");
  return Object.freeze({
    kind: raw.removalKind as BotRemovalKind,
    requestedAt,
    forced: forced === 1,
    reason: typeof raw.removalReason === "string" ? raw.removalReason : null,
    report: typeof raw.removalReport === "string" ? raw.removalReport : null,
    error: typeof raw.removalError === "string" ? raw.removalError : null,
  });
}

const BOT_STATUSES: readonly string[] = ["active", "disabled", "deleted"];
const REMOVAL_KINDS: readonly string[] = ["delete", "reset"];
const PROVISIONING_STATES: readonly string[] = ["provisioning", "ready", "degraded", "failed"];
const INTEGRATION_STATES: readonly string[] = ["disconnected", "authorization_pending", "connected"];

/** Durable rows are untrusted at the storage boundary: an invalid enum is a host error, not a default. */
function decodeProvisioning(row: object): ProvisioningRecord {
  const raw = row as Record<string, unknown>;
  if (!PROVISIONING_STATES.includes(String(raw.state))) throw new StateError("Invalid provisioning state");
  const attempt = Number(raw.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new StateError("Invalid provisioning attempt");
  return Object.freeze({
    botId: String(raw.botId),
    state: raw.state as ProvisioningState,
    attempt,
    manifestFingerprint: String(raw.manifestFingerprint),
    workspace: raw.workspace == null ? null : String(raw.workspace),
    startedAt: String(raw.startedAt),
    finishedAt: raw.finishedAt == null ? null : String(raw.finishedAt),
    error: raw.error == null ? null : String(raw.error),
    unavailable: decodeCapabilityIds(raw.unavailable),
  });
}

function decodeCapabilityIds(value: unknown): readonly CapabilityId[] {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof value === "string" ? value : "[]"); } catch { throw new StateError("Provisioning capabilities are invalid JSON"); }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !CAPABILITY_IDS.includes(id as CapabilityId))) {
    throw new StateError("Provisioning capabilities are invalid");
  }
  return Object.freeze([...parsed] as CapabilityId[]);
}

function decodeIntegration(row: object): IntegrationRow {
  const raw = row as Record<string, unknown>;
  if (!INTEGRATION_IDS.includes(raw.service as IntegrationId)) throw new StateError("Unknown external integration");
  if (!INTEGRATION_STATES.includes(String(raw.state))) throw new StateError("Invalid integration state");
  return Object.freeze({
    service: raw.service as IntegrationId,
    state: raw.state as IntegrationRow["state"],
    reason: String(raw.reason),
    requestId: raw.requestId == null ? null : String(raw.requestId),
    requestedAt: raw.requestedAt == null ? null : String(raw.requestedAt),
    updatedAt: raw.updatedAt == null ? null : String(raw.updatedAt),
  });
}

/** SQLite has no `ADD COLUMN IF NOT EXISTS`; re-running the migration must stay a no-op. */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
