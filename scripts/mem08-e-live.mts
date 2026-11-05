// MEM-08 / 08-E live verification: drive the real memory integration with a real
// DeepSeek model (deepseek-v4-pro) and judge what the summaries, the archive and
// the model's own recall retain. One-off acceptance script, not a test: it talks
// to the real provider through the vault surrogate (the key itself never enters
// this process; only the hsurr:* surrogate does, in memory, never printed).
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { Harness, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolRegistry } from "../src/tools.js";
import { MEMORY_BUDGET_DEFAULTS } from "../src/memory/contracts.js";
import { publishedSnapshot } from "../src/memory/compaction.js";
import { createMemoryIntegration } from "../src/memory/integration.js";

const run = promisify(execFile);
const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "deepseek", modelId: process.env.MEM08_E_MODEL ?? "deepseek-flash" } as const;
const INSTRUCTIONS = "You are a personal assistant. Answer concisely in the user's language. Use memory tools when past facts matter.";

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
}

async function allEntries(harness: Harness, root: Conversation): Promise<EntryRecord[]> {
  const page = await root.entries({ order: "ascending" }, 2_000, undefined, context);
  return [...page.items];
}

async function lastAssistantText(harness: Harness, root: Conversation): Promise<string> {
  const entries = await allEntries(harness, root);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind !== "pi.assistant") continue;
    // pi-durable stores an assistant turn's messages on `model`, not `data`.
    const messages = (entry as unknown as { model?: Message[] }).model ?? [];
    for (let j = messages.length - 1; j >= 0; j -= 1) {
      if (messages[j]!.role === "assistant") return messageText(messages[j]!);
    }
  }
  return "";
}

const surrogate = (await run("python3", [
  join(process.env.HOME!, "workspace/custom-connectors/custom.deepseek/bin/deepseek_call.py"),
  "surrogate",
])).stdout.trim();
if (!surrogate.startsWith("hsurr:")) throw new Error("credential surrogate unavailable");
process.env.DEEPSEEK_API_KEY = surrogate;

const directory = await mkdtemp(join(tmpdir(), "mem08-e-live-"));
const workspace = join(directory, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "MEMORY.md"), "", { flag: "a" });
console.log("workdir:", directory);

const models = createModels();
models.setProvider(deepseekProvider());
const budget = { ...MEMORY_BUDGET_DEFAULTS, evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 };
const integration = createMemoryIntegration({
  root: directory,
  instructions: INSTRUCTIONS,
  model: MODEL,
  contextWindow: 1_000_000,
  budget,
  reserveTokens: 16_384,
  timezone: "Asia/Shanghai",
  log: () => {},
});
const registry = createToolRegistry();
for (const extension of integration.extensions()) registry.install(extension);
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
  models,
  registry,
  settings: { toolExecution: "sequential", compaction: integration.compactionSettings() },
}, context);
const root = await harness.root(context);
await root.configure({ model: MODEL, cwd: workspace, instructions: INSTRUCTIONS }, context);
integration.attach(harness, root);
await integration.initialize(context);
harness.resume();

async function drive(id: string, text: string): Promise<string> {
  const prepared = await integration.prepareRequest({ requestId: id, text }, context);
  const submission = await root.submit({ type: "input", content: text, requestId: id }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done") throw new Error(`request ${id} settled as ${settled.status}`);
  if (prepared.kind !== "replay") await integration.afterRequest(id, context);
  return lastAssistantText(harness, root);
}

const script: [string, string][] = [
  ["e1", "我现在最重要的项目是个人网站 v2，目标在 11 月 15 日之前上线。"],
  ["e2", "这个项目有两个硬约束：必须用静态生成，不用需要服务器的框架；总预算不超过 500 元。"],
  ["e3", "目前进度：首页已经完成，博客列表页做到一半，关于页面还没开始。"],
  ["e4", "这个项目的发布代号叫『蓝鲸-7』。另外主题风格我喜欢深色。"],
  ["e5", "更正一下刚才的：主题改用浅色，深色不要了，后面都按浅色来。"],
  ["e6", "接下来你建议我先推进哪一块？简单说就行。"],
  ["e7", "好，就按你说的顺序来。还有，博客列表页的分页每页 20 条，这个细节记一下。"],
  ["e8", "部署的事以后再说，先把内容页做完。你把我现在的待办按进度列一下。"],
  ["e9", "没问题，继续。另外提醒我自己：关于页面要放联系表单，但表单走第三方服务，不占自有服务器。"],
];
for (const [id, text] of script) {
  const reply = await drive(id, text);
  console.log(`--- ${id} reply (${reply.length} chars): ${reply.slice(0, 120).replaceAll("\n", " ")}`);
}

// Wait for background compaction/archive work to settle.
async function quiesce(): Promise<void> {
  const deadline = Date.now() + 240_000;
  let lastHead: unknown;
  let stable = 0;
  for (;;) {
    const tasks = await harness.commit(
      async (tx) => (await tx.scanTasks({ conversationId: root.id }, 200)).items, context,
    );
    const active = tasks.some((task) => task.state.status !== "terminal");
    const head = (await root.context(context)).head?.id;
    if (!active && head === lastHead) stable += 1; else stable = 0;
    lastHead = head;
    if (stable >= 2) return;
    if (Date.now() > deadline) throw new Error("background work did not quiesce");
    await delay(500);
  }
}
await quiesce();

const entries = await allEntries(harness, root);
const compactions = entries.filter((entry) => entry.kind === "pi.compaction" && publishedSnapshot(entry) !== undefined);
console.log("published compactions:", compactions.length);
const snapshot = compactions.length > 0 ? publishedSnapshot(compactions.at(-1)!) : undefined;
const snapshotText = snapshot ? JSON.stringify(snapshot) : "";
console.log("--- latest published snapshot ---");
console.log(snapshotText.slice(0, 4000));

const probe = await drive("e10", "帮我复述一下这个项目的目标日期、两个硬约束、当前进度、发布代号和主题偏好，我要确认你都记住了。");
console.log("--- probe reply ---");
console.log(probe);

// Daily archive files under the data root.
async function listMarkdown(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listMarkdown(path, prefix));
    else if (entry.name.endsWith(".md") && entry.name !== "MEMORY.md") found.push(path);
  }
  return found;
}
const dailyFiles = await listMarkdown(directory);
console.log("daily archive files:", dailyFiles);
for (const file of dailyFiles) {
  console.log(`--- ${file.replace(directory, "")} ---`);
  console.log((await readFile(file, "utf8")).slice(0, 4000));
}

let dailyText = "";
for (const file of dailyFiles) dailyText += await readFile(file, "utf8");
const { readWorking } = await import("../src/memory/working.js");
const working = await readWorking(harness, root.id, context);
console.log("--- working state after run ---");
console.log(JSON.stringify(working).slice(0, 1200));
const checks: Record<string, boolean> = {
  "Q1 目标(11月15日+上线)": probe.includes("11") && probe.includes("15") && probe.includes("上线"),
  "Q2 约束(静态)": probe.includes("静态"),
  "Q2 约束(500)": probe.includes("500"),
  "Q3 进度(博客列表)": probe.includes("博客列表"),
  "Q3 进度(关于页面未开始)": probe.includes("关于页面") && (probe.includes("还没") || probe.includes("未开始") || probe.includes("没有开始")),
  "Q4 纠正(浅色)": probe.includes("浅色"),
  "Q5 代号(蓝鲸-7)": probe.includes("蓝鲸"),
  "S1 快照含目标日期": snapshotText.includes("11") && snapshotText.includes("15"),
  "S2 快照含代号": snapshotText.includes("蓝鲸"),
  "F1 working 已落盘(revision>1)": working.revision > 1,
  "F2 无捏造年份2025(探针)": !probe.includes("2025"),
  "F2 无捏造年份2025(快照)": !snapshotText.includes("2025"),
  "F2 无捏造年份2025(归档)": !dailyText.includes("2025"),
};
console.log("=== CHECKS ===");
console.log(JSON.stringify(checks, null, 2));

integration.close();
await harness.close(context).catch(() => {});
console.log("DONE workdir:", directory);
