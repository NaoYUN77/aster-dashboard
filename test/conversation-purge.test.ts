// Contract tests for the one module that removes rows from the base's conversation store.
//
// These run against the schema the installed pi-durable itself creates, not a hand-written copy, and
// they are the first thing that should go red on a base upgrade: the purge writes SQL it has no API
// for, so its coupling to that schema is a contract, and a changed layout must fail closed rather
// than delete the wrong rows.
//
// What is asserted is the blast radius rather than the mechanism: other conversations, session-scoped
// documents, the identifier history and the id watermark survive; unfinished or unexplained work is
// refused unless it is forced; and what a crash leaves behind stays retryable instead of being
// silently dropped or reported as done.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { applySqliteMigrations, CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MAX_REMOVALS_PER_PASS, runPendingRemovals, type RemovalStore } from "../src/bot-removal.js";
import {
  ConversationPurgeError, openConversationPurger, PURGE_ROW_LIMIT, PURGE_TABLES, type ConversationPurger,
} from "../src/conversation-purge.js";
import type { BotRecord } from "../src/inbox.js";
import { startService, type ServiceHandle } from "../src/main.js";
import { DEFAULT_CATALOG_PROFILE } from "../src/tool-catalog.js";

/** Conversations and rows this suite writes itself, well above any id the base itself mints. */
const VICTIM = 900_101;
const OTHER_A = 900_102;
const OTHER_B = 900_103;
const FORK = 900_104;

const VICTIM_ENTRIES = [910_101, 910_102];
const VICTIM_TASK = 920_001;
const VICTIM_SUBMISSION = 930_001;
/** One document addressed to the victim's conversation and one to its task: both scopes go with it. */
const VICTIM_DOCUMENTS = [940_010, 940_014];
const SURVIVOR_DOCUMENTS = [940_011, 940_012, 940_013, 940_015];
const EMPTY_ROWS = { document_revisions: 0, documents: 0, submissions: 0, tasks: 0, entries: 0, conversations: 0 };

type FixtureCounts = {
  victimEntries: number; victimTasks: number; victimSubmissions: number; victimDocuments: number;
  victimConversation: number; otherEntries: number; otherConversations: number; otherTasks: number;
  survivorDocuments: number; survivorRevisions: number; identifiers: number; sessions: number;
};

/** What one conversation still owns, in the tables the purge writes. */
type ConversationRows = {
  conversations: number; entries: number; tasks: number; submissions: number; documents: number; revisions: number;
};

type StoreState = {
  readonly nextId: string;
  readonly identifiers: number;
  readonly schemaVersion: number;
  readonly sessionDocuments: readonly string[];
  readonly rows: Readonly<Record<string, ConversationRows>>;
};

/** A store with exactly the base's own schema, migrated by the base itself. */
async function emptyStore(directory: string): Promise<string> {
  const path = join(directory, "agent.sqlite");
  const database = await openNodeSqliteDatabase(path);
  await applySqliteMigrations(database);
  await database.close();
  return path;
}

/** One short-lived connection: nothing of the test's is open while the purger writes. */
function withStore<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function count(db: DatabaseSync, sql: string, ...params: readonly (number | string)[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

function inTransaction(db: DatabaseSync, run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Three conversations, each with entries, a settled task, a settled submission and documents — plus
 * the two Tool Ledger documents the scope rule exists for, and both document scopes belonging to a
 * survivor. Every id is also written to `record_ids` with its record type, as the base would.
 *
 * These raw rows are only for the tests that never hand the store back to the base: a conversation
 * record the base did not write is not a conversation the base can read.
 */
function seed(path: string): void {
  withStore(path, (db) => {
    const conversation = db.prepare("INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, NULL, NULL, ?)");
    const entry = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, 0, '{}')");
    const task = db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, 'run', ?, 0, 0, ?)");
    const submission = db.prepare("INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES (?, ?, NULL, 'done', '{}')");
    const document = db.prepare("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record) VALUES (?, ?, 0, ?, ?, ?, 0, NULL, '{}')");
    const revision = db.prepare("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, 0, 'base', 1, '{}')");
    const identifier = db.prepare("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, ?)");
    const completed = JSON.stringify({ state: { status: "terminal", outcome: { status: "completed", result: null } } });
    inTransaction(db, () => {
      for (const id of [VICTIM, OTHER_A, OTHER_B]) {
        conversation.run(id, JSON.stringify({ id }));
        identifier.run(id, "conversation");
      }
      for (const [id, owner] of [
        [VICTIM_ENTRIES[0]!, VICTIM], [VICTIM_ENTRIES[1]!, VICTIM], [910_103, OTHER_A], [910_104, OTHER_B],
      ] as const) {
        entry.run(id, owner);
        identifier.run(id, "entry");
      }
      for (const [id, owner] of [[VICTIM_TASK, VICTIM], [920_002, OTHER_A], [920_003, OTHER_B]] as const) {
        task.run(id, owner, "terminal", completed);
        identifier.run(id, "task");
      }
      for (const [id, owner] of [[VICTIM_SUBMISSION, VICTIM], [930_002, OTHER_A]] as const) {
        submission.run(id, owner);
        identifier.run(id, "submission");
      }
      const documents: readonly (readonly [number, string, string, number, string])[] = [
        [940_010, "personal.tools.loads", "conversation", VICTIM, "victim-loads"],
        [940_011, "personal.tools.catalog", "session", 0, "session-catalog"],
        [940_012, "personal.tools.loads", "conversation", OTHER_A, "survivor-loads"],
        [940_013, "pi.agent", "conversation", OTHER_A, "survivor-agent"],
        [940_014, "task.note", "task", VICTIM_TASK, "victim-task"],
        [940_015, "task.note", "task", 920_002, "survivor-task"],
      ];
      for (const [id, kind, scope, owner, key] of documents) {
        document.run(id, kind, key, scope, owner);
        revision.run(id);
        identifier.run(id, "document");
      }
    });
  });
}

async function storeWithFixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pa-purge-"));
  const path = await emptyStore(directory);
  seed(path);
  return { directory, path };
}

function fixtureCounts(db: DatabaseSync): FixtureCounts {
  return {
    victimEntries: count(db, "SELECT count(*) AS count FROM entries WHERE conversation_id = ?", VICTIM),
    victimTasks: count(db, "SELECT count(*) AS count FROM tasks WHERE conversation_id = ?", VICTIM),
    victimSubmissions: count(db, "SELECT count(*) AS count FROM submissions WHERE conversation_id = ?", VICTIM),
    victimDocuments: count(db, "SELECT count(*) AS count FROM documents WHERE id IN (?, ?)", ...VICTIM_DOCUMENTS),
    victimConversation: count(db, "SELECT count(*) AS count FROM conversations WHERE id = ?", VICTIM),
    otherEntries: count(db, "SELECT count(*) AS count FROM entries WHERE conversation_id IN (?, ?)", OTHER_A, OTHER_B),
    otherConversations: count(db, "SELECT count(*) AS count FROM conversations WHERE id IN (?, ?)", OTHER_A, OTHER_B),
    otherTasks: count(db, "SELECT count(*) AS count FROM tasks WHERE conversation_id IN (?, ?)", OTHER_A, OTHER_B),
    survivorDocuments: count(db, "SELECT count(*) AS count FROM documents WHERE id IN (?, ?, ?, ?)", ...SURVIVOR_DOCUMENTS),
    survivorRevisions: count(db, "SELECT count(*) AS count FROM document_revisions WHERE document_id IN (?, ?, ?, ?)", ...SURVIVOR_DOCUMENTS),
    identifiers: count(db, "SELECT count(*) AS count FROM record_ids"),
    sessions: count(db, "SELECT count(*) AS count FROM documents WHERE scope_kind = 'session'"),
  };
}

const ALL_PRESENT: FixtureCounts = {
  victimEntries: 2, victimTasks: 1, victimSubmissions: 1, victimDocuments: 2, victimConversation: 1,
  otherEntries: 2, otherConversations: 2, otherTasks: 2,
  survivorDocuments: 4, survivorRevisions: 4, identifiers: 18, sessions: 1,
};

const ERASED: FixtureCounts = {
  ...ALL_PRESENT,
  victimEntries: 0, victimTasks: 0, victimSubmissions: 0, victimDocuments: 0, victimConversation: 0,
};

function assertCounts(path: string, expected: FixtureCounts): void {
  withStore(path, (db) => assert.deepEqual(fixtureCounts(db), expected));
}

function conversationRows(db: DatabaseSync, conversationId: number): ConversationRows {
  return {
    conversations: count(db, "SELECT count(*) AS count FROM conversations WHERE id = ?", conversationId),
    entries: count(db, "SELECT count(*) AS count FROM entries WHERE conversation_id = ?", conversationId),
    tasks: count(db, "SELECT count(*) AS count FROM tasks WHERE conversation_id = ?", conversationId),
    submissions: count(db, "SELECT count(*) AS count FROM submissions WHERE conversation_id = ?", conversationId),
    documents: count(db, "SELECT count(*) AS count FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?", conversationId),
    revisions: count(db, `SELECT count(*) AS count FROM document_revisions
      WHERE document_id IN (SELECT id FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?)`, conversationId),
  };
}

/** Everything a purge must not move, side by side with the rows it is allowed to remove. */
function storeState(path: string, conversations: readonly string[]): StoreState {
  return withStore(path, (db) => Object.freeze({
    nextId: (db.prepare("SELECT next_id FROM durable_metadata WHERE singleton = 1").get() as { next_id: string }).next_id,
    identifiers: count(db, "SELECT count(*) AS count FROM record_ids"),
    schemaVersion: count(db, "SELECT version AS count FROM durable_schema WHERE singleton = 1"),
    sessionDocuments: (db.prepare(`SELECT d.id AS id, (SELECT count(*) FROM document_revisions r WHERE r.document_id = d.id) AS revisions
      FROM documents d WHERE d.scope_kind = 'session' ORDER BY d.id`).all() as { id: number; revisions: number }[])
      .map((row) => `${row.id}:${row.revisions}`),
    rows: Object.freeze(Object.fromEntries(conversations.map((id) => [id, conversationRows(db, Number(id))]))),
  }));
}

function emptyConversationRows(): ConversationRows {
  return { conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0, revisions: 0 };
}

test("erasing one conversation leaves every other row, the session documents and the id history", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-purge-live-"));
  let service: ServiceHandle | undefined;
  try {
    // Real rows, minted and written by the base: this store is handed back to the base below, so
    // nothing in it may be something the base could not have written.
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);
    const conversations: Record<string, string> = {};
    for (const botId of ["alpha", "beta", "gamma"]) {
      const created = await console.call("/api/bots", { name: botId, botId });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      conversations[botId] = created.body.bot.conversationId as string;
      await ask(console, botId, `我的名字是 ${botId}`);
    }
    await service.close();
    service = undefined;

    const path = join(directory, "agent.sqlite");
    const victim = conversations.alpha!;
    const survivors = [conversations.beta!, conversations.gamma!];
    const before = storeState(path, [victim, ...survivors]);
    // The scenario is only meaningful if the victim holds something in every table the purge writes.
    const victimBefore = before.rows[victim]!;
    assert.equal(victimBefore.conversations, 1);
    assert.ok(victimBefore.entries >= 2, `expected a transcript, got ${victimBefore.entries} entries`);
    assert.ok(victimBefore.tasks >= 1, "expected a task");
    assert.ok(victimBefore.submissions >= 1, "expected a submission");
    assert.ok(victimBefore.documents >= 2, `expected pi.agent and the Tool Ledger, got ${victimBefore.documents}`);
    assert.ok(victimBefore.revisions >= 2);
    assert.ok(before.sessionDocuments.length >= 1, "expected the session-scoped tool catalog");
    assert.ok(survivors.every((id) => before.rows[id]!.entries >= 2));

    const purger = openConversationPurger(path);
    const report = purger.purge({ conversationId: victim, mode: "erase", force: false });
    purger.close();

    assert.equal(report.absent, false);
    assert.equal(report.forced, false);
    assert.deepEqual(report.removed, [victim]);
    // The report counts the rows that were there; it cannot overstate what it did.
    assert.deepEqual(report.rows, {
      conversations: victimBefore.conversations,
      entries: victimBefore.entries,
      tasks: victimBefore.tasks,
      submissions: victimBefore.submissions,
      documents: victimBefore.documents,
      document_revisions: victimBefore.revisions,
    });

    const after = storeState(path, [victim, ...survivors]);
    // Gone: the conversation, its transcript, its work records and its scoped documents together.
    assert.deepEqual(after.rows[victim], emptyConversationRows());
    // Untouched: every other conversation, row for row, including their own documents and revisions.
    for (const id of survivors) assert.deepEqual(after.rows[id], before.rows[id], `conversation ${id}`);
    // Untouched: a session-scoped document belongs to the deployment, not to a conversation.
    assert.deepEqual(after.sessionDocuments, before.sessionDocuments);
    // Untouched: the identifier history and the watermark. `mintId()` promises ids above every id
    // ever minted or stored, so a rolled-back watermark would hand the same id out twice.
    assert.equal(after.identifiers, before.identifiers);
    assert.equal(after.nextId, before.nextId);
    assert.equal(after.schemaVersion, before.schemaVersion);
    withStore(path, (db) => {
      // The history stays: it is what makes the deleted id one that can never be handed out again.
      assert.equal(count(db, "SELECT count(*) AS count FROM record_ids WHERE id = ?", Number(victim)), 1);
    });

    // The base reopens the store it no longer has those rows in. A purge that left it unreadable
    // would be worse than the leak it fixed; a full service restart over a purged store is covered
    // by the deletion suite.
    const storage = await openNodeSqliteStorage(path);
    try {
      const page = await storage.scanConversations({}, 100, undefined, BACKGROUND_CONTEXT);
      const present = page.items.map((item: { id: number }) => String(item.id));
      assert.ok(!present.includes(victim), "the base must not see the conversation it no longer holds");
      for (const id of survivors) assert.ok(present.includes(id), `conversation ${id} must still be readable`);
      const minted = Number(await storage.mintId());
      const highest = withStore(path, (db) => Number((db.prepare("SELECT max(id) AS highest FROM record_ids").get() as { highest: number }).highest));
      assert.ok(minted > highest, `the next id (${minted}) must be above every id ever stored (${highest})`);
      assert.ok(minted > Number(victim));
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a reset empties the root conversation and keeps its row, so the deployment keeps its identity", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-purge-reset-"));
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);
    const rootId = (await console.call("/api/bots")).body.bots[0].conversationId as string;
    await ask(console, "default", "记住这句话");
    await service.close();
    service = undefined;

    const path = join(directory, "agent.sqlite");
    const before = storeState(path, [rootId]);
    assert.ok(before.rows[rootId]!.entries > 0, "the conversation must have content before a reset proves anything");

    const purger = openConversationPurger(path);
    const report = purger.purge({ conversationId: rootId, mode: "reset", force: false });
    purger.close();
    assert.deepEqual(report.rows, {
      conversations: 0, entries: before.rows[rootId]!.entries, tasks: before.rows[rootId]!.tasks,
      submissions: before.rows[rootId]!.submissions, documents: before.rows[rootId]!.documents,
      document_revisions: before.rows[rootId]!.revisions,
    });
    assert.deepEqual(report.removed, [], "a reset never reports the conversation it keeps");
    assert.deepEqual(storeState(path, [rootId]).rows[rootId], { ...emptyConversationRows(), conversations: 1 },
      "only the conversation row survives");

    // `ensureBot` must find the same conversation again rather than allocate a second transcript.
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const restarted = consoleOf(service);
    const bots = (await restarted.call("/api/bots")).body.bots;
    assert.equal(bots.length, 1);
    assert.equal(bots[0].conversationId, rootId);
    assert.equal(bots[0].status, "active");
    const history = await restarted.call("/api/bots/default/history?limit=50");
    assert.deepEqual(history.body.messages.filter((message: { role: string }) => message.role === "user"), []);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a second purge of the same conversation reports it absent instead of failing", async () => {
  const { directory, path } = await storeWithFixture();
  try {
    const purger = openConversationPurger(path);
    purger.purge({ conversationId: String(VICTIM), mode: "erase", force: false });
    assert.equal(purger.inspect(String(VICTIM)).closure.length, 0);
    const again = purger.purge({ conversationId: String(VICTIM), mode: "erase", force: false });
    // An id the store never held is absent too, not an error and not a delete of something else.
    const unknown = purger.purge({ conversationId: "899999", mode: "erase", force: false });
    purger.close();
    assert.equal(again.absent, true);
    assert.deepEqual(again.removed, []);
    for (const table of PURGE_TABLES) assert.equal(again.rows[table], 0, table);
    assert.equal(unknown.absent, true);
    assert.deepEqual(unknown.removed, []);
    assertCounts(path, ERASED);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an unrecognized store is refused before anything is deleted", async () => {
  const { directory, path } = await storeWithFixture();
  try {
    // A column the base does not have: exactly the shape a newer base could leave behind.
    withStore(path, (db) => db.exec("ALTER TABLE conversations ADD COLUMN tenant TEXT"));
    assert.throws(() => openConversationPurger(path), (error: unknown) => {
      assert.ok(error instanceof ConversationPurgeError);
      assert.equal(error.code, "SCHEMA_UNSUPPORTED");
      return true;
    });
    assertCounts(path, ALL_PRESENT);

    // A version this build does not implement is refused the same way, layout intact or not.
    withStore(path, (db) => {
      db.exec("ALTER TABLE conversations DROP COLUMN tenant");
      db.prepare("UPDATE durable_schema SET version = ? WHERE singleton = 1").run(CURRENT_SQLITE_SCHEMA_VERSION + 1);
    });
    assert.throws(() => openConversationPurger(path), (error: unknown) => {
      assert.ok(error instanceof ConversationPurgeError);
      assert.equal(error.code, "SCHEMA_UNSUPPORTED");
      return true;
    });
    assertCounts(path, ALL_PRESENT);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("unfinished work is refused, and only an explicit force gets past an unexplained outcome", async () => {
  const { directory, path } = await storeWithFixture();
  try {
    withStore(path, (db) => {
      db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, 'run', 'running', 0, 0, '{}')")
        .run(920_010, VICTIM);
    });
    const purger = openConversationPurger(path);
    assert.throws(() => purger.purge({ conversationId: String(VICTIM), mode: "erase", force: false }), (error: unknown) => {
      assert.ok(error instanceof ConversationPurgeError);
      assert.equal(error.code, "WORK_IN_FLIGHT");
      return true;
    });
    assert.equal(purger.inspect(String(VICTIM)).liveTasks, 1);
    assertCounts(path, { ...ALL_PRESENT, victimTasks: 2 });

    // The same row after the process that owned it stopped is unexplained rather than unfinished: it
    // is still refused by default, but `force` is the operator's only way out of that dead end.
    withStore(path, (db) => {
      db.prepare("UPDATE tasks SET status = 'terminal', record = ? WHERE id = ?")
        .run(JSON.stringify({ state: { status: "terminal", outcome: { status: "aborted" } } }), 920_010);
    });
    assert.equal(purger.inspect(String(VICTIM)).unknownOutcomes, 1);
    assert.throws(() => purger.purge({ conversationId: String(VICTIM), mode: "erase", force: false }), (error: unknown) => {
      assert.ok(error instanceof ConversationPurgeError);
      assert.equal(error.code, "UNKNOWN_OUTCOME");
      return true;
    });
    const forced = purger.purge({ conversationId: String(VICTIM), mode: "erase", force: true });
    purger.close();
    assert.equal(forced.forced, true);
    assert.equal(forced.rows.tasks, 2, "the interrupted task goes with the conversation it belongs to");
    assertCounts(path, ERASED);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a conversation that inherits from the one being removed is refused until it is forced", async () => {
  const { directory, path } = await storeWithFixture();
  try {
    withStore(path, (db) => {
      db.prepare("INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, NULL, NULL, ?)")
        .run(FORK, JSON.stringify({ id: FORK, parent: { conversationId: VICTIM } }));
    });
    const purger = openConversationPurger(path);
    assert.deepEqual(purger.inspect(String(VICTIM)).dependents, [String(FORK)]);
    assert.throws(() => purger.purge({ conversationId: String(VICTIM), mode: "erase", force: false }), (error: unknown) => {
      assert.ok(error instanceof ConversationPurgeError);
      assert.equal(error.code, "FORK_SURVIVOR");
      assert.deepEqual(error.detail, [String(FORK)]);
      return true;
    });
    assertCounts(path, ALL_PRESENT);
    const forced = purger.purge({ conversationId: String(VICTIM), mode: "erase", force: true });
    purger.close();
    assert.deepEqual([...forced.removed].sort(), [String(VICTIM), String(FORK)].sort());
    assert.equal(withStore(path, (db) => count(db, "SELECT count(*) AS count FROM conversations WHERE id = ?", FORK)), 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a conversation past the row budget is refused whole, not partly deleted", { timeout: 180_000 }, async () => {
  const { directory, path } = await storeWithFixture();
  try {
    const extra = PURGE_ROW_LIMIT + 1;
    withStore(path, (db) => {
      const entry = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, 0, '{}')");
      inTransaction(db, () => {
        for (let index = 0; index < extra; index += 1) entry.run(1_000_000 + index, OTHER_B);
      });
    });
    const purger = openConversationPurger(path);
    assert.throws(() => purger.purge({ conversationId: String(OTHER_B), mode: "erase", force: false }), (error: unknown) => {
      assert.ok(error instanceof ConversationPurgeError);
      assert.equal(error.code, "ROW_LIMIT_EXCEEDED");
      return true;
    });
    purger.close();
    // Nothing of that conversation is gone: a partial delete would leave an intent that looks done.
    assert.equal(withStore(path, (db) => count(db, "SELECT count(*) AS count FROM entries WHERE conversation_id = ?", OTHER_B)), extra + 1);
    assert.equal(withStore(path, (db) => count(db, "SELECT count(*) AS count FROM conversations WHERE id = ?", OTHER_B)), 1);
    assert.equal(withStore(path, (db) => count(db, "SELECT count(*) AS count FROM entries WHERE conversation_id = ?", VICTIM)), 2);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a removal pass is bounded and says so instead of dropping the rest", () => {
  const pending = bannerBots(MAX_REMOVALS_PER_PASS + 1);
  const finished: string[] = [];
  const purged: string[] = [];
  const lines: string[] = [];
  const store = fakeStore({
    pending,
    onFinish: (botId) => finished.push(botId),
    onFail: (botId, code) => lines.push(`${botId}:${code}`),
  });
  const purger = absentPurger((request) => purged.push(request.conversationId));
  const pass = runPendingRemovals({ store, purger, log: (line) => lines.push(line) });

  assert.equal(pass.pending, MAX_REMOVALS_PER_PASS + 1);
  assert.equal(pass.deferred, 1);
  assert.equal(purged.length, MAX_REMOVALS_PER_PASS);
  assert.equal(finished.length, MAX_REMOVALS_PER_PASS);
  assert.equal(pass.outcomes.length, MAX_REMOVALS_PER_PASS);
  assert.ok(pass.outcomes.every((outcome) => outcome.state === "absent"));
  // The bound is not a silent drop: the remainder is named for the operator and kept for next time.
  assert.ok(lines.some((line) => line.includes(`${MAX_REMOVALS_PER_PASS + 1} pending removals`)), lines.join("\n"));
  assert.equal(pass.deferred, pending.length - pass.outcomes.length);
});

test("a removal that cannot be carried out fails loudly and stays pending", () => {
  const finished: string[] = [];
  const failed: string[] = [];
  const bots = bannerBots(1);
  const store = fakeStore({ pending: bots, onFinish: (botId) => finished.push(botId), onFail: (botId, code) => failed.push(`${botId}:${code}`) });
  const purger: ConversationPurger = {
    inspect: () => ({ conversationId: String(VICTIM), closure: [String(VICTIM)], dependents: [], liveTasks: 0, liveSubmissions: 0, unknownOutcomes: 0 }),
    purge: () => { throw new ConversationPurgeError("SCHEMA_UNSUPPORTED", "nope"); },
    vacuum: () => ({ vacuumed: true, error: null }),
    close: () => undefined,
  };
  const pass = runPendingRemovals({ store, purger, log: () => {} });
  assert.deepEqual(pass.outcomes.map((outcome) => outcome.state), ["failed"]);
  assert.equal(pass.outcomes[0]?.code, "SCHEMA_UNSUPPORTED");
  // `finishRemoval` is the only thing that ends an intent's life, and it was never called.
  assert.deepEqual(finished, []);
  assert.deepEqual(failed, [`${bots[0]!.botId}:SCHEMA_UNSUPPORTED`]);
  assert.equal(pass.vacuumed, false, "nothing was removed, so nothing is reclaimed");
});

/** Tombstones as the store hands them over: durable-looking conversation ids, one per bot. */
function bannerBots(total: number): BotRecord[] {
  return Array.from({ length: total }, (_, index) => ({
    botId: `bot-${index}`,
    name: `Bot ${index}`,
    conversationId: String(900_000 + index),
    systemPrompt: "",
    tools: "",
    profile: DEFAULT_CATALOG_PROFILE,
    toolScope: "{}",
    status: "deleted" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    userId: "owner",
    removal: { kind: "delete" as const, requestedAt: "2026-01-01T00:00:00.000Z", forced: false, reason: null, report: null, error: null },
  }));
}

function fakeStore(options: {
  readonly pending: readonly BotRecord[];
  readonly onFinish: (botId: string) => void;
  readonly onFail: (botId: string, code: string) => void;
}): RemovalStore {
  return {
    pendingRemovals: () => options.pending,
    removeProvisioning: () => undefined,
    deleteBotRequests: () => ({ requests: 0, deliveries: 0, failures: 0 }),
    finishRemoval: options.onFinish,
    failRemoval: options.onFail,
    vacuum: () => ({ vacuumed: false, error: null }),
  };
}

/** A purger that finds nothing to remove, recording what it was asked to remove. */
function absentPurger(onPurge: (request: { conversationId: string }) => void): ConversationPurger {
  return {
    inspect: (conversationId) => ({ conversationId, closure: [], dependents: [], liveTasks: 0, liveSubmissions: 0, unknownOutcomes: 0 }),
    purge: (request) => {
      onPurge(request);
      return { conversationId: request.conversationId, mode: request.mode, forced: request.force, removed: [], rows: EMPTY_ROWS, absent: true };
    },
    vacuum: () => ({ vacuumed: false, error: null }),
    close: () => undefined,
  };
}

function environment(dataDir: string): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dataDir,
    TELEGRAM_ENABLED: "0",
    CONSOLE_ENABLED: "1",
    WEB_TOKEN: "{{SECRET_5xpdbsvp}}",
    CONSOLE_HOST: "127.0.0.1",
    CONSOLE_PORT: "0",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "faux",
    MEMORY_ENABLED: "0",
  };
}

function scriptedProvider() {
  const faux = fauxProvider({ provider: "openai" });
  faux.setResponses(Array.from({ length: 32 }, () => () => fauxAssistantMessage("OK")));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

function consoleOf(service: ServiceHandle) {
  const port = service.console?.port;
  assert.ok(port !== undefined, "the console must be listening");
  return {
    call: async (path: string, body?: unknown, method?: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { authorization: "Bearer {{SECRET_5xpdbsvp}}", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    },
  };
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function ask(console: ReturnType<typeof consoleOf>, botId: string, text: string): Promise<void> {
  const accepted = await console.call(`/api/bots/${botId}/messages`, { text });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  await waitFor(`an answer from ${botId}`, async () => {
    const history = await console.call(`/api/bots/${botId}/history?limit=50`);
    return history.body.messages.some((message: { role: string }) => message.role === "assistant") ? true : undefined;
  });
}
