import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  SessionFailed,
  type Storage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolRegistry, currentTime, personalTools } from "../src/tools.js";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import type { TextRequest } from "../src/messages.js";

const request: TextRequest = { requestId: "telegram:test:1", conversationId: "telegram:test", senderId: "1", text: "Remember that my color is blue." };
const running = new AbortController().signal;
function appConfig(dataDir: string) {
  return readConfig({ TELEGRAM_BOT_TOKEN: "offline-test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai", MODEL_ID: "faux-1", OPENAI_API_KEY: "offline-test", DATA_DIR: dataDir });
}

function webAppConfig(dataDir: string) {
  return readConfig({
    TELEGRAM_BOT_TOKEN: "offline-test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "offline-test", DEEPSEEK_WEB_API_KEY: "web-test", DATA_DIR: dataDir,
  });
}

const context = BACKGROUND_CONTEXT;
const agent = { model: { provider: "faux", modelId: "faux-1" } };

test("application registry rejects tool-name collisions across extensions", () => {
  const collision = defineExtension({ name: "collision", tools: [currentTime] });
  const native = createRegistry();
  native.install(personalTools);
  native.install(collision);
  assert.equal(native.snapshot().tools().length, 2, "the native registry permits cross-extension collisions");
  assert.throws(() => native.install(defineExtension({ name: "within", tools: [currentTime, currentTime] })), /two tools named current_time/);
  assert.throws(() => createToolRegistry([personalTools, collision]), /Duplicate tool name: current_time/);
});

function modelFixture(provider = "faux") {
  const faux = fauxProvider({ provider });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

test("web tools are absent unless the host configures their credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-no-web-tools-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture("openai");
    fixture.faux.setResponses([(transcript) => {
      const tools = transcript.messages.flatMap((message) => message.role === "system"
        ? message.toolsAdded?.map(({ name }) => name) ?? []
        : []);
      assert.equal(tools.includes("web_search"), false);
      assert.equal(tools.includes("web_fetch"), false);
      return fauxAssistantMessage("Web tools are disabled.");
    }]);
    app = await openAgent(appConfig(directory), fixture.models);
    assert.equal(await app.reply({ ...request, requestId: "telegram:no-web:1", text: "List web tools." }, running), "Web tools are disabled.");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("configured built-in web tools are declared through the production composition root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-web-tools-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture("openai");
    fixture.faux.setResponses([(transcript) => {
      const tools = transcript.messages.flatMap((message) => message.role === "system"
        ? message.toolsAdded?.map(({ name }) => name) ?? []
        : []);
      assert.ok(tools.includes("web_search"));
      assert.ok(tools.includes("web_fetch"));
      return fauxAssistantMessage("Web tools are available.");
    }]);
    app = await openAgent(webAppConfig(directory), fixture.models);
    assert.equal(await app.reply({ ...request, requestId: "telegram:web:1", text: "List web tools." }, running), "Web tools are available.");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("agent file tools survive reopening and completed requests are not executed again", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-memory-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const first = modelFixture("openai");
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("write", { path: "notes.md", content: "Favorite color: blue.\n" }, { id: "save" }),
        fauxToolCall("read", { path: "notes.md" }, { id: "read-after-save" }),
        fauxToolCall("current_time", {}, { id: "clock" }),
      ], { stopReason: "toolUse" }),
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult" && message.toolCallId === "read-after-save");
        assert.ok(result?.role === "toolResult" && !result.isError);
        assert.ok(result.content.some((part) => part.type === "text" && part.text.includes("Favorite color: blue.")));
        const clock = transcript.messages.find((message) => message.role === "toolResult" && message.toolCallId === "clock");
        assert.ok(clock?.role === "toolResult" && !clock.isError);
        assert.ok(clock.content.some((part) => part.type === "text" && /^\d{4}-\d\d-\d\dT/.test(part.text)));
        return fauxAssistantMessage("Remembered: blue.");
      },
    ]);
    app = await openAgent(appConfig(directory), first.models);
    assert.equal(await app.reply(request, running), "Remembered: blue.");
    await app.close();
    app = undefined;

    const second = modelFixture("openai");
    app = await openAgent(appConfig(directory), second.models);
    assert.equal(await app.reply(request, running), "Remembered: blue.");
    assert.equal(second.faux.state.callCount, 0);
    second.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }, { id: "reopened-memory" }), { stopReason: "toolUse" }),
      (transcript) => {
        const memory = transcript.messages.find((message) => message.role === "toolResult" && message.toolCallId === "reopened-memory");
        assert.ok(memory?.role === "toolResult" && !memory.isError);
        assert.ok(memory.content.some((part) => part.type === "text" && part.text.includes("Favorite color: blue.")));
        return fauxAssistantMessage("Your color is blue.");
      },
    ]);
    assert.equal(await app.reply({ ...request, requestId: "telegram:test:2", text: "What is my color?" }, running), "Your color is blue.");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

function failingStorage(storage: Storage) {
  const state = { failing: false };
  const proxy = new Proxy(storage, {
    get(target, property) {
      if (state.failing && property === "commit")
        return async () => { throw new Error("simulated storage failure"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage: proxy, state };
}

test("a failed agent session is fatal and the same request recovers after restart", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-session-failure-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const first = modelFixture("openai");
    const wrapped = failingStorage(await openNodeSqliteStorage(join(directory, "agent.sqlite")));
    app = await openAgent(appConfig(directory), first.models, wrapped.storage);
    wrapped.state.failing = true;
    await assert.rejects(app.reply(request, running), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "AGENT_SESSION_FAILED");
      assert.ok(error.cause instanceof SessionFailed);
      assert.doesNotMatch(error.message, /simulated storage failure/);
      return true;
    });
    assert.equal(first.faux.state.callCount, 0, "the failed session must not generate an answer");
    await app.close();
    app = undefined;

    const second = modelFixture("openai");
    second.faux.setResponses([fauxAssistantMessage("Recovered after session failure.")]);
    app = await openAgent(appConfig(directory), second.models);
    assert.equal(await app.reply(request, running), "Recovered after session failure.");
    assert.equal(second.faux.state.callCount, 1);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a length-limited answer is reported as truncated with its partial text", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-truncated-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const { faux, models } = modelFixture("openai");
    faux.setResponses([fauxAssistantMessage("partial answer", { stopReason: "length" })]);
    app = await openAgent(appConfig(directory), models);
    await assert.rejects(app.reply(request, running), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "AGENT_TRUNCATED");
      assert.equal((error as Error & { partialReply?: string }).partialReply, "partial answer");
      return true;
    });
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// Leaves a submitted request whose in-process generation was cancelled by close(), so a reopen must recover it.
async function leaveUnfinishedRequest(directory: string): Promise<void> {
  const first = modelFixture("openai");
  const started = Promise.withResolvers<void>();
  first.faux.setResponses([async (_transcript, options) => {
    assert.ok(options?.signal);
    started.resolve();
    await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("", { stopReason: "aborted" });
  }]);
  const app = await openAgent(appConfig(directory), first.models);
  const shutdown = new AbortController();
  const reply = assert.rejects(app.reply(request, shutdown.signal));
  await started.promise;
  shutdown.abort();
  await reply;
  await app.close();
}

test("reopening does not start recovered work until a reply is waiting", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-resume-timing-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await leaveUnfinishedRequest(directory);
    const second = modelFixture("openai");
    second.faux.setResponses([fauxAssistantMessage("Recovered inside reply.")]);
    app = await openAgent(appConfig(directory), second.models);
    await delay(200);
    assert.equal(second.faux.state.callCount, 0, "opening must not run recovered work without a waiter");
    assert.equal(await app.reply(request, running), "Recovered inside reply.");
    assert.equal(second.faux.state.callCount, 1);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a recovered task is bounded by the waiting reply's timeout", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-resume-timeout-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 300_000);
    return timeout.signal;
  });
  try {
    await leaveUnfinishedRequest(directory);
    const second = modelFixture("openai");
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    second.faux.setResponses([async (_transcript, options) => {
      assert.ok(options?.signal);
      started.resolve();
      await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    app = await openAgent(appConfig(directory), second.models);
    await delay(200);
    assert.equal(second.faux.state.callCount, 0);
    const reply = assert.rejects(app.reply(request, running), { code: "AGENT_TIMEOUT" });
    await started.promise;
    timeout.abort(new DOMException("Request timed out", "TimeoutError"));
    await reply;
    assert.equal(cancelled, true, "the timeout must cancel the recovered generation");
    t.mock.restoreAll();
    // The durable outcome is settled: retrying reports it instead of starting a second generation.
    await assert.rejects(app.reply(request, running), { code: "AGENT_UNANSWERED", message: /aborted/ });
    assert.equal(second.faux.state.callCount, 1);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("agent exposes safe failure codes while retaining durable failure details", { timeout: 15_000 }, async () => {  const directory = await mkdtemp(join(tmpdir(), "personal-agent-failure-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const { faux, models } = modelFixture("openai");
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Private provider diagnostic" })]);
    app = await openAgent(appConfig(directory), models);
    await assert.rejects(app.reply(request, running), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, "AGENT_UNANSWERED");
      assert.match(error.message, /model_error/);
      assert.doesNotMatch(error.message, /Private provider diagnostic/);
      assert.equal(error.cause, "Private provider diagnostic");
      return true;
    });
    faux.setResponses([fauxAssistantMessage("")]);
    await assert.rejects(app.reply({ ...request, requestId: "telegram:test:empty" }, running), { code: "EMPTY_REPLY" });
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("explicit cancellation reaches the model and leaves a durable aborted request", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-abort-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const { faux, models } = modelFixture("openai");
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    faux.setResponses([async (_transcript, options) => {
      assert.ok(options?.signal);
      started.resolve();
      await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    app = await openAgent(appConfig(directory), models);
    const reply = assert.rejects(app.reply(request, running), { code: "AGENT_UNANSWERED", message: /aborted/ });
    await started.promise;
    await app.abort();
    await reply;
    assert.equal(cancelled, true, "abort must reach actual provider work");
    await app.close();
    app = undefined;
    const reopened = modelFixture("openai");
    app = await openAgent(appConfig(directory), reopened.models);
    await assert.rejects(app.reply(request, running), { code: "AGENT_UNANSWERED", message: /aborted/ });
    assert.equal(reopened.faux.state.callCount, 0);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("request timeout cancels provider work before reporting AGENT_TIMEOUT", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-timeout-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 300_000);
    return timeout.signal;
  });
  try {
    const { faux, models } = modelFixture("openai");
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    faux.setResponses([async (_transcript, options) => {
      assert.ok(options?.signal);
      started.resolve();
      await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    app = await openAgent(appConfig(directory), models);
    const reply = assert.rejects(app.reply(request, running), { code: "AGENT_TIMEOUT" });
    await started.promise;
    timeout.abort(new DOMException("Request timed out", "TimeoutError"));
    await reply;
    assert.equal(cancelled, true);
    t.mock.restoreAll();
    await assert.rejects(app.reply(request, running), { code: "AGENT_UNANSWERED", message: /aborted/ });
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("shutdown stops waiting while close preserves an unfinished request for reopening", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-shutdown-test-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const first = modelFixture("openai");
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    first.faux.setResponses([async (_transcript, options) => {
      assert.ok(options?.signal);
      started.resolve();
      await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    app = await openAgent(appConfig(directory), first.models);
    const shutdown = new AbortController();
    const reply = assert.rejects(app.reply(request, shutdown.signal));
    await started.promise;
    shutdown.abort();
    await reply;
    assert.equal(cancelled, false, "stopping the host wait must leave the durable request recoverable");
    await app.close();
    app = undefined;
    assert.equal(cancelled, true, "close must cancel the in-process provider invocation");

    const second = modelFixture("openai");
    second.faux.setResponses([fauxAssistantMessage("Recovered after shutdown.")]);
    app = await openAgent(appConfig(directory), second.models);
    assert.equal(await app.reply(request, running), "Recovered after shutdown.");
    assert.equal(second.faux.state.callCount, 1);
    const alreadyStopped = AbortSignal.abort();
    await assert.rejects(app.reply({ ...request, requestId: "never-admitted" }, alreadyStopped));
    second.faux.setResponses([fauxAssistantMessage("Admitted only after restart.")]);
    assert.equal(await app.reply({ ...request, requestId: "never-admitted" }, running), "Admitted only after restart.");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("SQLite harness rejects invalid custom-tool arguments before execution", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-tool-test-"));
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const { faux, models } = modelFixture();
    const executed: number[] = [];
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "test-tools",
      tools: [defineTool({
        name: "double",
        description: "Double a number",
        parameters: Type.Object({ n: Type.Number() }),
        execute: async ({ n }) => {
          executed.push(n);
          return { output: [{ type: "text", text: String(n * 2) }] };
        },
      })],
    }));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("double", { n: "not-a-number" }, { id: "invalid" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("double", { n: 3 }, { id: "valid" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The valid result is 6."),
    ]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, context);
    const root = await harness.root(context, { agent });
    const settled = await (await root.submit({ type: "input", content: "Double a number." }, context)).wait(context);
    assert.equal(settled.status, "done");
    assert.deepEqual(executed, [3], "only the schema-valid call may execute");

    const entries = await root.entries({}, 100, undefined, context);
    const results = entries.items
      .filter((entry) => ToolResultEntry.is(entry))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult");
    assert.equal(results.length, 2);
    const invalid = results.find((message) => message.toolCallId === "invalid");
    const valid = results.find((message) => message.toolCallId === "valid");
    assert.ok(invalid);
    assert.equal(invalid.isError, true);
    assert.ok(valid);
    assert.equal(valid.isError, false);
    assert.ok(valid.content.some((part) => part.type === "text" && part.text.includes("6")));
    assert.equal(faux.state.callCount, 3, "the harness continues its model/tool loop after validation failure");
  } finally {
    try {
      await harness?.close(context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("custom tool schemas reject unknown arguments before execution", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-unknown-test-"));
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const { faux, models } = modelFixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("current_time", { unexpected: true }, { id: "unknown" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      models, registry: createToolRegistry([personalTools]),
    }, context);
    const root = await harness.root(context, { agent });
    assert.equal((await (await root.submit({ type: "input", content: "What time is it?" }, context)).wait(context)).status, "done");
    const entries = await root.entries({}, 100, undefined, context);
    const result = entries.items
      .filter((entry) => ToolResultEntry.is(entry))
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "toolResult" && message.toolCallId === "unknown");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, true);
    assert.ok(result.content.some((part) => part.type === "text" && /must not have additional properties/.test(part.text)));
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("sequential tool execution prevents overlapping calls in one round", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-sequential-test-"));
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const { faux, models } = modelFixture();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const work = (name: string) => defineTool({
      name,
      description: `Record ${name}.`,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(name);
        active--;
        return { output: [{ type: "text", text: `${name} done` }] };
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "sequential-tools", tools: [work("first"), work("second")] }));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("first", {}, { id: "first" }), fauxToolCall("second", {}, { id: "second" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      models, registry, settings: { toolExecution: "sequential" },
    }, context);
    const root = await harness.root(context, { agent });
    assert.equal((await (await root.submit({ type: "input", content: "Run both." }, context)).wait(context)).status, "done");
    assert.equal(maxActive, 1, "the configured sequential mode must not overlap tool calls");
    assert.deepEqual(order, ["first", "second"]);
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("SQLite reopen reuses requestId and retains the committed conversation", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-restart-test-"));
  const database = join(directory, "session.sqlite");
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const first = modelFixture();
    first.faux.setResponses([fauxAssistantMessage("Remembered: blue.")]);
    harness = await Harness.open(await openNodeSqliteStorage(database), { models: first.models, registry: createRegistry() }, context);
    const root = await harness.root(context, { agent });
    const input = { type: "input", content: "Remember blue.", requestId: "update-123" } as const;
    const submission = await root.submit(input, context);
    const settled = await submission.wait(context);
    assert.equal(settled.status, "done");
    assert.equal(settled.type, "input");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("Expected answered input");
    const answerId = settled.answer;
    const before = await root.entries({}, 100, undefined, context);
    await harness.close(context);
    harness = undefined;

    const second = modelFixture();
    harness = await Harness.open(await openNodeSqliteStorage(database), { models: second.models, registry: createRegistry() }, context);
    const reopened = await harness.root(context);
    assert.equal(reopened.id, root.id);
    harness.resume();
    const duplicate = await reopened.submit(input, context);
    assert.equal(duplicate.id, submission.id);
    const recovered = await duplicate.wait(context);
    assert.equal(recovered.status, "done");
    assert.equal(recovered.type, "input");
    if (recovered.status !== "done" || recovered.type !== "input") throw new Error("Expected recovered answer");
    assert.equal(recovered.answer, answerId);
    assert.equal(second.faux.state.callCount, 0, "a completed duplicate must not generate another answer");
    const after = await reopened.entries({}, 100, undefined, context);
    assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id));
    const answer = await reopened.commit((tx) => tx.entry(AssistantEntry, recovered.answer), context);
    const message = answer?.model?.[0];
    assert.equal(message?.role, "assistant");
    assert.ok(message?.content.some((part) => part.type === "text" && part.text === "Remembered: blue."));

    second.faux.setResponses([(transcript) => {
      assert.ok(transcript.messages.some((item) => item.role === "assistant" && item.content.some((part) => part.type === "text" && part.text === "Remembered: blue.")));
      return fauxAssistantMessage("Your color is blue.");
    }]);
    const next = await (await reopened.submit({ type: "input", content: "What is my color?", requestId: "update-124" }, context)).wait(context);
    assert.equal(next.status, "done");
    assert.equal(second.faux.state.callCount, 1);
  } finally {
    try {
      await harness?.close(context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
