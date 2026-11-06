import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeConfig } from "../src/config.js";
import { Inbox } from "../src/inbox.js";
import { createToolRegistry } from "../src/tools.js";
import { serveTelegram } from "../src/telegram.js";

const context = BACKGROUND_CONTEXT;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const agent = { model: { provider: "faux", modelId: "faux-1" } };
const input = { type: "input", content: "Run the side effect.", requestId: "crash-request" } as const;

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
  // Register before the kill so an exit that lands in between is not missed.
  const exited = once(child, "exit");
  try {
    await waitForFile(startedFile);
  } finally {
    child.kill("SIGKILL");
  }
  await exited;
}

async function runCli(directory: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", join(projectRoot, "src", "deliveries.ts"), ...args], {
    cwd: projectRoot,
    env: { ...process.env, DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  return { code: code as number | null, stdout, stderr };
}

function modelFixture() {
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function sideEffectTool(runsFile: string, mode: "safe" | "unsafe") {
  return defineTool({
    name: "side_effect",
    description: "Record one execution.",
    parameters: Type.Object({}, { additionalProperties: false }),
    ...(mode === "safe" ? { replay: "safe" as const } : {}),
    execute: async () => {
      await appendFile(runsFile, "run\n");
      return { output: [{ type: "text", text: "side effect ran" }] };
    },
  });
}

for (const mode of ["safe", "unsafe"] as const) {
  test(`an interrupted ${mode} tool follows its replay policy after a process crash`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `pa-replay-${mode}-`));
    const database = join(directory, "agent.sqlite");
    const startedFile = join(directory, "started.txt");
    const runsFile = `${startedFile}.runs`;
    let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
    try {
      await crashAt(startedFile, "crash-tool.ts", [database, startedFile, mode]);
      assert.equal(await readFile(runsFile, "utf8"), "run\n", "the interrupted attempt ran exactly once");

      const { faux, models } = modelFixture();
      faux.setResponses([fauxAssistantMessage("Recovered answer.")]);
      const registry = createRegistry();
      registry.install(defineExtension({ name: "test-tools", tools: [sideEffectTool(runsFile, mode)] }));
      harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
      const root = await harness.root(context, { agent });
      harness.resume();
      const settled = await (await root.submit(input, context)).wait(context);
      assert.equal(settled.status, "done");

      const entries = await root.entries({}, 100, undefined, context);
      const results = entries.items
        .filter((entry) => ToolResultEntry.is(entry))
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      const result = results.find((message) => message.toolCallId === "side");
      assert.ok(result);
      const runs = await readFile(runsFile, "utf8");
      if (mode === "safe") {
        assert.equal(runs, "run\nrun\n", "a safe tool reruns after recovery");
        assert.equal(result.isError, false);
      } else {
        assert.equal(runs, "run\n", "an unsafe tool is never rerun after recovery");
        assert.equal(result.isError, true);
        assert.ok(result.content.some((part) => part.type === "text" && part.text.includes("interrupted and may have partially run")));
      }
    } finally {
      try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
}

test("a crash while a segment is sending quarantines it and later sends only stored text", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-crash-delivery-"));
  const database = join(directory, "inbox.sqlite");
  const startedFile = join(directory, "started.txt");
  try {
    await crashAt(startedFile, "crash-inbox.ts", [database, startedFile]);
    const inbox = new Inbox(database);
    try {
      inbox.recover();
      assert.deepEqual(inbox.blocked().map((row) => [row.part, row.status, row.error]), [[0, "uncertain", "PROCESS_INTERRUPTED"]]);
      assert.equal(inbox.next(), undefined, "an unconfirmed segment is not resent automatically");
      assert.equal(inbox.nextPart("telegram:99:12")?.part, 1);

      inbox.resolvePart("telegram:99:12", 0, "retry");
      const sent: string[] = [];
      const shutdown = new AbortController();
      let executions = 0;
      await serveTelegram(
        { token: "fake", ownerId: "42", telegramEnabled: true, console: undefined, provider: "openai", model: "fake", dataDir: directory, mcpConfigPath: join(directory, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined, trace: { enabled: false } } satisfies RuntimeConfig,
        "99",
        inbox,
        async () => { executions++; throw new Error("must not rerun the agent"); },
        shutdown.signal,
        {
          send: async (_chat, text) => { sent.push(text); return String(100 + sent.length); },
          updates: async () => { shutdown.abort(); return []; },
        },
      );
      assert.deepEqual(sent, ["a".repeat(4000), "tail"]);
      assert.equal(executions, 0);
      assert.equal(inbox.blocked().length, 0);
    } finally {
      inbox.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery CLI recovers an interrupted send before listing and resolving it", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-cli-recover-"));
  const database = join(directory, "inbox.sqlite");
  const startedFile = join(directory, "started.txt");
  try {
    await crashAt(startedFile, "crash-inbox.ts", [database, startedFile]);

    const list = await runCli(directory, ["list"]);
    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout) as { blocked: { requestId: string; status: string; part: number }[] };
    assert.deepEqual(output.blocked.map((row) => [row.requestId, row.status, row.part]),
      [["telegram:99:12", "uncertain", 0]], "a leftover sending part must be visible to the operator");

    const inbox = new Inbox(database);
    try {
      assert.equal(inbox.next(), undefined, "a request with an unresolved interrupted part is not sent automatically");
      assert.equal(inbox.nextPart("telegram:99:12")?.part, 1, "the unresolved interrupted part itself is not pending");
    } finally {
      inbox.close();
    }

    const retry = await runCli(directory, ["retry", "telegram:99:12", "0"]);
    assert.equal(retry.code, 0, retry.stderr);

    const reopened = new Inbox(database);
    try {
      assert.equal(reopened.nextPart("telegram:99:12")?.part, 0, "retry makes the stored part pending again");
      reopened.recover();
      reopened.recover();
      assert.equal(reopened.blocked().length, 0, "recover is idempotent after resolution");
      assert.equal(reopened.nextPart("telegram:99:12")?.part, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bash output is bounded and the model is told where the full output went", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-bash-limits-"));
  const workspace = join(directory, "workspace");
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    const { faux, models } = modelFixture();
    const observed: { isError?: boolean; text: string } = { text: "" };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: `node -e "process.stdout.write('x'.repeat(60000))"` }, { id: "big" }), { stopReason: "toolUse" }),
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult" && message.toolCallId === "big");
        if (result?.role === "toolResult") {
          observed.isError = result.isError;
          observed.text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        }
        return fauxAssistantMessage("done");
      },
    ]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
      models,
      registry: createToolRegistry(),
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    }, context);
    const root = await harness.root(context, { agent });
    await root.configure({ model: agent.model, cwd: workspace }, context);
    harness.resume();
    assert.equal((await (await root.submit({ type: "input", content: "Produce lots of output.", requestId: "big-output" }, context)).wait(context)).status, "done");

    assert.equal(observed.isError, false);
    assert.ok(observed.text.length < 60_000, "the model receives only the retained window");
    assert.match(observed.text, /Output truncated to its end/);
    const fullOutput = observed.text.match(/Full output: (.+)/)?.[1]?.trim();
    assert.ok(fullOutput, "the truncation diagnostic names the spilled file");
    await access(fullOutput);
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("read truncation names the offset that continues the file", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-read-limits-"));
  const workspace = join(directory, "workspace");
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "big.txt"), Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"));
    const { faux, models } = modelFixture();
    let text = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "big.txt" }, { id: "big-read" }), { stopReason: "toolUse" }),
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult" && message.toolCallId === "big-read");
        if (result?.role === "toolResult")
          text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        return fauxAssistantMessage("done");
      },
    ]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
      models,
      registry: createToolRegistry(),
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    }, context);
    const root = await harness.root(context, { agent });
    await root.configure({ model: agent.model, cwd: workspace }, context);
    harness.resume();
    await (await root.submit({ type: "input", content: "Read the big file.", requestId: "big-read" }, context)).wait(context);

    assert.match(text, /Showing lines 1-2000 of 2500/);
    assert.match(text, /Use offset=2001 to continue\./);
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("aborting a run kills a running bash command and its child process", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-cancel-bash-"));
  const workspace = join(directory, "workspace");
  const started = join(workspace, "started.txt");
  const late = join(workspace, "late.txt");
  const posix = (path: string) => path.replaceAll("\\", "/");
  const command = `echo started > '${posix(started)}'; node -e "setTimeout(()=>require('fs').writeFileSync('${posix(late)}','late'),5000)"`;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    const { faux, models } = modelFixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command }, { id: "slow" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("unreachable"),
    ]);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
      models,
      registry: createToolRegistry(),
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    }, context);
    const root = await harness.root(context, { agent });
    await root.configure({ model: agent.model, cwd: workspace }, context);
    harness.resume();
    const submission = await root.submit({ type: "input", content: "Run a slow command.", requestId: "cancel-bash" }, context);
    await waitForFile(started);
    await root.abort(context);
    const settled = await submission.wait(context);
    assert.notEqual(settled.status, "done", "an aborted run must not report success");
    // The command schedules a write five seconds after it starts; cancellation must prevent it.
    await delay(6_000);
    await assert.rejects(access(late), "the killed command must not perform its delayed write");
  } finally {
    try { await harness?.close(context); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
