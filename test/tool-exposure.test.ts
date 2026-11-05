import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { defineTool, type Extension } from "@earendil-works/pi-durable";
import { openAgent } from "../src/agent.js";
import { readCodemodeConfig, readConfig, readMemoryConfig } from "../src/config.js";
import { hideFromModel, SCRIPT_ONLY_TOOLS } from "../src/tool-exposure.js";
import type { TextRequest } from "../src/messages.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const running = new AbortController().signal;

const request: TextRequest = {
  requestId: "telegram:test:tool-exposure",
  conversationId: "telegram:test",
  senderId: "1",
  text: "Use the script.",
};

function appConfig(dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const full = {
    TELEGRAM_BOT_TOKEN: "offline-test",
    TELEGRAM_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
    ...env,
  };
  return { ...readConfig(full), memory: readMemoryConfig(full) } as ReturnType<typeof readConfig>;
}

function modelFixture() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function toolNames(messages: readonly Message[]): string[] {
  return getCurrentTools(messages).map(({ name }) => name);
}

function systemSection(messages: readonly Message[], key: string): string | undefined {
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    const value = message.sections[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function toolResultText(transcript: { messages: readonly Message[] }, id: string): string {
  const result = transcript.messages.find((message) =>
    message.role === "toolResult" && message.toolCallId === id);
  const available = transcript.messages.flatMap((message) =>
    message.role === "toolResult" ? [message.toolCallId] : []);
  assert.ok(result?.role === "toolResult",
    `missing tool result ${id}; available: ${available.join(",") || "(none)"}`);
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

test("hiding narrows the model surface without granting script callers", () => {
  const modelOnly = defineTool({
    name: "read",
    description: "Model only.",
    parameters: Type.Object({}, { additionalProperties: false }),
    callers: ["model"],
    execute: async () => ({ output: [] }),
  });
  const toolsOnly = defineTool({
    name: "bash",
    description: "Tools only.",
    parameters: Type.Object({}, { additionalProperties: false }),
    callers: ["tools"],
    execute: async () => ({ output: [] }),
  });
  const shared = defineTool({
    name: "write",
    description: "Shared.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ output: [] }),
  });
  const extension: Extension = { name: "extra", tools: [modelOnly, toolsOnly, shared] };
  const hidden = hideFromModel(extension, SCRIPT_ONLY_TOOLS);
  assert.deepEqual(hidden.tools?.map(({ name, callers }) => [name, callers]), [
    ["read", ["model"]],
    ["bash", ["tools"]],
    ["write", ["tools"]],
  ]);
  assert.equal(extension.tools?.find(({ name }) => name === "write")?.callers, undefined,
    "the source extension is not mutated");
});

test("script-first hides read, write, edit and bash from the model but scripts keep them", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-script-first-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      (transcript) => {
        const names = toolNames(transcript.messages);
        for (const name of ["read", "write", "edit", "bash"]) {
          assert.equal(names.includes(name), false, `${name} is not offered to the model`);
        }
        assert.ok(names.includes("codemode"));
        const section = systemSection(transcript.messages, "codemode");
        assert.ok(section);
        assert.match(section, /`read`/, "scripts still see the file tools");
        const instructions = systemSection(transcript.messages, "instructions");
        assert.ok(instructions);
        assert.match(instructions, /all file reads and writes/);
        assert.match(instructions, /plain JavaScript/);
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `
            const written = await tools.write({ path: "probe.txt", content: "hello" });
            const readBack = await tools.read({ path: "probe.txt" });
            const edited = await tools.edit({ path: "probe.txt", edits: [{ oldText: "hello", newText: "bye" }] });
            const ran = await tools.bash({ command: "printf ran" });
            text(JSON.stringify({ written, readBack, edited, ran: ran.output, exitCode: ran.exitCode }));
          `,
        }, { id: "script" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const text = toolResultText(transcript, "script");
        assert.match(text, /"readBack":"hello"/);
        assert.match(text, /"ran":"ran"/);
        assert.match(text, /"exitCode":0/);
        return fauxAssistantMessage("script done");
      },
    ]);
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply({ ...request, requestId: "telegram:script-first:1" }, running), "script done");
    assert.equal(await readFile(join(directory, "workspace", "probe.txt"), "utf8"), "bye");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("CODEMODE_SCRIPT_FIRST=0 restores the direct model surface", { timeout: 30_000 }, async () => {
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1" }).scriptFirst, true);
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1", CODEMODE_SCRIPT_FIRST: "0" }).scriptFirst, false);
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1", CODEMODE_SCRIPT_FIRST: "false" }).scriptFirst, false);
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "0", CODEMODE_SCRIPT_FIRST: "1" }).scriptFirst, true);

  const directory = await mkdtemp(join(tmpdir(), "personal-agent-script-first-off-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([(transcript) => {
      const names = toolNames(transcript.messages);
      for (const name of ["read", "write", "edit", "bash"]) {
        assert.ok(names.includes(name), `${name} stays visible after rollback`);
      }
      return fauxAssistantMessage("direct tools");
    }]);
    app = await openAgent(appConfig(directory, {
      CODEMODE_ENABLED: "1",
      CODEMODE_SCRIPT_FIRST: "0",
    }), fixture.models);
    assert.equal(await app.reply({ ...request, requestId: "telegram:script-first-off:1" }, running), "direct tools");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a model call to a hidden tool is audited and settles tool_unavailable", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-script-first-denied-"));
  const review: string[] = [];
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      (transcript) => {
        assert.equal(toolNames(transcript.messages).includes("read"), false);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "probe.txt" }, { id: "hidden-read" }),
          { stopReason: "toolUse" },
        );
      },
      (transcript) => {
        const text = toolResultText(transcript, "hidden-read");
        assert.match(text, /not available/);
        return fauxAssistantMessage("denied");
      },
    ]);
    app = await openAgent(
      appConfig(directory, { CODEMODE_ENABLED: "1" }),
      fixture.models,
      undefined,
      { toolReviewLog: (line) => review.push(line) },
    );
    assert.equal(await app.reply({ ...request, requestId: "telegram:script-first-denied:1" }, running), "denied");
    const events = review.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(events.some((event) =>
      event.event === "tool_review"
      && event.tool === "read"
      && event.code === "TOOL_NOT_EXPOSED"
      && event.decision === "deny"));
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
      await delay(25);
    }
  }
}

async function crashAt(startedFile: string, fixture: string, args: string[]): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", join(fixtures, fixture), ...args], {
    cwd: projectRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = once(child, "exit");
  try {
    await waitForFile(startedFile);
  } finally {
    child.kill("SIGKILL");
  }
  await exited;
}

test("an unfinished old read call keeps the old surface until the next idle restart", {
  timeout: 45_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-script-first-recovery-"));
  const database = join(directory, "agent.sqlite");
  const startedFile = join(directory, "started.txt");
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await crashAt(startedFile, "crash-read.ts", [database, startedFile]);

    const recovering = modelFixture();
    const whileRecovering = (transcript: { messages: readonly Message[] }) => {
      const names = toolNames(transcript.messages);
      for (const name of ["read", "bash"]) {
        assert.ok(names.includes(name), `${name} stays visible while its call is unfinished`);
      }
      return fauxAssistantMessage("recovered");
    };
    // The first generation finishes the request that was live when the process died; the second
    // answers the new request, both under the preserved surface.
    recovering.faux.setResponses([whileRecovering, whileRecovering]);
    app = await openAgent(appConfig(directory, {
      CODEMODE_ENABLED: "1",
      CODEMODE_SCRIPT_FIRST: "1",
    }), recovering.models);
    assert.equal(await app.reply({ ...request, requestId: "telegram:recovery:1" }, running), "recovered");
    await app.close();
    app = undefined;

    const idle = modelFixture();
    idle.faux.setResponses([(transcript) => {
      const names = toolNames(transcript.messages);
      for (const name of ["read", "write", "edit", "bash"]) {
        assert.equal(names.includes(name), false, `${name} is hidden after the task settled`);
      }
      return fauxAssistantMessage("hidden");
    }]);
    app = await openAgent(appConfig(directory, {
      CODEMODE_ENABLED: "1",
      CODEMODE_SCRIPT_FIRST: "1",
    }), idle.models);
    assert.equal(await app.reply({ ...request, requestId: "telegram:recovery:2" }, running), "hidden");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
