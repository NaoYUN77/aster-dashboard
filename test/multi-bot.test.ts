// Multi-bot runtime over the local console, exercised end to end with a scripted model.
//
// The console is the only surface the owner uses, so these tests send exactly what the browser
// sends and read exactly what it reads. Everything below is local: the workspace isolation shown
// here is the Node execution environment's `cwd`, not the container sandbox.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { toolsForRole } from "../src/bot-manager.js";
import { profileForRole } from "../src/tool-catalog.js";
import { startService, type ServiceHandle } from "../src/main.js";

const TOKEN = "{{SECRET_5xpdbsvp}}";
const MODEL = "faux-1";

test("role capability strings keep web tools exclusive to configured researchers", () => {
  const deployment = { ptc: true, web: true };
  assert.equal(toolsForRole("assistant", deployment), "bash,files");
  assert.equal(toolsForRole("researcher", deployment), "bash,files,web");
  assert.equal(toolsForRole("programmer", deployment), "bash,files,ptc");
  assert.equal(toolsForRole("researcher", { ptc: true, web: false }), "bash,files");
});

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
    // Code mode is on so the programmer role's extra capability is observable; the direct tools
    // stay visible so both roles share a comparable base surface.
    CODEMODE_ENABLED: "1",
    CODEMODE_SCRIPT_FIRST: "0",
    // A configured CCR profile enables the researcher's native Claude Code web tools.
    CCR_PROFILE: "test-researcher-profile",
  };
}

type Console = { base: string; call(path: string, body?: unknown): Promise<{ status: number; body: any }> };

function consoleOf(service: ServiceHandle): Console {
  const port = service.console?.port;
  assert.ok(port !== undefined, "the console must be listening");
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { base, call };
}

function lastUserText(transcript: { messages: readonly Message[] }): string {
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index];
    if (message?.role === "user") return contentText(message.content);
  }
  return "";
}

function toolResultAfterLastUser(transcript: { messages: readonly Message[] }): string | undefined {
  let lastUser = -1;
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    if (transcript.messages[index]?.role === "user") { lastUser = index; break; }
  }
  for (let index = transcript.messages.length - 1; index > lastUser; index -= 1) {
    const message = transcript.messages[index];
    if (message?.role === "toolResult") return contentText(message.content);
  }
  return undefined;
}

/**
 * One responder for every request, routed on the transcript: concurrent bots never compete for
 * queued responses, so a cancellation test can run one bot while another proceeds.
 */
const responder: FauxResponseFactory = (transcript) => {
  const request = lastUserText(transcript);
  const result = toolResultAfterLastUser(transcript);
  if (request.includes("WRITE-FILE")) {
    return result === undefined
      ? fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello-from-researcher > a.txt" }, { id: "write" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("WROTE");
  }
  if (request.includes("LIST-FILES")) {
    return result === undefined
      ? fauxAssistantMessage(fauxToolCall("bash", { command: "ls -1" }, { id: "list" }), { stopReason: "toolUse" })
      : fauxAssistantMessage(result.trim() === "" ? "(empty)" : result.trim());
  }
  if (request.includes("SLEEP-LONG")) {
    return result === undefined
      ? fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }, { id: "sleep" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("SLEPT");
  }
  return fauxAssistantMessage("OK");
};

function scriptedProvider() {
  const faux = fauxProvider({ provider: "openai" });
  // Every model call takes one response; a generous queue keeps unrelated bots independent.
  faux.setResponses(Array.from({ length: 200 }, () => responder));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function history(console: Console, botId: string) {
  const response = await console.call(`/api/bots/${botId}/history?limit=200`);
  assert.equal(response.status, 200);
  return response.body.messages as { role: string; text: string }[];
}

function assistantTexts(messages: readonly { role: string; text: string }[]): string[] {
  return messages.filter((message) => message.role === "assistant").map((message) => message.text);
}

/** Read server-sent events until the predicate matches; the stream is closed with an abort. */
async function collectEvents(
  url: string,
  until: (kinds: string[]) => boolean,
  run: () => Promise<void>,
  timeoutMs = 30_000,
): Promise<string[]> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const kinds: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  await run();
  try {
    for (;;) {
      if (until(kinds)) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (read === "timeout" || read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
        if (data !== "") {
          const payload = JSON.parse(data) as { type: string; events?: { type: string }[] };
          if (payload.type === "events") for (const event of payload.events ?? []) kinds.push(event.type);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
  }
  return kinds;
}

test("the console drives isolated bots and survives a restart", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-console-"));
  const env = environment(directory);
  let service: ServiceHandle | undefined;
  try {
    service = await startService({ env, models: scriptedProvider(), log: () => {} });
    const console = consoleOf(service);

    // Acceptance 10 (locally): every route, including the page, needs the token.
    assert.equal((await fetch(`${console.base}/api/bots`)).status, 401);
    assert.equal((await fetch(`${console.base}/`)).status, 401);
    assert.equal((await fetch(`${console.base}/api/bots`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${console.base}/api/bots/x/messages`, { method: "POST", body: "{}" })).status, 401);

    const listed = await console.call("/api/bots");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.bots.map((bot: { botId: string }) => bot.botId), ["default"]);

    // Acceptance 2: two bots, two conversations.
    const researcher = await console.call("/api/bots", {
      name: "Researcher",
      role: "researcher",
      systemPrompt: "You research.",
    });
    assert.equal(researcher.status, 201);
    const programmer = await console.call("/api/bots", {
      name: "Programmer",
      role: "programmer",
      systemPrompt: "You program.",
    });
    assert.equal(programmer.status, 201);
    const scoped = await console.call("/api/bots", {
      name: "Scoped Assistant",
      role: "assistant",
      systemPrompt: "Use only the command tool.",
      toolScope: { allow: ["bash"], deny: [] },
    });
    assert.equal(scoped.status, 201);
    const researcherId = researcher.body.bot.botId as string;
    const programmerId = programmer.body.bot.botId as string;
    assert.notEqual(researcher.body.bot.conversationId, programmer.body.bot.conversationId);

    // Acceptance 3: only the programmer has code mode and only the researcher has web access.
    assert.ok(researcher.body.bot.loadedTools.includes("bash"));
    assert.ok(researcher.body.bot.loadedTools.includes("web_search"));
    assert.ok(researcher.body.bot.loadedTools.includes("web_fetch"));
    assert.ok(!researcher.body.bot.loadedTools.includes("codemode"));
    assert.ok(programmer.body.bot.loadedTools.includes("codemode"));
    assert.ok(!programmer.body.bot.loadedTools.includes("web_search"));
    assert.ok(!programmer.body.bot.loadedTools.includes("web_fetch"));
    assert.ok(researcher.body.bot.tools.includes("web"));
    assert.ok(!programmer.body.bot.tools.includes("web"));
    assert.deepEqual(scoped.body.bot.profile, profileForRole("assistant"));
    assert.deepEqual(scoped.body.bot.toolScope, { allow: ["bash"], deny: [] });
    assert.deepEqual(scoped.body.bot.loadedTools, ["bash"]);

    const customProfile = { ...profileForRole("assistant"), shell: false, files: false, web: true, ptc: true, mcp: false };
    const custom = await console.call("/api/bots", { name: "Custom", role: "assistant", profile: customProfile });
    assert.equal(custom.status, 201);
    assert.deepEqual(custom.body.bot.profile, customProfile);
    assert.deepEqual(custom.body.bot.tools, ["ptc", "web"]);
    assert.ok(custom.body.bot.loadedTools.includes("codemode"));
    assert.ok(custom.body.bot.loadedTools.includes("web_search"));
    assert.ok(!custom.body.bot.loadedTools.includes("bash"));
    assert.ok(!custom.body.bot.loadedTools.includes("read"));
    for (const profile of [null, "research", { ...customProfile, shell: "yes" }, { core: true }, { ...customProfile, extra: true }]) {
      assert.equal((await console.call("/api/bots", { name: "Invalid", role: "assistant", profile })).status, 400);
    }
    const updatedProfile = { ...customProfile, files: true, reminders: false };
    const update = await fetch(`${console.base}/api/bots/${custom.body.bot.botId}`, {
      method: "PATCH", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ profile: updatedProfile, toolScope: { allow: [], deny: ["write"] } }),
    });
    assert.equal(update.status, 200);
    const updated = (await update.json()).bot;
    assert.deepEqual(updated.profile, updatedProfile);
    assert.equal(updated.conversationId, custom.body.bot.conversationId);
    assert.ok(updated.loadedTools.includes("read"));
    assert.ok(!updated.loadedTools.includes("write"));
    assert.ok(!updated.loadedTools.includes("bash"));
    assert.ok(updated.loadedTools.includes("codemode"));
    for (const invalid of [null, [], {}, { profile: "chief" }, { profile: updatedProfile, role: "programmer" }]) {
      const response = await fetch(`${console.base}/api/bots/${custom.body.bot.botId}`, {
        method: "PATCH", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(invalid),
      });
      assert.equal(response.status, 400);
    }
    const changing = service.bots.updateCatalog(custom.body.bot.botId, { profile: updatedProfile });
    assert.throws(() => service!.bots.send(custom.body.bot.botId, "during configuration"), /being configured/);
    await assert.rejects(service.bots.updateCatalog(custom.body.bot.botId, { profile: customProfile }), /must be idle/);
    assert.deepEqual((await changing).toolScope, { allow: [], deny: ["write"] });
    const explicit = await service.agent.configureBot({
      botId: "host-explicit", cwd: directory, prompt: "", tools: ["bash", "files"],
      catalogProfile: customProfile,
    });
    assert.ok(explicit.tools.includes("codemode") && explicit.tools.includes("web_search"));
    assert.ok(!explicit.tools.includes("bash") && !explicit.tools.includes("read"));
    const legacy = await service.agent.configureBot({ botId: "host-legacy", cwd: directory, prompt: "", tools: ["ptc", "web"] });
    assert.ok(legacy.tools.includes("codemode") && legacy.tools.includes("web_search"));
    assert.ok(!legacy.tools.includes("bash") && !legacy.tools.includes("read"));

    // Unknown bots are 404 and an invalid role is 400.
    assert.equal((await console.call("/api/bots/nobody/messages", { text: "hi" })).status, 404);
    assert.equal((await console.call("/api/bots", { name: "X", role: "admin" })).status, 400);

    // Acceptance 4 (local): A's file is not in B's working directory.
    assert.equal((await console.call(`/api/bots/${researcherId}/messages`, { text: "WRITE-FILE" })).status, 202);
    const wrote = await waitFor("the write to finish", async () => {
      const texts = assistantTexts(await history(console, researcherId));
      return texts.includes("WROTE") ? texts : undefined;
    });
    assert.deepEqual(wrote, ["WROTE"]);
    assert.equal(
      (await readFile(join(directory, "workspaces", researcherId, "a.txt"), "utf8")).trim(),
      "hello-from-researcher",
    );

    assert.equal((await console.call(`/api/bots/${programmerId}/messages`, { text: "LIST-FILES" })).status, 202);
    const listedText = await waitFor("the listing to finish", async () => {
      const texts = assistantTexts(await history(console, programmerId));
      return texts[0];
    });
    assert.doesNotMatch(listedText, /a\.txt/);

    // Acceptance 6: live events move from a run start to a run end.
    const events = await collectEvents(
      `${console.base}/api/bots/${researcherId}/events?token=${TOKEN}`,
      (kinds) => kinds.includes("run_end"),
      async () => {
        await console.call(`/api/bots/${researcherId}/messages`, { text: "LIST-FILES" });
      },
    );
    assert.ok(events.includes("run_start"), `expected run_start in ${events.join(",")}`);
    assert.ok(events.includes("run_end"), `expected run_end in ${events.join(",")}`);
    assert.ok(events.includes("tool"), `expected a tool event in ${events.join(",")}`);

    // Acceptance 7: cancelling A stops A's sleep and leaves B alone.
    assert.equal((await console.call(`/api/bots/${researcherId}/messages`, { text: "SLEEP-LONG" })).status, 202);
    await assert.rejects(service.bots.updateCatalog(researcherId, { profile: customProfile }), /must be idle/);
    // Give the run time to reach its `sleep 30` command, so the cancel interrupts real work.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const quick = await console.call(`/api/bots/${programmerId}/messages`, { text: "QUICK" });
    assert.equal(quick.status, 202);
    await waitFor("the programmer's quick run", async () => {
      const texts = assistantTexts(await history(console, programmerId));
      return texts.at(-1) === "OK" ? texts : undefined;
    }, 20_000);
    const stopped = await console.call(`/api/bots/${researcherId}/cancel`, {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.cancelled, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterCancel = assistantTexts(await history(console, researcherId));
    assert.ok(!afterCancel.includes("SLEPT"), "a cancelled run must not be saved as an answer");
    assert.equal(assistantTexts(await history(console, programmerId)).at(-1), "OK");

    // The default bot keeps the legacy working directory, not a per-bot one.
    assert.equal(service.bots.views().length, 5);

    // Acceptance 8 (local): bots, conversations and history survive a restart.
    const beforeRestart = await console.call("/api/bots");
    await service.close();
    service = await startService({ env, models: scriptedProvider(), log: () => {} });
    const restarted = consoleOf(service);
    const afterRestart = await restarted.call("/api/bots");
    assert.deepEqual(
      afterRestart.body.bots.map((bot: { botId: string; conversationId: string }) => [bot.botId, bot.conversationId]),
      beforeRestart.body.bots.map((bot: { botId: string; conversationId: string }) => [bot.botId, bot.conversationId]),
    );
    const restoredScope = afterRestart.body.bots.find((bot: { botId: string }) => bot.botId === scoped.body.bot.botId);
    assert.deepEqual(restoredScope.profile, profileForRole("assistant"));
    assert.deepEqual(restoredScope.toolScope, { allow: ["bash"], deny: [] });
    const restoredCustom = afterRestart.body.bots.find((bot: { botId: string }) => bot.botId === custom.body.bot.botId);
    assert.deepEqual(restoredCustom.profile, updatedProfile);
    assert.deepEqual(restoredCustom.toolScope, { allow: [], deny: ["write"] });
    assert.ok(restoredCustom.loadedTools.includes("codemode") && restoredCustom.loadedTools.includes("web_search"));
    assert.ok(!restoredCustom.loadedTools.includes("bash") && !restoredCustom.loadedTools.includes("write"));
    const restored = assistantTexts(await history(restarted, researcherId));
    assert.ok(restored.includes("WROTE"), `history lost after restart: ${restored.join("|")}`);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
