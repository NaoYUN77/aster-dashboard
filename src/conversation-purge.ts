// Physical removal of one conversation's rows from the base's SQLite store.
//
// Interface: `openConversationPurger(path)` opens `agent.sqlite` read-write and returns
// `inspect(conversationId)` (a pure read: what a purge would remove and what blocks one),
// `purge(request)` (idempotent removal of one conversation) and `vacuum()`. This module is the one
// seam that knows the base's SQLite layout; `bot-manager.ts`, the startup path and the offline
// command call it through `ConversationPurger` and never write SQL of their own.
//
// Why it exists: pi-durable exposes no delete. `Storage` has no delete method (only `commit`, the
// reads, `mintId` and `close`), `Conversation.reset()` writes a `pi.reset` entry without removing
// anything, and the harness keeps every conversation open for the life of the process. So the host
// removes the rows itself and therefore owns the coupling to the base's schema: `durable_schema` and
// every table's exact column set are checked before every pass, and a layout this module does not
// recognize fails closed, never guessed at (1.4.0 moved SQLite to version 2 and a migrated database
// can no longer be opened by 1.3.0).
//
// Inputs: a durable numeric conversation id, a mode and `force`. `erase` removes the conversation
// row; `reset` empties a conversation but keeps its row (the reserved root conversation, which
// `Harness.root()` would otherwise recreate under a new id). No table name, path or scope ever
// comes from a caller.
//
// Boundary: only safe while no harness is open — service startup before `openAgent()`, or the
// offline operator command with the service stopped. `VACUUM` needs exclusive access and cannot run
// inside a transaction, which is why removal and reclaim are two steps in that same window.
//
// Force: `force` lifts every blocker here. Which blocker a caller is willing to present as forced is
// the caller's decision, because it depends on when the question is asked: a task that is still
// non-terminal while its process is running is work an operator can cancel first, while the same row
// at startup belongs to a process that has already stopped — an interrupted outcome nobody saw.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

export type ConversationPurgeMode = "erase" | "reset";

export interface ConversationPurgeRequest {
  readonly conversationId: string;
  readonly mode: ConversationPurgeMode;
  /** Accept an unexplained outcome, unfinished work and the removal of what inherits from it. */
  readonly force: boolean;
}

/** What one purge pass would remove, and what stops it. */
export interface ConversationInspection {
  readonly conversationId: string;
  /** Conversations whose rows a purge removes, including nested ones this conversation owns. */
  readonly closure: readonly string[];
  /** Conversations outside the closure that inherit history from inside it. */
  readonly dependents: readonly string[];
  /** Tasks that are not terminal, and submissions still queued or placed. */
  readonly liveTasks: number;
  readonly liveSubmissions: number;
  /** Terminal tasks whose outcome is not `completed`, plus `unanswered` submissions. */
  readonly unknownOutcomes: number;
}

export interface ConversationPurgeReport {
  readonly conversationId: string;
  readonly mode: ConversationPurgeMode;
  readonly forced: boolean;
  /** Conversations whose rows are gone; the reset target itself is not one of them. */
  readonly removed: readonly string[];
  /** Rows deleted per table, so a zero is explicit rather than a missing key. */
  readonly rows: Readonly<Record<PurgeTable, number>>;
  /** True when the requested conversation was already absent (a re-run after a finished purge). */
  readonly absent: boolean;
}

export type PurgeTable =
  | "document_revisions" | "documents" | "submissions" | "tasks" | "entries" | "conversations";

export const PURGE_TABLES: readonly PurgeTable[] = [
  "document_revisions", "documents", "submissions", "tasks", "entries", "conversations",
];

const CODES = [
  "SCHEMA_UNSUPPORTED", "CONVERSATION_ID_INVALID", "DATABASE_UNREADABLE",
  "WORK_IN_FLIGHT", "UNKNOWN_OUTCOME", "FORK_SURVIVOR", "ROW_LIMIT_EXCEEDED",
] as const;
export type ConversationPurgeCode = typeof CODES[number];

export class ConversationPurgeError extends Error {
  constructor(readonly code: ConversationPurgeCode, message: string, readonly detail: readonly string[] = []) {
    super(message);
    this.name = "ConversationPurgeError";
  }
}

/**
 * The conversation closure of one id: the conversation itself, whatever it owns through a task's
 * creator edge, and everything reachable that way. `dependent` is the other direction — conversations
 * that inherit history from the closure through a fork parent — and it is computed transitively
 * because a fork of a fork is lost just the same.
 *
 * The anchor reads the table rather than naming the id: an empty closure is how "already gone" is
 * recognized, and it must not be reachable by a caller asking about an id that was never there.
 */
const CLOSURE = `WITH RECURSIVE conv(id) AS (
    SELECT id FROM conversations WHERE id = ?
    UNION
    SELECT c.id FROM conversations c JOIN conv ON c.owner_conversation_id = conv.id
    UNION
    SELECT c.id FROM conversations c JOIN tasks t ON c.owner_task_id = t.id JOIN conv ON t.conversation_id = conv.id
  ),
  dependent(id) AS (
    SELECT c.id FROM conversations c JOIN conv ON json_extract(c.record, '$.parent.conversationId') = conv.id
    UNION
    SELECT c.id FROM conversations c JOIN dependent d ON json_extract(c.record, '$.parent.conversationId') = d.id
  )`;

/** Render one statement with the closure available to it. */
function query(extra: string): string {
  return `${CLOSURE} ${extra}`;
}

/**
 * Every table and every one of its columns, exactly as the supported schema defines them: the module
 * deletes by predicate over a layout it cannot validate through any API, so a column it did not
 * expect is a reason to refuse rather than to guess at what it means.
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  durable_schema: ["singleton", "version"],
  durable_metadata: ["singleton", "next_id", "next_seq"],
  record_ids: ["id", "record_type"],
  conversations: ["id", "owner_conversation_id", "owner_task_id", "record"],
  entries: ["id", "conversation_id", "head", "commit_seq", "record"],
  tasks: ["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"],
  submissions: ["id", "conversation_id", "request_id", "status", "record"],
  documents: ["id", "kind", "family", "key_value", "scope_kind", "owner_id", "created_at", "retired_at", "record"],
  document_revisions: ["document_id", "seq", "kind", "version", "content"],
});

/** Durable conversation ids are positive integers; a provisioning placeholder never is. */
export const DURABLE_CONVERSATION_ID = /^[1-9]\d*$/;
const MAX_CONVERSATION_ID = Number.MAX_SAFE_INTEGER;

/**
 * One purge's row budget. Past this the operation is refused before it deletes anything, so a
 * pathological conversation cannot hold the single startup window; the intent survives and the next
 * pass retries it.
 */
export const PURGE_ROW_LIMIT = 200_000;

/** One table's share of a purge: the predicate is written once so counting and deleting agree. */
type Step = {
  readonly table: PurgeTable;
  readonly predicate: string;
  readonly params: readonly number[];
};

/**
 * The rows one purge owns, in the order they must go: children before parents. The document
 * predicate selects conversation and task scopes — never `scope_kind = 'session'`, so a pinned tool
 * catalog or any other global document survives by construction rather than by an extra check.
 */
function steps(scope: string, keep: number): readonly Step[] {
  const documents = `(scope_kind = 'conversation' AND owner_id IN (${scope}))
          OR (scope_kind = 'task' AND owner_id IN (SELECT t.id FROM tasks t WHERE t.conversation_id IN (${scope})))`;
  return [
    { table: "document_revisions", predicate: `document_id IN (SELECT id FROM documents WHERE ${documents})`, params: [] },
    { table: "documents", predicate: documents, params: [] },
    { table: "submissions", predicate: `conversation_id IN (${scope})`, params: [] },
    { table: "tasks", predicate: `conversation_id IN (${scope})`, params: [] },
    { table: "entries", predicate: `conversation_id IN (${scope})`, params: [] },
    // A `reset` keeps the conversation row itself: an absent root is recreated under a new id by
    // `Harness.root()`, which is a new conversation rather than an emptied one.
    { table: "conversations", predicate: `id IN (${scope}) AND id <> ?`, params: [keep] },
  ];
}

const EMPTY_ROWS: Readonly<Record<PurgeTable, number>> = Object.freeze({
  document_revisions: 0, documents: 0, submissions: 0, tasks: 0, entries: 0, conversations: 0,
});

/**
 * The report for a conversation the store never held — a bot whose transcript was never created, or
 * one whose rows a previous pass already removed. Nothing was deleted, and nothing was wrong.
 */
export function emptyPurgeReport(conversationId: string, mode: ConversationPurgeMode): ConversationPurgeReport {
  return Object.freeze({ conversationId, mode, forced: false, removed: Object.freeze([]), rows: EMPTY_ROWS, absent: true });
}

export class SqliteConversationPurger {
  readonly #path: string;
  #db: DatabaseSync | undefined;
  #closed = false;

  private constructor(path: string, db: DatabaseSync | undefined) {
    this.#path = path;
    this.#db = db;
  }

  /**
   * Open the store. A store that does not exist yet has nothing to remove — the caller picks it up
   * later, once `openAgent()` has created and migrated it. A store that exists with no tables is the
   * same state: an empty file. Anything else must match the schema exactly.
   */
  static open(path: string): SqliteConversationPurger {
    if (!existsSync(path)) return new SqliteConversationPurger(path, undefined);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
      // Fail fast instead of waiting: another writer means the caller ignored the service lock.
      db.exec("PRAGMA busy_timeout = 0");
    } catch (error) {
      throw new ConversationPurgeError("DATABASE_UNREADABLE", `Conversation store is unreadable: ${reason(error)}`);
    }
    const purger = new SqliteConversationPurger(path, db);
    try {
      purger.#assertSchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return purger;
  }

  /** Report what a purge would remove and what blocks it. Reads only; safe with the service running. */
  inspect(conversationId: string): ConversationInspection {
    const id = this.#id(conversationId);
    const empty: ConversationInspection = Object.freeze({
      conversationId, closure: [], dependents: [], liveTasks: 0, liveSubmissions: 0, unknownOutcomes: 0,
    });
    const db = this.#handle();
    if (db === undefined) return empty;
    const closure = this.#ids(db, query("SELECT id FROM conv"), id);
    if (closure.length === 0) return empty;
    return Object.freeze({
      conversationId,
      closure: closure.map(String),
      dependents: this.#ids(db, query("SELECT id FROM dependent WHERE id NOT IN (SELECT id FROM conv)"), id).map(String),
      liveTasks: this.#count(db, query(`SELECT count(*) AS count FROM tasks
        WHERE conversation_id IN (SELECT id FROM conv) AND status <> 'terminal'`), id),
      liveSubmissions: this.#count(db, query(`SELECT count(*) AS count FROM submissions
        WHERE conversation_id IN (SELECT id FROM conv) AND status IN ('queued', 'placed')`), id),
      // A terminal task records its outcome; anything but `completed` is work whose result the host
      // never saw settle, and an `unanswered` submission is input that can no longer be answered.
      unknownOutcomes: this.#count(db, query(`SELECT count(*) AS count FROM tasks
        WHERE conversation_id IN (SELECT id FROM conv) AND status = 'terminal'
          AND json_extract(record, '$.state.outcome.status') <> 'completed'`), id)
        + this.#count(db, query(`SELECT count(*) AS count FROM submissions
          WHERE conversation_id IN (SELECT id FROM conv) AND status = 'unanswered'`), id),
    });
  }

  /**
   * Remove one conversation's rows. Idempotent: a conversation that is already gone reports `absent`
   * with zero rows instead of failing, so a re-run after a crash converges on the same state.
   */
  purge(request: ConversationPurgeRequest): ConversationPurgeReport {
    const id = this.#id(request.conversationId);
    const inspection = this.inspect(request.conversationId);
    if (!request.force) {
      if (inspection.liveTasks > 0 || inspection.liveSubmissions > 0) {
        throw new ConversationPurgeError("WORK_IN_FLIGHT",
          `Conversation ${request.conversationId} has unfinished work (${inspection.liveTasks} task(s), ${inspection.liveSubmissions} submission(s))`);
      }
      if (inspection.unknownOutcomes > 0) {
        throw new ConversationPurgeError("UNKNOWN_OUTCOME",
          `Conversation ${request.conversationId} has ${inspection.unknownOutcomes} record(s) with an unexplained outcome`);
      }
      if (inspection.dependents.length > 0) {
        throw new ConversationPurgeError("FORK_SURVIVOR",
          `Conversation ${request.conversationId} is inherited by ${inspection.dependents.length} conversation(s)`,
          inspection.dependents);
      }
    }
    const db = this.#handle();
    if (db === undefined || inspection.closure.length === 0) {
      return this.#report(request, [], EMPTY_ROWS, inspection.closure.length === 0);
    }
    // `force` also removes what inherits from this conversation: its history is going away, so a
    // fork left behind would be a conversation whose transcript cannot be read.
    const dependents = request.force
      ? this.#ids(db, query("SELECT id FROM dependent WHERE id NOT IN (SELECT id FROM conv)"), id)
      : [];
    const scope = request.force
      ? "SELECT id FROM conv UNION SELECT id FROM dependent"
      : "SELECT id FROM conv";
    const keep = request.mode === "reset" ? id : -1;
    const removed = [...inspection.closure, ...dependents.map(String)].filter((each) => Number(each) !== keep);
    const plan = steps(scope, keep);
    const rows: Record<PurgeTable, number> = { ...EMPTY_ROWS };
    this.#transaction(db, () => {
      // Size first: a row budget that fails must fail before a single row is gone, never halfway
      // through, or the intent would look finished on a store that only lost part of its rows.
      const planned = plan.reduce(
        (total, step) => total + this.#count(db, query(`SELECT count(*) AS count FROM ${step.table} WHERE ${step.predicate}`), id, ...step.params), 0,
      );
      if (planned > PURGE_ROW_LIMIT) {
        throw new ConversationPurgeError("ROW_LIMIT_EXCEEDED",
          `Conversation ${request.conversationId} holds ${planned} rows, above the ${PURGE_ROW_LIMIT} row limit`);
      }
      for (const step of plan) {
        rows[step.table] = this.#delete(db, query(`DELETE FROM ${step.table} WHERE ${step.predicate}`), id, ...step.params);
      }
      // `record_ids` and `durable_metadata` are not in this transaction at all: `mintId()` promises
      // ids greater than every id ever minted or stored, so the watermark must not roll back and the
      // identifier history must stay whole.
    });
    return this.#report(request, removed, rows, false);
  }

  /** Reclaim free pages once nothing else writes. A failure is reported, never fatal: the rows are gone. */
  vacuum(): { readonly vacuumed: boolean; readonly error: string | null } {
    const db = this.#handle();
    if (db === undefined) return { vacuumed: false, error: "no conversation store" };
    try {
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      db.exec("VACUUM");
      return { vacuumed: true, error: null };
    } catch (error) {
      return { vacuumed: false, error: reason(error) };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db?.close();
    this.#db = undefined;
  }

  #report(
    request: ConversationPurgeRequest, removed: readonly string[],
    rows: Readonly<Record<PurgeTable, number>>, absent: boolean,
  ): ConversationPurgeReport {
    return Object.freeze({
      conversationId: request.conversationId,
      mode: request.mode,
      forced: request.force,
      removed: Object.freeze([...removed]),
      rows: Object.freeze(rows),
      absent,
    });
  }

  /** The store's handle, opening it on first use when it did not exist yet. */
  #handle(): DatabaseSync | undefined {
    if (this.#closed) return undefined;
    if (this.#db !== undefined) return this.#db;
    if (!existsSync(this.#path)) return undefined;
    const db = new DatabaseSync(this.#path);
    db.exec("PRAGMA busy_timeout = 0");
    this.#assertSchema(db);
    this.#db = db;
    return db;
  }

  #id(conversationId: string): number {
    if (!DURABLE_CONVERSATION_ID.test(conversationId)) {
      throw new ConversationPurgeError("CONVERSATION_ID_INVALID", "Conversation id is not a durable record id");
    }
    const id = Number(conversationId);
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_CONVERSATION_ID) {
      throw new ConversationPurgeError("CONVERSATION_ID_INVALID", "Conversation id is out of range");
    }
    return id;
  }

  #ids(db: DatabaseSync, sql: string, ...params: readonly (number | string)[]): number[] {
    try {
      return (db.prepare(sql).all(...params) as { id: number }[]).map((row) => Number(row.id));
    } catch (error) {
      throw new ConversationPurgeError("DATABASE_UNREADABLE", `Conversation store read failed: ${reason(error)}`);
    }
  }

  #count(db: DatabaseSync, sql: string, ...params: readonly (number | string)[]): number {
    try {
      const row = db.prepare(sql).get(...params) as { count: number } | undefined;
      return row === undefined ? 0 : Number(row.count);
    } catch (error) {
      throw new ConversationPurgeError("DATABASE_UNREADABLE", `Conversation store read failed: ${reason(error)}`);
    }
  }

  #delete(db: DatabaseSync, sql: string, ...params: readonly (number | string)[]): number {
    try {
      return Number(db.prepare(sql).run(...params).changes);
    } catch (error) {
      throw new ConversationPurgeError("DATABASE_UNREADABLE", `Conversation store write failed: ${reason(error)}`);
    }
  }

  #transaction(db: DatabaseSync, operation: () => void): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
      throw error;
    }
  }

  /** An empty store has nothing of ours; any other store must match exactly. */
  #assertSchema(db: DatabaseSync): void {
    const tables = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get() as { count: number };
    if (Number(tables.count) === 0) return;
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const present = this.#columns(db, table);
      if (present === undefined) {
        throw new ConversationPurgeError("SCHEMA_UNSUPPORTED", `Conversation store has no ${table} table`);
      }
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0) {
        throw new ConversationPurgeError("SCHEMA_UNSUPPORTED", `Conversation store ${table} has no ${missing.join(", ")} column`);
      }
      // A column this build does not know is a layout it did not write: a newer base, or a migrated
      // store. Refusing is the whole point of the gate — the predicates below would still run, and
      // that is exactly the danger.
      const expected = new Set(columns);
      const extra = [...present].filter((column) => !expected.has(column));
      if (extra.length > 0) {
        throw new ConversationPurgeError("SCHEMA_UNSUPPORTED", `Conversation store ${table} has an unexpected ${extra.join(", ")} column`);
      }
    }
    const version = this.#count(db, "SELECT version AS count FROM durable_schema WHERE singleton = 1");
    if (version !== CURRENT_SQLITE_SCHEMA_VERSION) {
      throw new ConversationPurgeError("SCHEMA_UNSUPPORTED",
        `Conversation store schema version ${version} is not the supported version ${CURRENT_SQLITE_SCHEMA_VERSION}`);
    }
  }

  #columns(db: DatabaseSync, table: string): Set<string> | undefined {
    try {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return rows.length === 0 ? undefined : new Set(rows.map((row) => String(row.name)));
    } catch (error) {
      throw new ConversationPurgeError("DATABASE_UNREADABLE", `Conversation store schema is unreadable: ${reason(error)}`);
    }
  }
}

export type ConversationPurger = Pick<SqliteConversationPurger, "inspect" | "purge" | "vacuum" | "close">;

export function openConversationPurger(path: string): SqliteConversationPurger {
  return SqliteConversationPurger.open(path);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
