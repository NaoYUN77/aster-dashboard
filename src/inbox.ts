import { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.js";
import { splitReply, type TextRequest } from "./messages.js";

export interface Job extends TextRequest {
  status: "pending" | "ready" | "sent" | "failed" | "uncertain";
  reply: string | null;
  /** ISO 8601 UTC; null only for rows written before timestamps existed. */
  receivedAt: string | null;
  repliedAt: string | null;
}

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
    `);
    // Existing databases predate the timestamps. Adding a nullable column leaves those rows unknown
    // instead of backfilling them with a time the process never observed.
    addColumn(this.db, "inbox", "receivedAt", "TEXT");
    addColumn(this.db, "inbox", "repliedAt", "TEXT");
    addColumn(this.db, "deliveries", "createdAt", "TEXT");
    addColumn(this.db, "deliveries", "updatedAt", "TEXT");
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

  next(): Job | undefined {
    return this.db.prepare("SELECT * FROM inbox WHERE status IN ('pending', 'ready') ORDER BY rowid LIMIT 1").get() as Job | undefined;
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

/** SQLite has no `ADD COLUMN IF NOT EXISTS`; re-running the migration must stay a no-op. */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
