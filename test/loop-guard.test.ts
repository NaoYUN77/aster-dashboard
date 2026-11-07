import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { AgentLoopDetectedError } from "../src/loop-guard.js";
import type { TextRequest } from "../src/messages.js";

const running = new AbortController().signal;

const request: TextRequest = {
  requestId: "console:loop-guard:req-00000001",
  conversationId: "loop-guard",
  senderId: "console",
  text: "Keep working.",
};

function appConfig(dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const full = {
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

function toolResult(transcript: { messages: readonly Message[] }, id: string) {
  const result = transcript.messages.find((message) =>
    message.role === "toolResult" && message.toolCallId === id);
  const available = transcript.messages.flatMap((message) =>
    message.role === "toolResult" ? [message.toolCallId] : []);
  assert.ok(result?.role === "toolResult",
    `missing tool result ${id}; available: ${available.join(",") || "(none)"}`);
  return result;
}

function toolResultText(transcript: { messages: readonly Message[] }, id: string): string {
  return toolResult(transcript, id).content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("");
}

function audit(lines: readonly string[], code: string): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === "loop_guard" && event.code === code);
}

test("three identical calls warn at 3 without stopping the run", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-loop-warning-"));
  const review: string[] = [];
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t1" }), { stopReason: "toolUse" }),
      (transcript) => {
        assert.doesNotMatch(toolResultText(transcript, "t1"), /Loop Guard Warning/);
        return fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t2" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.doesNotMatch(toolResultText(transcript, "t2"), /Loop Guard Warning/);
        return fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t3" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const text = toolResultText(transcript, "t3");
        assert.match(text, /\[Loop Guard Warning\]: You have made the exact same tool call 3 times consecutively\./);
        assert.match(text, /inspect intermediate state or change your strategy/);
        return fauxAssistantMessage("finished");
      },
    ]);
    app = await openAgent(appConfig(directory), fixture.models, undefined, {
      toolReviewLog: (line) => review.push(line),
    });
    assert.equal(await app.reply({ ...request, requestId: "telegram:loop:warn" }, running), "finished");
    const warnings = audit(review, "LOOP_GUARD_WARNING");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.tool, "current_time");
    assert.equal(warnings[0]?.count, 3);
    assert.equal("arguments" in (warnings[0] ?? {}), false, "the audit never records tool arguments");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("six identical calls halt with AGENT_LOOP_DETECTED and the next request recovers", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-loop-halt-"));
  const review: string[] = [];
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t3" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t4" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t5" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t6" }), { stopReason: "toolUse" }),
    ]);
    app = await openAgent(appConfig(directory), fixture.models, undefined, {
      toolReviewLog: (line) => review.push(line),
    });
    await assert.rejects(
      app.reply({ ...request, requestId: "telegram:loop:halt" }, running),
      (error: unknown) => error instanceof AgentLoopDetectedError
        && error.code === "AGENT_LOOP_DETECTED"
        && error.reason === "repeated_call"
        && /called 6 times consecutively/.test(error.message),
    );
    assert.equal(audit(review, "LOOP_GUARD_WARNING").length, 3, "warnings fired at 3, 4 and 5");
    assert.equal(audit(review, "LOOP_GUARD_HALT").length, 1);

    // The Session is still healthy: a fresh request starts a fresh bounded run.
    fixture.faux.appendResponses([fauxAssistantMessage("recovered")]);
    assert.equal(await app.reply({ ...request, requestId: "telegram:loop:recover" }, running), "recovered");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("six consecutive failing calls halt with AGENT_LOOP_DETECTED", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-loop-errors-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses(Array.from({ length: 6 }, (_, index) => {
      const id = `e${index + 1}`;
      return fauxAssistantMessage(
        fauxToolCall("read", { path: `missing-${index + 1}.txt` }, { id }),
        { stopReason: "toolUse" },
      );
    }));
    app = await openAgent(appConfig(directory), fixture.models);
    await assert.rejects(
      app.reply({ ...request, requestId: "telegram:loop:errors" }, running),
      (error: unknown) => error instanceof AgentLoopDetectedError
        && error.code === "AGENT_LOOP_DETECTED"
        && error.reason === "consecutive_errors"
        && /6 consecutive tool calls failed/.test(error.message),
    );
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a different successful call resets the identical-call counter", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-loop-reset-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await mkdir(join(directory, "workspace"), { recursive: true });
    await writeFile(join(directory, "workspace", "probe.txt"), "probe", "utf8");
    const fixture = modelFixture();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t1" }), { stopReason: "toolUse" }),
      (transcript) => {
        assert.doesNotMatch(toolResultText(transcript, "t1"), /Loop Guard Warning/);
        return fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t2" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.doesNotMatch(toolResultText(transcript, "t2"), /Loop Guard Warning/);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "probe.txt" }, { id: "probe" }),
          { stopReason: "toolUse" },
        );
      },
      (transcript) => {
        const result = toolResult(transcript, "probe");
        assert.notEqual(result.isError, true);
        assert.match(toolResultText(transcript, "probe"), /probe/);
        return fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t3" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.doesNotMatch(toolResultText(transcript, "t3"), /Loop Guard Warning/,
          "a different successful call reset the streak");
        return fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t4" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.doesNotMatch(toolResultText(transcript, "t4"), /Loop Guard Warning/,
          "the streak counts from one after the reset");
        return fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "t5" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        assert.match(toolResultText(transcript, "t5"), /exact same tool call 3 times consecutively/);
        return fauxAssistantMessage("done");
      },
    ]);
    app = await openAgent(appConfig(directory), fixture.models);
    assert.equal(await app.reply({ ...request, requestId: "console:loop-guard:req-00000002" }, running), "done");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
