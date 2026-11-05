// Acceptance phase A: drive the owner console exactly as the browser does.
//
// Runs inside the application container (`docker exec ... node /tmp/console-check.mjs`), so it can
// read WEB_TOKEN and /data/inbox.sqlite directly. A real model answers the prompts; the checks
// tolerate wording differences and assert on durable evidence (rows, tool events, history).
//
//   node /tmp/console-check.mjs                  # phase A, writes /tmp/aster-acceptance-state.json
//   node /tmp/console-check.mjs --verify-restart # phase B, after `docker compose restart`
import { DatabaseSync } from "node:sqlite";

const BASE = `http://127.0.0.1:${process.env.CONSOLE_PORT?.trim() || "8787"}`;
const TOKEN = process.env.WEB_TOKEN?.trim() ?? "";
const DATA_DIR = process.env.DATA_DIR?.trim() || "/data";
const STATE_PATH = process.env.ACCEPTANCE_STATE?.trim() || "/tmp/aster-acceptance-state.json";
const verifyRestart = process.argv.includes("--verify-restart");
const runTimeoutMs = Number(process.env.ACCEPTANCE_RUN_TIMEOUT_MS ?? 180_000);
const results = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.info(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
}
function finish() {
  const failed = results.filter((result) => !result.ok);
  console.info(JSON.stringify({ status: failed.length === 0 ? "ok" : "failed", checks: results }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

async function api(path, { method = "GET", body, token = TOKEN, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

/** Attach to the event stream before sending, so no frame of the run is missed. */
async function watch(botId) {
  const controller = new AbortController();
  const events = [];
  const response = await fetch(`${BASE}/api/bots/${botId}/events?token=${encodeURIComponent(TOKEN)}`, {
    signal: controller.signal,
  });
  if (response.status !== 200) throw new Error(`event stream answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let payload;
            try { payload = JSON.parse(line.slice(6)); } catch { continue; }
            if (payload.type === "events" && Array.isArray(payload.events)) {
              for (const event of payload.events) events.push({ ...event, at: Date.now() });
            }
            if (payload.type === "error") events.push({ type: "error", message: String(payload.message).slice(0, 200), at: Date.now() });
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch { /* aborted by the caller */ }
  })();
  return { events, stop: () => controller.abort() };
}

async function waitRun(watcher, from = 0, timeoutMs = runTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = watcher.events.slice(from);
    if (seen.some((event) => event.type === "run_end" || event.type === "error")) return seen;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for run_end`);
    await sleep(100);
  }
}

async function prompt(botId, text, timeoutMs = runTimeoutMs) {
  const watcher = await watch(botId);
  const started = Date.now();
  try {
    const accepted = await api(`/api/bots/${botId}/messages`, { method: "POST", body: { text } });
    if (accepted.status !== 202) throw new Error(`message rejected with ${accepted.status}`);
    const events = await waitRun(watcher, 0, timeoutMs);
    return { events, ms: Date.now() - started };
  } finally {
    watcher.stop();
  }
}

async function history(botId) {
  const response = await api(`/api/bots/${botId}/history?limit=200`);
  if (response.status !== 200) throw new Error(`history answered ${response.status}`);
  return response.body.messages ?? [];
}
const assistantTexts = (messages) => messages.filter((message) => message.role === "assistant").map((message) => message.text);
const toolNames = (events) => events.filter((event) => event.type === "tool").map((event) => String(event.name));

async function createBot(botId, role, name, systemPrompt) {
  const response = await api("/api/bots", { method: "POST", body: { botId, name, role, systemPrompt } });
  if (response.status !== 201) throw new Error(`creating ${botId} answered ${response.status}: ${response.body?.error ?? ""}`);
  return response.body.bot;
}

function openBotsDatabase() {
  const database = new DatabaseSync(`${DATA_DIR}/inbox.sqlite`, { readOnly: true });
  return {
    rows: (ids) => {
      const placeholders = ids.map(() => "?").join(",");
      return database.prepare(
        `SELECT botId, role, conversationId, systemPrompt, tools FROM bots WHERE botId IN (${placeholders})`,
      ).all(...ids);
    },
    close: () => database.close(),
  };
}

async function phaseA() {
  const stamp = Date.now().toString(36);
  const researcherId = `acc-res-${stamp}`;
  const programmerId = `acc-prog-${stamp}`;

  // Acceptance 10, local half: the console refuses every request without the token.
  const noToken = await api("/api/bots", { token: "" });
  check("A10 console answers 401 without a token", noToken.status === 401, `status ${noToken.status}`);

  const listed = await api("/api/bots");
  check("A2 console lists the bootstrap bot", listed.status === 200
    && (listed.body.bots ?? []).some((bot) => bot.botId === "default"));

  const researcher = await createBot(researcherId, "researcher", "Acceptance researcher", "You research files.");
  const programmer = await createBot(programmerId, "programmer", "Acceptance programmer", "You write code.");
  check("A2 two bots have different conversations",
    researcher.conversationId !== "" && researcher.conversationId !== programmer.conversationId,
    `${researcherId}->${researcher.conversationId}, ${programmerId}->${programmer.conversationId}`);

  // The bots table is the durable record: two rows, distinct conversations, distinct prompts.
  const database = openBotsDatabase();
  const rows = database.rows([researcherId, programmerId]);
  database.close();
  const rowOf = (id) => rows.find((row) => row.botId === id);
  check("A2 bots table has two rows with distinct conversations",
    rows.length === 2 && rowOf(researcherId).conversationId !== rowOf(programmerId).conversationId,
    `${rows.length} rows`);
  check("A3 each bot keeps its own system prompt",
    rowOf(researcherId).systemPrompt === "You research files."
    && rowOf(programmerId).systemPrompt === "You write code.");
  check("A3 tools differ by role",
    rowOf(researcherId).tools.includes("bash")
    && !rowOf(researcherId).tools.includes("ptc")
    && rowOf(programmerId).tools.includes("ptc"),
    `researcher=${rowOf(researcherId).tools}; programmer=${rowOf(programmerId).tools}`);
  check("A3 only the programmer has code mode loaded",
    !researcher.loadedTools.includes("codemode") && programmer.loadedTools.includes("codemode"),
    `researcher=${researcher.loadedTools.join(",")}; programmer=${programmer.loadedTools.join(",")}`);

  // Acceptance 4 + 6: A writes its marker through bash; the run is observed live.
  const aRun = await prompt(researcherId,
    "You are in a sandboxed working directory. Use the bash tool exactly once with the command "
    + "`printf 'hello-from-A' > acceptance-a.txt && pwd`. Then reply with exactly the command output "
    + "followed by the word WROTE-A on the next line, nothing else.");
  const aKinds = aRun.events.map((event) => event.type);
  const aStart = aKinds.indexOf("run_start");
  const aEnd = aKinds.indexOf("run_end");
  const aTool = aKinds.indexOf("tool");
  check("A6 the stream reports run_start, a tool event and run_end in order",
    aStart >= 0 && aTool > aStart && aEnd > aTool,
    aKinds.join(","));
  check("A4 the researcher's bash ran inside its own directory",
    toolNames(aRun.events).includes("bash")
    && assistantTexts(await history(researcherId)).some((text) => text.includes("WROTE-A") && text.includes(researcherId)),
    toolNames(aRun.events).join(",") || "no tool events");

  // Acceptance 4: B's own directory is its working directory, and it does not contain A's file.
  const bRun = await prompt(programmerId,
    "Use the bash tool exactly once with the command `pwd && ls -a .`. Then reply with exactly the output, nothing else.");
  const bTexts = assistantTexts(await history(programmerId));
  check("A4 the programmer's bash ran in its own directory",
    toolNames(bRun.events).includes("bash") && bTexts.some((text) => text.includes(programmerId)),
    bTexts.at(-1)?.slice(0, 160) ?? "");
  check("A4 the programmer's directory does not contain the researcher's file",
    !bTexts.some((text) => text.includes("acceptance-a.txt")),
    bTexts.at(-1)?.slice(0, 160) ?? "");

  // Acceptance 3, behavioural half: the researcher cannot invoke code mode.
  const ptcAttempt = await prompt(researcherId,
    "Call the codemode tool to evaluate the script `1 + 1`. If code mode is not available, reply exactly NO-CODE.");
  const ptcToolNames = toolNames(ptcAttempt.events);
  check("A3 the researcher has no code-mode tool to call",
    !ptcToolNames.some((name) => name.includes("codemode")),
    ptcToolNames.join(",") || "no tool events");

  // Acceptance 5: two 30s commands started together finish in about 30s.
  const sleepA = await watch(researcherId);
  const sleepB = await watch(programmerId);
  try {
    const started = Date.now();
    const [first, second] = await Promise.all([
      api(`/api/bots/${researcherId}/messages`, { method: "POST", body: {
        text: "Use the bash tool exactly once with the command `sleep 30 && echo SLEPT-A`. Then reply exactly SLEPT-A.",
      } }),
      api(`/api/bots/${programmerId}/messages`, { method: "POST", body: {
        text: "Use the bash tool exactly once with the command `sleep 30 && echo SLEPT-B`. Then reply exactly SLEPT-B.",
      } }),
    ]);
    if (first.status !== 202 || second.status !== 202) throw new Error("parallel messages were not accepted");
    await Promise.all([waitRun(sleepA), waitRun(sleepB)]);
    const elapsed = Date.now() - started;
    check("A5 two 30s commands overlap", elapsed < 48_000, `${Math.round(elapsed / 1000)}s (serial would be ~60s)`);
  } finally {
    sleepA.stop();
    sleepB.stop();
  }

  // Acceptance 7: cancelling A stops A and leaves B free to run.
  const cancelledWatcher = await watch(researcherId);
  try {
    const accepted = await api(`/api/bots/${researcherId}/messages`, { method: "POST", body: {
      text: "Use the bash tool exactly once with the command `sleep 30 && echo SLEPT-LATE`. Then reply exactly SLEPT-LATE.",
    } });
    if (accepted.status !== 202) throw new Error("the long message was not accepted");
    await sleep(2_000);
    const stopped = await api(`/api/bots/${researcherId}/cancel`, { method: "POST", body: {} });
    check("A7 cancel is acknowledged", stopped.status === 200 && stopped.body.cancelled === true,
      `status ${stopped.status}, cancelled ${stopped.body.cancelled}`);
    await waitRun(cancelledWatcher, 0, 30_000).catch(() => undefined);
    await sleep(500);
    const afterCancel = assistantTexts(await history(researcherId));
    check("A7 the cancelled run does not save an answer",
      !afterCancel.some((text) => text.includes("SLEPT-LATE")), afterCancel.at(-1)?.slice(0, 120) ?? "");
  } finally {
    cancelledWatcher.stop();
  }
  const quick = await prompt(programmerId, "Reply with exactly OK.");
  check("A7 the other bot still runs while A is cancelled",
    assistantTexts(await history(programmerId)).at(-1) === "OK", quick.ms + "ms");

  // Hand the identity record to the restart phase.
  const state = {
    researcherId,
    programmerId,
    researcherConversationId: researcher.conversationId,
    programmerConversationId: programmer.conversationId,
    marker: "WROTE-A",
  };
  await import("node:fs/promises").then((fs) => fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2)));
  check("A8 state written for the restart phase", true, STATE_PATH);
}

async function phaseRestart() {
  const { readFile } = await import("node:fs/promises");
  const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  const listed = await api("/api/bots");
  const bots = listed.body.bots ?? [];
  const researcher = bots.find((bot) => bot.botId === state.researcherId);
  const programmer = bots.find((bot) => bot.botId === state.programmerId);
  check("A8 both bots survive a restart", researcher !== undefined && programmer !== undefined);
  check("A8 conversations keep their ids",
    researcher?.conversationId === state.researcherConversationId
    && programmer?.conversationId === state.programmerConversationId);
  const messages = await history(state.researcherId);
  check("A8 history survives a restart",
    assistantTexts(messages).some((text) => text.includes(state.marker)),
    assistantTexts(messages).at(-1)?.slice(0, 120) ?? "");
}

try {
  if (TOKEN === "") throw new Error("WEB_TOKEN is not set in this container");
  if (verifyRestart) await phaseRestart();
  else await phaseA();
  finish();
} catch (error) {
  check(verifyRestart ? "restart phase completed" : "acceptance phase A completed", false,
    error instanceof Error ? error.message : String(error));
  finish();
}
