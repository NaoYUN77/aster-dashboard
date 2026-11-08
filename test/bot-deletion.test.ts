// Acceptance for the operator's removal surface: what DELETE /api/bots/:id accepts, what it refuses,
// what a restart does with an accepted intent, and what the offline pass does with the same store.
//
// Everything here goes through the real HTTP route, the real service composition and the real
// conversation store. Two things are asserted over and over: a response never claims the rows are
// gone before they are (the tombstone is immediate, the reclaim is not), and a refusal is a condition
// the operator can act on rather than a dead end — which is the difference between `work_in_flight`
// and `unknown_outcome`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BotPurgeError, purgeBots } from "../src/bot-purge.js";
import { startService, type ServiceHandle } from "../src/main.js";

const TOKEN = "{{SECRET_5xpdbsvp}}";
const MODEL = "faux-1";

function environment(dataDir: string): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dataDir,
    TELEGRAM_ENABLED: "0",
    CONSOLE_ENABLED: "1",
    WEB_TOKEN: TOKEN,
    CONSOLE_HOST: "127.0.0.1",
    CONSOLE_PORT: "0",
    MODEL_PROVIDER: "openai",
    MODEL_ID: MODEL,
    OPENAI_API_KEY: "faux",
    MEMORY_ENABLED: "0",
  };
}

function scriptedProvider() {
  const faux = fauxProvider({ provider: "openai" });
  faux.setResponses(Array.from({ length: 64 }, () => () => fauxAssistantMessage("OK")));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

/**
 * A provider whose first answer waits for `release()`. The run is genuinely in flight — the harness
 * has a running task for it — which is the only honest way to test the "a run owns this bot" refusal.
 */
function gatedProvider() {
  const faux = fauxProvider({ provider: "openai" });
  let open!: () => void;
  const gate = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    open = () => resolve(fauxAssistantMessage("OK"));
  });
  let gated = true;
  faux.setResponses([
    () => (gated ? gate : fauxAssistantMessage("OK")),
    ...Array.from({ length: 32 }, () => () => fauxAssistantMessage("OK")),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, release: () => { gated = false; open(); } };
}

type Console = {
  call(path: string, body?: unknown, method?: string): Promise<{ status: number; body: any }>;
};

function consoleOf(service: ServiceHandle): Console {
  const port = service.console?.port;
  assert.ok(port !== undefined, "the console must be listening");
  return {
    call: async (path: string, body?: unknown, method?: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

function read<T>(path: string, run: (db: DatabaseSync) => T): T {
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

/** What the conversation store still holds for one conversation, as the purge contract sees it. */
function storeRows(dataDir: string, conversationId: string) {
  const id = Number(conversationId);
  return read(join(dataDir, "agent.sqlite"), (db) => ({
    conversations: count(db, "SELECT count(*) AS count FROM conversations WHERE id = ?", id),
    entries: count(db, "SELECT count(*) AS count FROM entries WHERE conversation_id = ?", id),
    tasks: count(db, "SELECT count(*) AS count FROM tasks WHERE conversation_id = ?", id),
    submissions: count(db, "SELECT count(*) AS count FROM submissions WHERE conversation_id = ?", id),
    documents: count(db, "SELECT count(*) AS count FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?", id),
  }));
}

function botRequests(dataDir: string, botId: string): number {
  return read(join(dataDir, "inbox.sqlite"),
    (db) => count(db, "SELECT count(*) AS count FROM inbox WHERE requestId LIKE ?", `console:${botId}:%`));
}

function botRow(dataDir: string, botId: string): Record<string, unknown> | undefined {
  return read(join(dataDir, "inbox.sqlite"),
    (db) => db.prepare("SELECT status, removalKind, removalAt, removalForced, removalReason, removalError, removalReport FROM bots WHERE botId = ?")
      .get(botId) as Record<string, unknown> | undefined);
}

/**
 * The offline command as an operator runs it: its own process, its own lock claim. "Somebody else owns
 * this directory" cannot be observed from inside the process that owns it, so the refusal is exercised
 * by invoking the real entry point rather than by calling `purgeBots` in-process.
 */
async function offlineCommand(dataDir: string): Promise<{ exitCode: number | null; report: any; stderr: string }> {
  const root = join(import.meta.dirname, "..");
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "src", "bot-purge.ts"), "--data-dir", dataDir], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  // The command prints its report on success and its refusal code on the error stream; both are one JSON line.
  const text = exitCode === 0 ? stdout : stderr;
  const line = text.trim().split("\n").filter((entry) => entry !== "").at(-1) ?? "{}";
  return { exitCode, report: JSON.parse(line) as unknown, stderr };
}

/**
 * A work row the harness did not write. It is the same shape the base stores, so the purger's
 * predicates read it exactly as they read the base's own — which is what makes an "unfinished" or
 * "unexplained" conversation testable without racing a real run.
 */
function injectTask(dataDir: string, conversationId: string, taskId: number, status: "running" | "terminal", outcome = "aborted"): void {
  const record = status === "terminal"
    ? JSON.stringify({ state: { status: "terminal", outcome: { status: outcome, result: null } } })
    : JSON.stringify({ state: { status: "running" } });
  read(join(dataDir, "agent.sqlite"), (db) => {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, 'run', ?, 0, 0, ?)")
      .run(taskId, Number(conversationId), status, record);
  });
}

/** Send one message and wait for its answer, so the conversation is settled work rather than a run. */
async function ask(console: Console, botId: string, text: string): Promise<void> {
  const accepted = await console.call(`/api/bots/${botId}/messages`, { text });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  await waitFor(`an answer from ${botId}`, async () => {
    const history = await console.call(`/api/bots/${botId}/history?limit=50`);
    return history.body.messages.some((message: { role: string }) => message.role === "assistant") ? true : undefined;
  });
}

test("a deletion is a tombstone first and a reclaim later, and the answer says so", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-deletion-"));
  const logs: string[] = [];
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const console = consoleOf(service);
    const rootId = (await console.call("/api/bots")).body.bots[0].conversationId as string;

    const created = await console.call("/api/bots", { name: "Alpha", botId: "alpha" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const conversationId = created.body.bot.conversationId as string;
    await ask(console, "alpha", "这份记录会被删掉");
    // A file the user put in the bot's own directory: removal must not touch the workspace.
    const workspace = join(directory, "workspaces", "alpha");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "keep.txt"), "user data\n", "utf8");
    assert.ok(storeRows(directory, conversationId).entries > 0);
    assert.equal(botRequests(directory, "alpha"), 1);

    // --- The removal answers before the rows are gone, and does not claim otherwise. ---
    const removed = await console.call("/api/bots/alpha", {}, "DELETE");
    assert.equal(removed.status, 202, JSON.stringify(removed.body));
    assert.equal(removed.body.removal.kind, "delete");
    assert.equal(removed.body.removal.state, "pending_purge");
    assert.equal(removed.body.removal.forced, false);
    assert.equal(removed.body.bot.status, "deleted");
    assert.match(removed.body.note, /reclaimed at the next service start/);
    assert.doesNotMatch(removed.body.note, /erased|wiped|from the store/i);
    // The proof that the note is not a figure of speech: the rows are still there right now.
    assert.ok(storeRows(directory, conversationId).entries > 0, "the tombstone must not delete anything");

    const listed = await console.call("/api/bots");
    assert.deepEqual(listed.body.bots.map((bot: { botId: string }) => bot.botId), ["default"]);
    assert.equal((await console.call("/api/platform")).body.pendingPurge, 1);

    // A removed bot is gone for every other route, and its id never comes back.
    for (const [path, method, body] of [
      ["/api/bots/alpha/messages", "POST", { text: "在吗" }],
      ["/api/bots/alpha/cancel", "POST", {}],
      ["/api/bots/alpha/retry", "POST", {}],
      ["/api/bots/alpha/history", "GET", undefined],
      // The event stream answers like its siblings: a removed bot is refused before the stream opens,
      // rather than being given a 200 whose first frame is an error.
      ["/api/bots/alpha/events", "GET", undefined],
    ] as const) {
      const answer = await console.call(path, body, method);
      assert.equal(answer.status, 410, `${method} ${path}`);
      assert.equal(answer.body.error, "bot_deleted");
    }
    const reused = await console.call("/api/bots", { name: "Alpha again", botId: "alpha" });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error, "bot_id_retired");

    // --- Repeating the decision repeats the answer, never the work. ---
    const repeated = await console.call("/api/bots/alpha", {}, "DELETE");
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.removal.requestedAt, removed.body.removal.requestedAt);
    assert.equal(repeated.body.removal.state, "pending_purge");
    assert.equal((await console.call("/api/platform")).body.pendingPurge, 1, "a repeat must not queue a second removal");

    await service.close();
    service = undefined;

    // --- The reclaim happens in the window between two processes. ---
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const restarted = consoleOf(service);
    assert.ok(logs.some((line) => line.includes("Bot removed: alpha")), logs.join("\n"));
    assert.equal((await restarted.call("/api/platform")).body.pendingPurge, 0);
    assert.deepEqual(storeRows(directory, conversationId), { conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 });
    assert.equal(botRequests(directory, "alpha"), 0, "the user's own message text must not outlive the bot");
    const tombstone = botRow(directory, "alpha");
    assert.equal(tombstone?.status, "deleted");
    assert.equal(tombstone?.removalError, null);
    assert.match(String(tombstone?.removalReport), /document_revisions/);
    // The other conversation and the workspace file are untouched.
    assert.equal((await restarted.call("/api/bots")).body.bots.length, 1);
    assert.equal((await restarted.call("/api/bots")).body.bots[0].conversationId, rootId);
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "user data\n");
    // A repeat pass over the finished removal changes nothing.
    const again = await service.close().then(() => purgeBots({ dataDir: directory }));
    assert.equal(again.pending, 0);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the reserved bot is reset, not deleted: same bot row, same conversation, empty transcript", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-reset-"));
  const logs: string[] = [];
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const console = consoleOf(service);
    const rootId = (await console.call("/api/bots")).body.bots[0].conversationId as string;
    await ask(console, "default", "记住这句话");
    const before = storeRows(directory, rootId);
    assert.ok(before.entries > 0);

    const reset = await console.call("/api/bots/default", {}, "DELETE");
    assert.equal(reset.status, 202, JSON.stringify(reset.body));
    assert.equal(reset.body.removal.kind, "reset");
    assert.equal(reset.body.removal.state, "pending_purge");
    assert.equal(reset.body.bot.status, "active", "a reset is not a tombstone");
    assert.equal(reset.body.bot.conversationId, rootId);

    const listed = await console.call("/api/bots");
    assert.deepEqual(listed.body.bots.map((bot: { botId: string }) => bot.botId), ["default"]);
    assert.equal(listed.body.bots[0].removal.kind, "reset");

    await service.close();
    service = undefined;

    // The root row survives, so `Harness.root()` finds this conversation instead of creating one.
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const restarted = consoleOf(service);
    assert.equal((await restarted.call("/api/platform")).body.pendingPurge, 0);
    const bots = (await restarted.call("/api/bots")).body.bots;
    assert.equal(bots.length, 1);
    assert.equal(bots[0].conversationId, rootId, "a reset must keep the deployment's transcript identity");
    assert.equal(bots[0].status, "active");
    assert.ok(["ready", "degraded"].includes(bots[0].provisioning.state));
    assert.equal(storeRows(directory, rootId).conversations, 1);
    assert.equal(storeRows(directory, rootId).entries, 0);
    const history = await restarted.call("/api/bots/default/history?limit=50");
    assert.deepEqual(history.body.messages.filter((message: { role: string }) => message.role === "user"), []);
    // The id is not retired: the reserved bot still exists, so its own id is still in use.
    assert.equal((await restarted.call("/api/bots/default/history?limit=50")).status, 200);
    assert.equal(botRow(directory, "default")?.removalKind, "reset");
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a run in progress, and input nobody is left to answer, are each refused by name", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-busy-"));
  const gated = gatedProvider();
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: gated.models, log: () => {} });
    const console = consoleOf(service);
    const created = await console.call("/api/bots", { name: "Busy", botId: "busy" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await console.call("/api/bots/busy/messages", { text: "慢慢想" });

    // A running bot is refused, and the refusal is actionable: cancel the run and ask again.
    const running = await waitFor("the run to start", async () => {
      const bot = (await console.call("/api/bots")).body.bots.find((entry: { botId: string }) => entry.botId === "busy");
      return bot?.running !== null ? bot : undefined;
    });
    assert.ok(running, "the bot must report its live run");
    const duringRun = await console.call("/api/bots/busy", {}, "DELETE");
    assert.equal(duringRun.status, 409);
    assert.equal(duringRun.body.error, "bot_is_running");

    // Let the run finish, then take the workers away: a pending row with no worker is exactly what an
    // answered-nowhere request looks like, and it must be refused rather than silently deleted.
    gated.release();
    await waitFor("the run to end", async () => {
      const bot = (await console.call("/api/bots")).body.bots.find((entry: { botId: string }) => entry.botId === "busy");
      return bot !== undefined && bot.running === null && bot.pending === 0 ? true : undefined;
    });
    await service.bots.close();
    const queued = await console.call("/api/bots", { name: "Queued", botId: "queued" });
    assert.equal(queued.status, 201, JSON.stringify(queued.body));
    assert.equal((await console.call("/api/bots/queued/messages", { text: "有人在吗" })).status, 202);

    const pending = await console.call("/api/bots/queued", {}, "DELETE");
    assert.equal(pending.status, 409);
    assert.equal(pending.body.error, "bot_has_pending_input");
    assert.equal((await console.call("/api/bots")).body.bots.find((entry: { botId: string }) => entry.botId === "queued").pending, 1);
    assert.equal(botRow(directory, "queued")?.removalKind ?? null, null, "a refusal writes no intent");
  } finally {
    // Released even when an assertion above threw: a run held open by the gate would keep the host's
    // own shutdown waiting, and the failure would surface as a timeout instead of as itself.
    gated.release();
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("unexplained work is refused by default, accepted only with force, and reclaimed after a restart", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-unknown-"));
  const logs: string[] = [];
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const console = consoleOf(service);
    const created = await console.call("/api/bots", { name: "Ghost", botId: "ghost" });
    const conversationId = created.body.bot.conversationId as string;
    await ask(console, "ghost", "这句话会留下一个结局不明的任务");
    await service.close();
    service = undefined;

    // A task that ended without a recorded success: the host cannot say whether it ran. It is not
    // unfinished work — no process owns it any more — so it is the one blocker `force` may lift.
    injectTask(directory, conversationId, 900_101, "terminal", "aborted");

    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const restarted = consoleOf(service);
    const refused = await restarted.call("/api/bots/ghost", {}, "DELETE");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "unknown_outcome");
    assert.equal(refused.body.records, 1);
    assert.equal(botRow(directory, "ghost")?.removalKind ?? null, null);
    assert.ok(storeRows(directory, conversationId).conversations === 1, "a refusal deletes nothing");

    const forced = await restarted.call("/api/bots/ghost", { force: true }, "DELETE");
    assert.equal(forced.status, 202, JSON.stringify(forced.body));
    assert.equal(forced.body.removal.forced, true);
    assert.equal(forced.body.removal.state, "pending_purge");

    // `force` is recorded on the tombstone and carried into the pass, so the reclaim does not need a
    // second operator decision.
    await service.close();
    service = undefined;
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    assert.equal((await consoleOf(service).call("/api/platform")).body.pendingPurge, 0);
    assert.deepEqual(storeRows(directory, conversationId), { conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 });
    assert.equal(botRow(directory, "ghost")?.removalForced, 1);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("work this process still owns is refused as unfinished, and force does not get past it", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inflight-"));
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);
    const created = await console.call("/api/bots", { name: "Stuck", botId: "stuck" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const conversationId = created.body.bot.conversationId as string;
    await ask(console, "stuck", "先记一句");
    // Written while the service runs, as a row a still-live run would leave behind: the operator can
    // cancel that run, so this refusal is one they can act on.
    injectTask(directory, conversationId, 900_201, "running");

    const refused = await console.call("/api/bots/stuck", {}, "DELETE");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "work_in_flight");
    assert.equal(refused.body.tasks, 1);
    assert.equal(refused.body.submissions, 0);

    const forced = await console.call("/api/bots/stuck", { force: true }, "DELETE");
    assert.equal(forced.status, 409, "unfinished work is not an unexplained outcome");
    assert.equal(forced.body.error, "work_in_flight");
    assert.equal(botRow(directory, "stuck")?.removalKind ?? null, null);
    assert.equal(storeRows(directory, conversationId).conversations, 1);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("purge:now answers completely before the host exits, and the next start reclaims the rows", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-now-"));
  const second: string[] = [];
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);
    const created = await console.call("/api/bots", { name: "Instant", botId: "instant" });
    const conversationId = created.body.bot.conversationId as string;
    await ask(console, "instant", "无需等待");

    const answer = await console.call("/api/bots/instant", { purge: "now" }, "DELETE");
    // A body this complete can only have been written before the teardown began.
    assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.equal(answer.body.removal.state, "pending_purge");
    assert.equal(typeof answer.body.removal.requestedAt, "string");
    assert.ok(answer.body.bot.botId === "instant");
    assert.match(answer.body.note, /reclaimed at the next service start/);

    // The service exits on its own — no signal, no close() — which is what the container restarts.
    await service.done;
    service = undefined;
    // The host is genuinely down for the reclaim, not merely asked to be: the port it answered on is
    // gone. (Its own reason is written to the deployment log, not to this service's log sink.)
    await assert.rejects(() => console.call("/api/bots"), "the console must be closed after the host exits");
    assert.equal(storeRows(directory, conversationId).conversations, 1, "the exit cannot delete; only a start can");

    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => second.push(line) });
    const restarted = consoleOf(service);
    assert.ok(second.some((line) => line.includes("Bot removed: instant")), second.join("\n"));
    assert.equal((await restarted.call("/api/platform")).body.pendingPurge, 0);
    assert.equal(storeRows(directory, conversationId).conversations, 0);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an immediate reclaim is refused while another bot is mid-run, and force alone does not ask for one", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-now-busy-"));
  const gated = gatedProvider();
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: gated.models, log: () => {} });
    const console = consoleOf(service);
    assert.equal((await console.call("/api/bots", { name: "Worker", botId: "worker" })).status, 201);
    assert.equal((await console.call("/api/bots", { name: "Spare", botId: "spare" })).status, 201);
    await console.call("/api/bots/worker/messages", { text: "长任务" });
    await waitFor("the worker's run", async () => {
      const bot = (await console.call("/api/bots")).body.bots.find((entry: { botId: string }) => entry.botId === "worker");
      return bot?.running !== null ? true : undefined;
    });

    // One process carries every bot, so reclaiming now would interrupt the worker. Refused, and the
    // caller is told whom to cancel instead of having it done silently behind their back.
    const busy = await console.call("/api/bots/spare", { purge: "now" }, "DELETE");
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.equal(busy.body.error, "busy_bots");
    assert.deepEqual(busy.body.bots, [{ botId: "worker", reason: "running" }]);
    assert.equal(botRow(directory, "spare")?.removalKind ?? null, null);

    // `force` and `purge` are independent: the removal is accepted, the host keeps running.
    const forced = await console.call("/api/bots/spare", { force: true }, "DELETE");
    assert.equal(forced.status, 202, JSON.stringify(forced.body));
    assert.equal(forced.body.removal.forced, true);
    assert.equal((await console.call("/api/bots")).status, 200, "force must not imply an immediate reclaim");
    assert.ok(!forced.body.note.includes("shutting down"));

    gated.release();
    await waitFor("the worker's run to end", async () => {
      const bot = (await console.call("/api/bots")).body.bots.find((entry: { botId: string }) => entry.botId === "worker");
      return bot !== undefined && bot.running === null && bot.pending === 0 ? true : undefined;
    });
  } finally {
    gated.release();
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a removal that cannot be carried out stays pending, is reported, and converges when forced", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-retry-"));
  const logs: string[] = [];
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const console = consoleOf(service);
    const created = await console.call("/api/bots", { name: "Doomed", botId: "doomed" });
    const conversationId = created.body.bot.conversationId as string;
    await ask(console, "doomed", "删除已受理");
    assert.equal((await console.call("/api/bots/doomed", {}, "DELETE")).status, 202);
    await service.close();
    service = undefined;

    // The intent is durable, and only now does a run end without an answer: the pass at the next
    // start will find what the operator's request could not have known about.
    injectTask(directory, conversationId, 900_301, "terminal", "aborted");

    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    const restarted = consoleOf(service);
    assert.ok(logs.some((line) => line.includes("Bot removal failed: doomed (UNKNOWN_OUTCOME)")), logs.join("\n"));
    // The failure is a failed pass, not a failed start: the deployment is up and the backlog is visible.
    assert.equal((await restarted.call("/api/bots")).status, 200);
    assert.equal((await restarted.call("/api/platform")).body.pendingPurge, 1);
    assert.equal(botRow(directory, "doomed")?.removalError, "UNKNOWN_OUTCOME");
    assert.equal(botRow(directory, "doomed")?.removalReport, null);
    assert.equal(storeRows(directory, conversationId).conversations, 1, "a failed pass removes nothing, not part of it");

    // The operator's way out: force updates the standing decision rather than queueing a second one.
    const forced = await restarted.call("/api/bots/doomed", { force: true }, "DELETE");
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.removal.forced, true);
    assert.equal(forced.body.removal.state, "pending_purge");

    await service.close();
    service = undefined;
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: (line) => logs.push(line) });
    assert.equal((await consoleOf(service).call("/api/platform")).body.pendingPurge, 0);
    const row = botRow(directory, "doomed");
    assert.equal(row?.removalError, null);
    assert.equal(storeRows(directory, conversationId).conversations, 0);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the offline pass refuses a directory the service owns, and matches the startup pass once it stops", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-offline-"));
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env: environment(directory), models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);
    const created = await console.call("/api/bots", { name: "Offline", botId: "offline" });
    const conversationId = created.body.bot.conversationId as string;
    await ask(console, "offline", "离线回收");
    assert.equal((await console.call("/api/bots/offline", {}, "DELETE")).status, 202);

    // The service is the only writer, and the offline command is a second process — the only vantage
    // point from which "somebody else owns this directory" is true. So the refusal is observed by
    // running the real command: it exits non-zero, names the condition, and touches nothing.
    const refused = await offlineCommand(directory);
    assert.equal(refused.exitCode, 1, refused.stderr);
    assert.equal(refused.report.code, "SERVICE_RUNNING");
    assert.equal(storeRows(directory, conversationId).conversations, 1, "a refusal touches nothing");

    await service.close();
    service = undefined;
    const report = purgeBots({ dataDir: directory });
    assert.equal(report.status, "bot-removal-pass-ok");
    assert.equal(report.code, "REMOVAL_COMPLETE");
    assert.equal(report.pending, 1);
    assert.equal(report.deferred, 0);
    assert.deepEqual(report.removed.map((entry) => [entry.botId, entry.state]), [["offline", "purged"]]);
    assert.equal(report.removed[0]?.rows.conversations, 1);
    assert.equal(storeRows(directory, conversationId).conversations, 0);

    // Re-running converges on the same state rather than failing or double-counting.
    assert.deepEqual(purgeBots({ dataDir: directory }).removed, []);
    assert.throws(() => purgeBots({ dataDir: join(directory, "missing") }), (error: unknown) => {
      assert.ok(error instanceof BotPurgeError);
      assert.equal(error.code, "DATA_DIR_INVALID");
      return true;
    });
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
