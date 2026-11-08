// Background jobs (ADR-0024, `docs/spec-20261108-background-jobs.md`). Three layers are asserted
// here, each at its own altitude:
//
//   * the contracts — what a stored outcome may be, how the notice text stays bounded and
//     deterministic, and how the per-command time limit is derived from the transport's own ceiling
//     rather than from a model parameter;
//   * the index — `background_jobs` rows and the one-notice-per-job rule, in a real SQLite file;
//   * the service — dispatch ordering, refusals, cancellation and the startup reconciler, with a
//     fake task host so every branch is reachable without racing a real run;
//   * the task — every terminal path of the durable job, driven through its own phase and abort
//     handlers, because "a command that exited 3 is a job that ran" is the contract the deletion gate
//     and the notice both rest on.
//
// Two end-to-end tests then drive the real composition: a faux model calls `job_start`, the console
// reads the job back as `done`, exactly one notice is unread, marking it read clears the badge, a
// request sent while a job runs is answered, and a bot's removal takes its job rows and notices away
// with its conversation.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RunningTask, TaskRuntime } from "@earendil-works/pi-durable";
import { FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Inbox, jobIdFor, type BackgroundJobRecord } from "../src/inbox.js";
import {
  JOB_COMMAND_MAX_CHARS, JOB_LIVE_LIMIT, JOB_LOCAL_TIMEOUT_SECONDS, JOB_NOTICE_MAX_CHARS,
  JOB_OUTPUT_TAIL_BYTES, JOB_TASK_KIND, TailText, jobNoticeText, jobTimeoutSeconds, parseJobOutcome,
  tailByBytes, type JobOutcome,
} from "../src/jobs/contracts.js";
import { BackgroundJobs, type JobDispatcher, type JobTaskFacts, type JobTaskHost } from "../src/jobs/service.js";
import { createJobTask, jobDirectoryName, type JobCheckpoint, type JobTaskInput, type JobTaskOptions } from "../src/jobs/task.js";
import { startService, type ServiceHandle } from "../src/main.js";
import { DEFAULT_CATALOG_PROFILE } from "../src/tool-catalog.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "{{SECRET_jobs00000001}}";
const MODEL = "faux-1";

// --- Contracts ---------------------------------------------------------------------------------

test("a stored outcome is read back only in shapes this build can state", () => {
  assert.equal(parseJobOutcome(null), undefined);
  assert.equal(parseJobOutcome([]), undefined, "an array is not an outcome");
  assert.equal(parseJobOutcome("done"), undefined, "a bare state is not an outcome");
  assert.equal(parseJobOutcome({ state: "running" }), undefined, "a live state is not an outcome");
  assert.equal(parseJobOutcome({ state: "queued" }), undefined);
  assert.equal(parseJobOutcome({ state: "done", exitCode: 1.5 }), undefined, "an exit code is an integer");
  assert.equal(parseJobOutcome({ state: "done", exitCode: "not a number" }), undefined);

  const outcome = parseJobOutcome({ state: "failed", exitCode: 3, error: "JOB_FAILED", output: "tail" });
  assert.deepEqual(outcome, { state: "failed", exitCode: 3, error: "JOB_FAILED", output: "tail" });
  assert.ok(outcome !== undefined && Object.isFrozen(outcome), "a decoded outcome is not a mutable view");
  // Absent facts stay absent: a missing error is not "no error happened", it is "none recorded".
  assert.deepEqual(parseJobOutcome({ state: "unknown" }), { state: "unknown", exitCode: null, error: null, output: "" });
  // A transport exception's message is not a business code; the field is bounded so it never grows into one.
  assert.equal(parseJobOutcome({ state: "unknown", error: "x".repeat(200) })?.error?.length, 64);
  assert.equal(parseJobOutcome({ state: "unknown", output: 42 })?.output, "");
});

test("the notice is deterministic, quotes the facts, and stays bounded", () => {
  const outcome: JobOutcome = { state: "done", exitCode: 0, error: null, output: "line one\nline two\n" };
  const text = jobNoticeText(jobIdFor("alpha", UUID), "make build", outcome, 12_340);
  // The same terminal state must render the same text: a replayed write can never publish a second,
  // differently worded notice.
  assert.equal(text, jobNoticeText(jobIdFor("alpha", UUID), "make build", outcome, 12_340));
  assert.match(text, /^后台作业已完成：make build/);
  assert.match(text, /作业 job:alpha:11111111-2222-3333-4444-555555555555/);
  assert.match(text, /退出码 0/);
  assert.match(text, /耗时 12\.3s/);
  assert.match(text, /输出尾：\nline one\nline two/);
  assert.doesNotMatch(text, /错误码/, "a successful job states no failure code");

  const unknown = jobNoticeText(jobIdFor("alpha", UUID), "curl -C - big.iso", {
    state: "unknown", exitCode: null, error: "JOB_INTERRUPTED", output: "   ",
  }, null);
  assert.match(unknown, /^后台作业结果未知：curl -C - big\.iso/);
  assert.match(unknown, /错误码 JOB_INTERRUPTED/);
  assert.doesNotMatch(unknown, /退出码|耗时|输出尾/, "facts that were never established are absent, not zeroed");

  const bounded = jobNoticeText(jobIdFor("alpha", UUID), "x".repeat(JOB_COMMAND_MAX_CHARS), {
    state: "failed", exitCode: 1, error: "JOB_FAILED", output: "y".repeat(JOB_OUTPUT_TAIL_BYTES),
  }, 1_000);
  assert.ok(bounded.length <= JOB_NOTICE_MAX_CHARS + 1, `notice is ${bounded.length} chars`);
  assert.match(bounded, /^后台作业失败：x{200}…/, "the quoted command is cut at the display bound");
});

test("an output tail is cut by UTF-8 bytes, never inside a character", () => {
  assert.equal(tailByBytes("abcdef", 3), "def");
  assert.equal(tailByBytes("abc", 10), "abc", "a short text is kept whole");
  assert.equal(tailByBytes("abc", 0), "");
  // "a😀b" is 6 bytes. Three and four bytes both land on a boundary that a one-byte-per-step cut
  // would have split.
  assert.equal(tailByBytes("a😀b", 3), "b");
  assert.equal(tailByBytes("a😀b", 5), "😀b");
  assert.equal(tailByBytes("a😀b", 1), "b");
  assert.equal(Buffer.byteLength(tailByBytes("a😀b", 4), "utf8"), 1);

  const tail = new TailText(8);
  for (const chunk of ["aaa", "bbb", "ccc", "ddd"]) tail.push(chunk);
  assert.equal(tail.text(), "bbcccddd", "compaction keeps the newest bytes, not the oldest");
  for (let index = 0; index < 10; index += 1) tail.push("😀");
  assert.ok(Buffer.byteLength(tail.text(), "utf8") <= 8);
  assert.ok(tail.text().endsWith("😀"), "a chunk larger than the bound still lands on a character boundary");
  // Decoding what was kept must give the same string back: a split character would show up here.
  assert.equal(Buffer.from(tail.text(), "utf8").toString("utf8"), tail.text());
  assert.equal(tail.push("x"), undefined);
});

test("a job's time limit is derived from what the transport accepts", () => {
  // The configured ceiling is not the transport ceiling: the direct transport reserves part of its
  // wire deadline, so a job asking for the configured value would be refused before its command ran.
  assert.equal(jobTimeoutSeconds(undefined), JOB_LOCAL_TIMEOUT_SECONDS);
  assert.equal(jobTimeoutSeconds({ transport: "ssh", maxTimeoutSeconds: 1_200 }), 1_200);
  assert.equal(jobTimeoutSeconds({ transport: "rpc", maxTimeoutSeconds: 3_600 }), 3_540);
  assert.equal(jobTimeoutSeconds({ transport: "rpc", maxTimeoutSeconds: 86_400 }), 3_540);
  assert.equal(jobTimeoutSeconds({ transport: "rpc", maxTimeoutSeconds: 100 }), 100, "a smaller ceiling is not raised");
  assert.equal(jobDirectoryName(`job:alpha:${UUID}`), UUID);
  assert.equal(jobDirectoryName("not-a-job-id"), "not-a-job-id");
});

// --- The durable task --------------------------------------------------------------------------

type Commit = { readonly status: string; readonly checkpoint?: unknown; readonly outcome?: unknown };

function jobInput(overrides: Partial<JobTaskInput> = {}): JobTaskInput {
  return { jobId: jobIdFor("alpha", UUID), botId: "alpha", command: "echo job-ok", timeoutSeconds: 600, ...overrides };
}

function runningTask(input: JobTaskInput, attempts: number): RunningTask<JobTaskInput, JobCheckpoint, JobOutcome> {
  return {
    id: 7,
    conversationId: 41,
    kind: JOB_TASK_KIND,
    version: 1,
    input,
    state: { status: "running", checkpoint: { phase: "execute", attempts } },
  } as unknown as RunningTask<JobTaskInput, JobCheckpoint, JobOutcome>;
}

/** A runtime that records what the task commits, in the order it commits it. */
function runtimeOf(env: ExecutionEnv | undefined, journal: string[], signal = new AbortController().signal) {
  const commits: Commit[] = [];
  const reported: unknown[] = [];
  const runtime = {
    taskId: 7,
    conversationId: 41,
    signal,
    now: () => Date.parse("2026-11-08T00:00:00.000Z"),
    report: (error: unknown) => { reported.push(error); },
    env: async () => env,
    commit: async (change: () => Commit) => {
      const next = change();
      commits.push(next);
      journal.push(next.status === "terminal" ? "commit:terminal" : `commit:${next.status}`);
    },
  } as unknown as TaskRuntime<JobTaskInput, JobCheckpoint, JobOutcome, object>;
  return { runtime, commits, reported };
}

/**
 * The environment a job runs on. `createDir` refuses by default, the way both remote faces do: a job
 * on a POSIX workspace must reach the shell and never the file API, so a dependency on it shows up
 * as a failure here rather than as a stub that always says yes.
 */
function envOf(
  exec: ExecutionEnv["exec"],
  cwd = "/workspace/alpha",
  createDir: ExecutionEnv["createDir"] = async (path: string) => ({
    ok: false as const,
    error: new FileError("not_supported", "the remote environment supports reading, writing and editing files only", path),
  }),
): ExecutionEnv {
  return {
    cwd,
    joinPath: async (parts: readonly string[]) => ({ ok: true as const, value: parts.join("/") }),
    createDir,
    exec,
  } as unknown as ExecutionEnv;
}

function outcomeOf(commits: readonly Commit[]): JobOutcome {
  const terminal = commits.at(-1);
  assert.equal(terminal?.status, "terminal", "every job path must commit a terminal state");
  const outcome = terminal?.outcome as { status: string; result: unknown };
  // The task-level vocabulary says "the job answered"; a command that exits non-zero is a job that
  // did what it was asked, not a broken task. The deletion gate reads the same field.
  assert.equal(outcome.status, "completed");
  return parseJobOutcome(outcome.result) as JobOutcome;
}

type TaskRun = {
  readonly journal: string[];
  readonly commits: Commit[];
  readonly outcomes: JobOutcome[];
  readonly started: { jobId: string; botId: string; startedAt: string }[];
  readonly prepared: string[];
  readonly executed: { command: string; cwd: string; timeout: number | undefined }[];
};

type PhaseOptions = {
  readonly signal?: AbortSignal;
  /** Answers the `mkdir` the task runs; the default succeeds. */
  readonly mkdir?: ExecutionEnv["exec"];
  readonly cwd?: string;
  readonly createDir?: ExecutionEnv["createDir"];
};

async function runPhase(
  input: JobTaskInput,
  attempts: number,
  exec: ExecutionEnv["exec"],
  phase: PhaseOptions = {},
): Promise<TaskRun> {
  const journal: string[] = [];
  const outcomes: JobOutcome[] = [];
  const started: TaskRun["started"] = [];
  const prepared: string[] = [];
  const executed: TaskRun["executed"] = [];
  const options: JobTaskOptions = {
    onStarted: (jobId, botId, startedAt) => started.push({ jobId, botId, startedAt }),
    onTerminal: (_jobId, outcome) => outcomes.push(outcome),
  };
  const task = createJobTask(options);
  const mkdir = phase.mkdir ?? (async () => ({ ok: true as const, value: { exitCode: 0 } }));
  const env = envOf(async (command, shellOptions) => {
    // The task makes the job's directory with the shell, so the harness answers the two commands
    // separately: a test that fails the real command must not fail the directory with it.
    if (String(command).startsWith("mkdir -p -- ")) {
      journal.push("mkdir");
      prepared.push(String(command));
      return mkdir(command, shellOptions, BACKGROUND_CONTEXT);
    }
    journal.push("exec");
    executed.push({ command: String(command), cwd: String(shellOptions?.cwd), timeout: shellOptions?.timeout });
    return exec(command, shellOptions, BACKGROUND_CONTEXT);
  }, phase.cwd ?? "/workspace/alpha", phase.createDir);
  const { runtime, commits } = runtimeOf(env, journal, phase.signal);
  await task.definition.phases.execute(runningTask(input, attempts), runtime, BACKGROUND_CONTEXT);
  return { journal, commits, outcomes, started, prepared, executed };
}

test("a command is run once, in its own directory, under the host's limit", async () => {
  const run = await runPhase(jobInput(), 0, async (_command, options) => {
    options?.onOutput?.("partial ", BACKGROUND_CONTEXT, { stream: "stdout" });
    options?.onOutput?.("job-ok\n", BACKGROUND_CONTEXT, { stream: "stdout" });
    return { ok: true, value: { exitCode: 0 } };
  });
  // The durable proof that the command may have run must precede every command the task runs.
  assert.deepEqual(run.journal, ["commit:running", "mkdir", "exec", "commit:terminal"]);
  assert.deepEqual(run.commits[0], { status: "running", checkpoint: { phase: "execute", attempts: 1 } });
  // The directory is made by the shell, quoted as one word, and without a timeout of its own.
  assert.deepEqual(run.prepared, [`mkdir -p -- '/workspace/alpha/jobs/${UUID}'`]);
  assert.deepEqual(run.executed, [{
    command: "echo job-ok",
    cwd: `/workspace/alpha/jobs/${UUID}`,
    timeout: 600,
  }]);
  assert.deepEqual(run.started, [{ jobId: jobIdFor("alpha", UUID), botId: "alpha", startedAt: "2026-11-08T00:00:00.000Z" }]);
  assert.deepEqual(outcomeOf(run.commits), { state: "done", exitCode: 0, error: null, output: "partial job-ok\n" });
  assert.deepEqual(run.outcomes, [outcomeOf(run.commits)], "the host callback sees the same outcome that was committed");
});

test("a working directory that cannot be made fails the job before the command is handed over", async () => {
  const ok = async () => ({ ok: true as const, value: { exitCode: 0 } });
  // `mkdir` is a command like any other: a non-zero exit is a failure the operator can act on.
  const refused = await runPhase(jobInput(), 0, ok, {
    mkdir: async () => ({ ok: true, value: { exitCode: 1 } }),
  });
  assert.deepEqual(outcomeOf(refused.commits), { state: "failed", exitCode: null, error: "JOB_WORKDIR", output: "" });
  assert.deepEqual(refused.executed, [], "the job's command is never handed over");

  // An environment that throws is a failure too, never a success.
  const threw = await runPhase(jobInput(), 0, ok, { mkdir: async () => { throw new Error("no shell"); } });
  assert.deepEqual(outcomeOf(threw.commits), { state: "failed", exitCode: null, error: "JOB_WORKDIR", output: "" });
  assert.deepEqual(threw.executed, []);

  // A cancelled preparation is the cancellation's terminal state, not a workdir failure: the phase
  // stops without committing anything, and the abort protocol owns the outcome.
  const controller = new AbortController();
  await assert.rejects(runPhase(jobInput(), 0, ok, {
    signal: controller.signal,
    mkdir: async () => {
      controller.abort();
      return { ok: false, error: Object.assign(new Error("aborted"), { code: "aborted" as const }) };
    },
  }));
});

test("a workspace that is not a POSIX path uses the environment's own directory primitive", async () => {
  // Both remote faces are POSIX. A non-POSIX workspace is the local Node environment on Windows,
  // whose shell the task cannot spell for from here, so `createDir` is the only primitive left —
  // and a face that refuses it leaves the job unrunnable rather than quietly making the wrong
  // directory somewhere the command will not run.
  const ok = async () => ({ ok: true as const, value: { exitCode: 0 } });
  const refused = await runPhase(jobInput(), 0, ok, { cwd: "C:\\work\\alpha" });
  assert.deepEqual(refused.journal, ["commit:running", "commit:terminal"]);
  assert.deepEqual(outcomeOf(refused.commits), { state: "failed", exitCode: null, error: "JOB_WORKDIR", output: "" });

  const accepted = await runPhase(jobInput(), 0, ok, {
    cwd: "C:\\work\\alpha",
    createDir: async () => ({ ok: true as const, value: undefined }),
  });
  assert.deepEqual(accepted.prepared, [], "no shell command is spelled for a shell the task does not know");
  assert.deepEqual(accepted.journal, ["commit:running", "exec", "commit:terminal"]);
  assert.deepEqual(outcomeOf(accepted.commits), { state: "done", exitCode: 0, error: null, output: "" });
});

test("a path that is not a plain word stays one word for the shell", async () => {
  const run = await runPhase(jobInput(), 0, async () => ({ ok: true, value: { exitCode: 0 } }),
    { cwd: "/workspace/it's alpha" });
  assert.deepEqual(run.prepared, [`mkdir -p -- '/workspace/it'\\''s alpha/jobs/${UUID}'`]);
});

test("a command that was already handed to an environment is never run again", async () => {
  let executions = 0;
  const run = await runPhase(jobInput(), 1, async () => {
    executions += 1;
    return { ok: true, value: { exitCode: 0 } };
  });
  assert.equal(executions, 0, "a restart must not replay a command whose side effects may already exist");
  assert.deepEqual(run.started, []);
  assert.deepEqual(outcomeOf(run.commits), { state: "unknown", exitCode: null, error: "JOB_INTERRUPTED", output: "" });
});

test("a non-zero exit is a result, a timeout is a failure, anything else is unknown", async () => {
  const failed = await runPhase(jobInput(), 0, async () => ({ ok: true, value: { exitCode: 3 } }));
  assert.deepEqual(outcomeOf(failed.commits), { state: "failed", exitCode: 3, error: "JOB_FAILED", output: "" });

  const timedOut = await runPhase(jobInput(), 0, async () => ({
    ok: false, error: Object.assign(new Error("timed out"), { code: "timeout" as const }),
  }));
  assert.deepEqual(outcomeOf(timedOut.commits), { state: "failed", exitCode: null, error: "JOB_TIMEOUT", output: "" });

  const broken = await runPhase(jobInput(), 0, async () => ({
    ok: false, error: Object.assign(new Error("daemon went away"), { code: "spawn_error" as const }),
  }));
  assert.deepEqual(outcomeOf(broken.commits), { state: "unknown", exitCode: null, error: "JOB_EXECUTION_ERROR", output: "" });

  // An environment that throws instead of returning a Result must not be read as success, and the
  // output seen before it threw is kept: it is evidence, not a partial claim.
  const threw = await runPhase(jobInput(), 0, async (_command, options) => {
    options?.onOutput?.("half a line", BACKGROUND_CONTEXT, { stream: "stdout" });
    throw new Error("killed");
  });
  assert.deepEqual(outcomeOf(threw.commits), {
    state: "unknown", exitCode: null, error: "JOB_EXECUTION_ERROR", output: "half a line",
  });
});

test("the output kept for a job is a bounded tail", async () => {
  const run = await runPhase(jobInput(), 0, async (_command, options) => {
    for (let index = 0; index < 500; index += 1) options?.onOutput?.(`line ${index}\n`, BACKGROUND_CONTEXT, { stream: "stdout" });
    return { ok: true, value: { exitCode: 0 } };
  });
  const output = outcomeOf(run.commits).output;
  assert.ok(Buffer.byteLength(output, "utf8") <= JOB_OUTPUT_TAIL_BYTES);
  assert.match(output, /line 499\n$/, "the tail is the newest output, not the oldest");
});

test("cancellation commits the job's end state without claiming the command never ran", async () => {
  const input = jobInput();
  const journal: string[] = [];
  const outcomes: JobOutcome[] = [];
  const task = createJobTask({ onStarted: () => {}, onTerminal: (_jobId, outcome) => outcomes.push(outcome) });
  const { runtime, commits } = runtimeOf(envOf(async () => ({ ok: true, value: { exitCode: 0 } })), journal);
  await task.definition.abort(runningTask(input, 1), runtime, BACKGROUND_CONTEXT);
  assert.deepEqual(outcomeOf(commits), { state: "canceled", exitCode: null, error: "JOB_CANCELED", output: "" });
  assert.deepEqual(outcomes, [{ state: "canceled", exitCode: null, error: "JOB_CANCELED", output: "" }]);
});

// --- The index ---------------------------------------------------------------------------------

type JobOverrides = Partial<Pick<BackgroundJobRecord, "botId" | "conversationId" | "command" | "state" | "taskId" | "createdAt">>;

function newStore(directory: string): Inbox {
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  for (const [botId, conversationId] of [["alpha", "41"], ["beta", "42"]] as const) {
    inbox.createBot({
      botId, name: botId, conversationId, systemPrompt: "", tools: "bash,files",
      profile: DEFAULT_CATALOG_PROFILE,
    });
  }
  return inbox;
}

function queue(inbox: Inbox, jobId: string, overrides: JobOverrides = {}): void {
  inbox.createJob({
    jobId, botId: "alpha", conversationId: "41", taskId: "", kind: "command", command: "echo hi",
    state: "queued", createdAt: "2026-11-08T00:00:00.000Z", ...overrides,
  });
}

function finish(inbox: Inbox, jobId: string, state: "done" | "failed" | "canceled" | "unknown" = "done"): boolean {
  return inbox.finishJob(jobId, {
    state, exitCode: state === "done" ? 0 : null, error: state === "done" ? null : "JOB_FAILED",
    output: null, notice: `notice for ${jobId}`, finishedAt: "2026-11-08T00:01:00.000Z",
  });
}

test("a job row is bot-scoped, and its task link is only ever filled or restated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-index-"));
  const inbox = newStore(directory);
  try {
    const jobId = jobIdFor("alpha", UUID);
    queue(inbox, jobId);
    const row = inbox.jobForBot("alpha", jobId);
    assert.equal(row?.kind, "command");
    assert.deepEqual(
      { state: row?.state, exitCode: row?.exitCode, output: row?.output, startedAt: row?.startedAt, finishedAt: row?.finishedAt },
      { state: "queued", exitCode: null, output: null, startedAt: null, finishedAt: null },
      "a queued row claims no terminal fact",
    );
    // The bot is part of the predicate, not a filter afterwards: one bot can never read another's job.
    assert.equal(inbox.jobForBot("beta", jobId), undefined);
    assert.ok(inbox.jobById(jobId), "the host's own read takes the id alone");
    assert.equal(inbox.liveJobsForBot("beta").length, 0);

    // The same job id with other content is a caller bug, not a retry: ids are host-minted UUIDs.
    assert.throws(() => queue(inbox, jobId, { command: "other" }), /reused with different content/);
    assert.throws(() => queue(inbox, jobId, { botId: "beta" }), /reused with different content/);
    assert.doesNotThrow(() => queue(inbox, jobId), "re-writing the same row is a no-op");

    assert.throws(() => inbox.linkJobTask(jobId, ""), /empty task id/);
    assert.equal(inbox.linkJobTask(jobId, "7"), true, "the empty slot is filled");
    assert.equal(inbox.linkJobTask(jobId, "7"), true, "restating the same link is idempotent");
    assert.equal(inbox.linkJobTask(jobId, "8"), false, "a later caller cannot repoint a row at another task");
    assert.equal(inbox.jobForBot("alpha", jobId)?.taskId, "7");
    assert.equal(inbox.linkJobTask(jobIdFor("alpha", "99999999-2222-3333-4444-555555555555"), "9"), false);

    assert.deepEqual(inbox.liveJobsForBot("alpha").map((job) => job.jobId), [jobId]);
    assert.equal(inbox.liveJobs().length, 1);
    assert.equal(inbox.markJobRunning("beta", jobId, "2026-11-08T00:00:30.000Z"), false, "another bot cannot start this job");
    assert.equal(inbox.markJobRunning("alpha", jobId, "2026-11-08T00:00:30.000Z"), true);
    assert.equal(inbox.jobForBot("alpha", jobId)?.startedAt, "2026-11-08T00:00:30.000Z");
    assert.equal(inbox.markJobRunning("alpha", jobId, "2026-11-08T00:00:31.000Z"), false, "only a queued row starts");

    assert.equal(finish(inbox, jobId), true);
    assert.equal(finish(inbox, jobId), false, "a second path observing the same end is a no-op, not a failure");
    assert.equal(inbox.liveJobsForBot("alpha").length, 0, "a finished job is not unfinished work");
    assert.equal(inbox.markJobRunning("alpha", jobId, "2026-11-08T00:00:32.000Z"), false);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one job produces one notice, and reading it is bounded by the bot it belongs to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-notice-"));
  const inbox = newStore(directory);
  try {
    const first = jobIdFor("alpha", UUID);
    const second = jobIdFor("alpha", "99999999-2222-3333-4444-555555555555");
    queue(inbox, first);
    queue(inbox, second);
    assert.equal(finish(inbox, first), true);
    assert.equal(finish(inbox, first, "failed"), false, "however many paths see the end, the notice is written once");

    const notices = inbox.noticesForBot("alpha", 20);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.jobId, first);
    assert.equal(notices[0]?.botId, "alpha");
    assert.equal(inbox.unreadNotices("alpha"), 1);
    assert.equal(inbox.unreadNotices("beta"), 0);
    assert.equal(inbox.noticesForBot("beta", 20).length, 0);

    // An id that is not this bot's is ignored rather than an error: the console and the model both
    // name ids, and naming someone else's must not report success.
    assert.equal(inbox.markNoticesRead("beta", [notices[0]!.noticeId]), 0);
    assert.equal(inbox.unreadNotices("alpha"), 1);
    assert.equal(inbox.markNoticesRead("alpha", ["00000000-0000-0000-0000-000000000000"]), 0);
    assert.equal(inbox.markNoticesRead("alpha", [notices[0]!.noticeId]), 1);
    assert.equal(inbox.markNoticesRead("alpha", [notices[0]!.noticeId]), 0, "reading an already-read notice changes nothing");
    assert.equal(inbox.unreadNotices("alpha"), 0);
    assert.ok(inbox.noticesForBot("alpha", 20)[0]?.readAt);

    finish(inbox, second);
    assert.equal(inbox.unreadNotices("alpha"), 1);
    assert.equal(inbox.markNoticesRead("alpha"), 1, "no ids means every unread notice of this bot");
    assert.equal(inbox.unreadNotices("alpha"), 0);

    const dropped = inbox.deleteBotJobs("alpha");
    assert.deepEqual(dropped, { jobs: 2, notices: 2 });
    assert.equal(inbox.liveJobs().length, 0);
    assert.equal(inbox.noticesForBot("alpha", 20).length, 0);
    assert.deepEqual(inbox.deleteBotJobs("alpha"), { jobs: 0, notices: 0 }, "a repeat pass removes nothing");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// --- The service -------------------------------------------------------------------------------

function dispatcher(
  conversationId: number,
  onCreate: (input: unknown, options: unknown) => void,
  taskId = "7",
): JobDispatcher {
  return {
    conversationId,
    createTask: async (_task: unknown, input: unknown, options: unknown) => {
      onCreate(input, options);
      return taskId as never;
    },
  } as unknown as JobDispatcher;
}

function factsOf(jobId: string, taskId: string, outcome: unknown, settled = true): JobTaskFacts {
  return { taskId, jobId, conversationId: "41", settled, outcome };
}

function hostOf(options: {
  readonly task?: (taskId: string) => JobTaskFacts | undefined;
  readonly tasks?: readonly JobTaskFacts[];
  readonly abort?: (taskId: string) => "marked" | "terminal" | "missing";
} = {}): JobTaskHost {
  return {
    task: async (taskId: string) => options.task?.(taskId),
    tasks: async () => options.tasks ?? [],
    abort: async (taskId: string) => options.abort?.(taskId) ?? "missing",
  };
}

test("a dispatch writes the row before the task and returns the queued job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-dispatch-"));
  const inbox = newStore(directory);
  try {
    const jobs = new BackgroundJobs({ index: inbox, timeoutSeconds: 600, log: () => {} });
    const seen: { input: unknown; options: unknown; rowsAtCreation: readonly BackgroundJobRecord[] }[] = [];
    const result = await jobs.start(
      dispatcher(41, (input, options) => {
        seen.push({ input, options, rowsAtCreation: inbox.liveJobsForBot("alpha") });
      }),
      { command: "  make build  " },
      BACKGROUND_CONTEXT,
    );
    assert.ok(result.ok, JSON.stringify(result));
    assert.match(result.value.jobId, /^job:alpha:[0-9a-f-]{36}$/);
    assert.equal(result.value.state, "queued");
    assert.equal(result.value.command, "make build", "the command is stored trimmed");
    assert.equal(result.value.exitCode, null);

    // The row is written first: a crash between the two leaves a job the operator can see and the
    // reconciler can close, never a running command with no record.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.rowsAtCreation.length, 1);
    assert.equal(seen[0]?.rowsAtCreation[0]?.jobId, result.value.jobId);
    assert.equal(seen[0]?.rowsAtCreation[0]?.taskId, "");
    assert.deepEqual(
      { taskId: seen[0]?.rowsAtCreation[0]?.taskId, state: seen[0]?.rowsAtCreation[0]?.state },
      { taskId: "", state: "queued" },
      "the task id is unknown until the base answers",
    );
    // Host facts only: conversation ownership, background, and no restart abandonment — the job
    // survives a restart and is never replayed (the task decides that from its own checkpoint).
    assert.deepEqual(seen[0]?.options, { ownership: { kind: "conversation" }, background: true });
    assert.deepEqual(seen[0]?.input, {
      jobId: result.value.jobId, botId: "alpha", command: "make build", timeoutSeconds: 600,
    });
    const row = inbox.jobForBot("alpha", result.value.jobId);
    assert.equal(row?.taskId, "7", "the row is linked to the task that was created");
    assert.equal(row?.conversationId, "41");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a request the host will not dispatch is refused by name, and nothing is dispatched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-refuse-"));
  const inbox = newStore(directory);
  try {
    const jobs = new BackgroundJobs({ index: inbox, timeoutSeconds: 600, log: () => {} });
    let created = 0;
    const call = (conversationId: number, command: string) =>
      jobs.start(dispatcher(conversationId, () => { created += 1; }), { command }, BACKGROUND_CONTEXT);

    const cases: readonly [string, number, string, string][] = [
      ["", 41, "JOB_EMPTY_COMMAND", ""],
      ["   \n ", 41, "JOB_EMPTY_COMMAND", "a blank command is empty, not a command of spaces"],
      ["x".repeat(JOB_COMMAND_MAX_CHARS + 1), 41, "JOB_COMMAND_TOO_LONG", ""],
      ["echo hi", 99, "JOB_NO_BOT", "a conversation that is not a bot's has no workspace to run in"],
    ];
    for (const [command, conversationId, code, note] of cases) {
      const result = await call(conversationId, command);
      assert.equal(result.ok, false, `${note} ${command.slice(0, 20)}`);
      assert.equal(result.ok === false && result.error.code, code);
      assert.ok(result.ok === false && result.error.message.length > 0, "a refusal states a reason");
    }
    inbox.setBotStatus("beta", "disabled");
    const disabled = await call(42, "echo hi");
    assert.equal(disabled.ok === false && disabled.error.code, "JOB_BOT_INACTIVE");

    for (let number = 0; number < JOB_LIVE_LIMIT; number += 1) {
      queue(inbox, jobIdFor("alpha", `${String(number).repeat(8)}-2222-3333-4444-555555555555`));
    }
    const limited = await call(41, "echo hi");
    assert.equal(limited.ok === false && limited.error.code, "JOB_LIMIT_REACHED");
    // The refusal names what is already running, so the caller can cancel instead of retrying blindly.
    assert.match(limited.ok === false ? limited.error.message : "", /job:alpha:/);

    assert.equal(created, 0, "a refused request never reaches the base");
    assert.equal(inbox.jobsForBot("alpha", 20).length, JOB_LIVE_LIMIT);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dispatch the base refuses ends the row with the reason instead of leaving it live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-nodispatch-"));
  const inbox = newStore(directory);
  try {
    const logs: string[] = [];
    const jobs = new BackgroundJobs({ index: inbox, timeoutSeconds: 600, log: (line) => logs.push(line) });
    const failing = {
      conversationId: 41,
      createTask: async () => { throw new Error("the store is closed"); },
    } as unknown as JobDispatcher;

    await assert.rejects(jobs.start(failing, { command: "echo hi" }, BACKGROUND_CONTEXT), /store is closed/);
    const rows = inbox.jobsForBot("alpha", 20);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, "failed");
    assert.equal(rows[0]?.error, "JOB_NOT_DISPATCHED");
    assert.ok(rows[0]?.finishedAt, "the row is closed now, not left for a later pass to guess about");
    assert.equal(inbox.liveJobsForBot("alpha").length, 0);
    assert.match(inbox.noticesForBot("alpha", 20)[0]?.text ?? "", /后台作业失败.*JOB_NOT_DISPATCHED/s);
    assert.ok(logs.some((line) => line.includes("was not dispatched")), logs.join("\n"));
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job is read and cancelled only under the bot that dispatched it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-scope-"));
  const inbox = newStore(directory);
  try {
    const jobs = new BackgroundJobs({ index: inbox, timeoutSeconds: 600, log: () => {} });
    const mine = jobIdFor("alpha", UUID);
    const theirs = jobIdFor("beta", "99999999-2222-3333-4444-555555555555");
    queue(inbox, mine);
    queue(inbox, theirs, { botId: "beta", conversationId: "42", command: "echo theirs" });

    const read = await jobs.status(41, mine);
    assert.equal(read.ok, true);
    // A well-formed id of another bot reads as absent, never as that bot's job.
    const foreign = await jobs.status(41, theirs);
    assert.equal(foreign.ok === false && foreign.error.code, "JOB_NOT_FOUND");
    const unknown = await jobs.status(41, jobIdFor("alpha", "99999999-2222-3333-4444-555555555555"));
    assert.equal(unknown.ok === false && unknown.error.code, "JOB_NOT_FOUND");
    const noBot = await jobs.list(99);
    assert.equal(noBot.ok === false && noBot.error.code, "JOB_NO_BOT");

    const listed = await jobs.list(41);
    assert.deepEqual(listed.ok === true ? listed.value.map((job) => job.jobId) : [], [mine]);
    const cancelled = await jobs.cancel(41, theirs);
    assert.equal(cancelled.ok === false && cancelled.error.code, "JOB_NOT_FOUND");
    assert.equal(inbox.jobForBot("beta", theirs)?.state, "queued", "a refusal never touches another bot's row");

    const view = jobs.view("alpha");
    assert.deepEqual({ live: view.live, unread: view.unread }, { live: 1, unread: 0 });
    assert.equal(view.jobs.length, 1);
    assert.equal(view.jobs[0]?.output, null);
    assert.equal(jobs.forget("alpha").jobs, 1);
    assert.equal(jobs.view("alpha").jobs.length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling says what actually happened to the job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-cancel-"));
  const inbox = newStore(directory);
  try {
    const jobs = new BackgroundJobs({ index: inbox, timeoutSeconds: 600, log: () => {} });
    const finished = jobIdFor("alpha", UUID);
    const orphan = jobIdFor("alpha", "99999999-2222-3333-4444-555555555555");
    const lost = jobIdFor("alpha", "77777777-2222-3333-4444-555555555555");
    const settled = jobIdFor("alpha", "66666666-2222-3333-4444-555555555555");
    const gone = jobIdFor("alpha", "55555555-2222-3333-4444-555555555555");
    queue(inbox, finished);
    finish(inbox, finished);
    queue(inbox, orphan);
    queue(inbox, lost, { taskId: "8", state: "running" });
    queue(inbox, settled, { taskId: "9", state: "running" });
    queue(inbox, gone, { taskId: "10", state: "running" });

    let aborted = 0;
    jobs.attach(hostOf({
      task: (taskId) => taskId === "9"
        ? factsOf(settled, "9", { state: "done", exitCode: 0, error: null, output: "output" })
        : taskId === "10" ? factsOf(gone, "10", null, false) : undefined,
      abort: (taskId) => {
        aborted += 1;
        assert.equal(taskId, "10");
        // What the base's abort invocation does once it commits: the host callback ends the row.
        finish(inbox, gone, "canceled");
        return "marked";
      },
    }));

    // The desired end state already holds: saying so is more useful than an error.
    const already = await jobs.cancel(41, finished);
    assert.equal(already.ok === true && already.value.canceled, false);
    assert.equal(already.ok === true && already.value.view.state, "done");

    // A live row with no task id: one bot's tool calls run one at a time, so nothing is in flight.
    const und = await jobs.cancel(41, orphan);
    assert.equal(und.ok === true && und.value.canceled, false);
    assert.equal(inbox.jobForBot("alpha", orphan)?.error, "JOB_NOT_DISPATCHED");

    // The durable record is gone, so this host cannot say whether the command ran. The row keeps that
    // uncertainty instead of inventing an outcome.
    const missing = await jobs.cancel(41, lost);
    assert.equal(missing.ok === true && missing.value.canceled, false);
    assert.equal(inbox.jobForBot("alpha", lost)?.state, "unknown");
    assert.equal(inbox.jobForBot("alpha", lost)?.error, "JOB_TASK_MISSING");

    // The record settled after the row was written: a cancellation is the wrong answer, convergence
    // is the right one.
    const converged = await jobs.cancel(41, settled);
    assert.equal(converged.ok === true && converged.value.canceled, false);
    assert.equal(inbox.jobForBot("alpha", settled)?.state, "done");

    // An abort is a request; the answer waits a bounded moment for the terminal record and then
    // reports the request as answered by it.
    const cancelled = await jobs.cancel(41, gone);
    assert.equal(aborted, 1);
    assert.equal(cancelled.ok === true && cancelled.value.canceled, true);
    assert.equal(cancelled.ok === true && cancelled.value.view.state, "canceled");
    assert.equal(inbox.jobForBot("alpha", gone)?.state, "canceled");
    assert.equal(inbox.liveJobsForBot("alpha").length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup converges every live row from the durable record and never guesses twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-reconcile-"));
  const inbox = newStore(directory);
  try {
    const never = jobIdFor("alpha", UUID);
    const unlinked = jobIdFor("alpha", "aaaaaaaa-2222-3333-4444-555555555555");
    const stale = jobIdFor("alpha", "99999999-2222-3333-4444-555555555555");
    const unreadable = jobIdFor("alpha", "88888888-2222-3333-4444-555555555555");
    const alive = jobIdFor("alpha", "77777777-2222-3333-4444-555555555555");
    const settledRow = jobIdFor("alpha", "66666666-2222-3333-4444-555555555555");
    queue(inbox, never);
    // A crash between writing the row and linking the task: the row is the same job, unlinked.
    queue(inbox, unlinked, { state: "running" });
    queue(inbox, stale, { taskId: "1", state: "running" });
    queue(inbox, unreadable, { taskId: "2", state: "running" });
    queue(inbox, alive, { taskId: "3", state: "running" });
    queue(inbox, settledRow);
    finish(inbox, settledRow);

    const jobs = new BackgroundJobs({ index: inbox, timeoutSeconds: 600, log: () => {} });
    jobs.attach(hostOf({
      tasks: [
        factsOf(unlinked, "4", null, false),
        factsOf(stale, "5", { state: "failed", exitCode: 2, error: "JOB_FAILED", output: "boom" }),
        factsOf(unreadable, "2", { state: "mystery" }),
        factsOf(alive, "3", null, false),
      ],
    }));
    const report = await jobs.reconcile();
    assert.deepEqual(report, { rows: 5, linked: 1, finished: 3, anomalies: 2 });

    // The row was written and the durable task never was. The command did not run, and that is the
    // reason this job ends with — not a silence the operator has to interpret.
    assert.equal(inbox.jobForBot("alpha", never)?.state, "failed");
    assert.equal(inbox.jobForBot("alpha", never)?.error, "JOB_NOT_DISPATCHED");
    // The unlinked row and the task are the same job; the pass states what the dispatcher would have.
    assert.equal(inbox.jobForBot("alpha", unlinked)?.taskId, "4");
    assert.equal(inbox.jobForBot("alpha", unlinked)?.state, "running", "a live task is left to run");
    // The row and the durable fact name different tasks. Neither record is trusted to say how the
    // work ended, so the row keeps the uncertainty rather than adopting an outcome that is not its.
    assert.equal(inbox.jobForBot("alpha", stale)?.error, "JOB_TASK_MISMATCH");
    assert.equal(inbox.jobForBot("alpha", stale)?.state, "unknown");
    assert.notEqual(inbox.jobForBot("alpha", stale)?.output, "boom");
    assert.equal(inbox.jobForBot("alpha", unreadable)?.error, "JOB_OUTCOME_UNREADABLE");
    assert.equal(inbox.jobForBot("alpha", unreadable)?.state, "unknown", "a terminal record this build cannot read is unknown");
    assert.equal(inbox.jobForBot("alpha", alive)?.state, "running", "a live task is left to run");
    assert.equal(inbox.jobForBot("alpha", settledRow)?.state, "done", "a row that already ended is not the pass's business");
    assert.equal(inbox.noticesForBot("alpha", 20).length, 4);

    // A second pass over the same facts is silent: the rows it repaired are terminal now.
    const again = await jobs.reconcile();
    assert.deepEqual(again, { rows: 2, linked: 0, finished: 0, anomalies: 0 });
    assert.equal(inbox.noticesForBot("alpha", 20).length, 4, "no completion publishes a second notice");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// --- End to end --------------------------------------------------------------------------------

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

type Transcript = { readonly messages: readonly Message[] };

function partText(message: Message): string {
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
  const content = (message as { content: string | readonly { type: string; text?: string }[] }).content;
  return typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

function lastUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return partText(message);
  }
  return "";
}

function modelsOf(respond: (transcript: Transcript) => ReturnType<typeof fauxAssistantMessage>) {
  const faux = fauxProvider({ provider: "openai" });
  // One factory answers every call: the script is the transcript, not a sequence of canned replies.
  const script: FauxResponseFactory[] = Array.from({ length: 64 }, () => respond);
  faux.setResponses(script);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

function read<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

test("a job outlives its reply, reports once, and its unread notice clears", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-e2e-"));
  const logs: string[] = [];
  let service: ServiceHandle | undefined;
  const dispatched: string[] = [];
  const seen: string[] = [];
  try {
    const models = modelsOf((transcript) => {
      const last = transcript.messages.at(-1);
      // The second call of a turn sees the tool's own result. Asserting on it here is how the test
      // checks what the model was told, without guessing at the answer's wording.
      if (last?.role === "toolResult") {
        const text = partText(last);
        seen.push(text);
        const dispatchedJob = /Dispatched as a background job: (job:default:[0-9a-f-]+)/.exec(text);
        if (dispatchedJob !== null) {
          dispatched.push(dispatchedJob[1]!);
          return fauxAssistantMessage("已经派到后台了，跑完控制台会提醒你。");
        }
        return fauxAssistantMessage("刚看了下，就是这样。");
      }
      const ask = lastUserText(transcript.messages);
      if (ask.includes("会失败的")) {
        return fauxAssistantMessage(fauxToolCall("job_start", { command: "exit 3" }, { id: "s2" }), { stopReason: "toolUse" });
      }
      if (ask.includes("什么情况")) {
        return fauxAssistantMessage(fauxToolCall("job_status", { jobId: dispatched[1]! }, { id: "s3" }), { stopReason: "toolUse" });
      }
      if (ask.includes("都有哪些")) {
        return fauxAssistantMessage(fauxToolCall("job_list", {}, { id: "s4" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxToolCall("job_start", { command: "echo job-ok" }, { id: "s1" }), { stopReason: "toolUse" });
    });
    // The legacy catalog is the only way a test can name the `shell` capability group; a
    // zero-setup deployment derives it from the platform, and a local transport denies it.
    service = await startService({
      env: environment(directory), models, log: (line) => logs.push(line), allowLegacyCatalog: true,
    });
    // A tool name is a wire value, and the provider is the authority on it: an OpenAI-compatible
    // endpoint rejects the whole request when one function name does not match `^[a-zA-Z0-9_-]+$`,
    // which fails every request of every bot before the model is ever reached. The faux model above
    // accepts any name it is handed, so this loop is the only place the rule is enforced — without it
    // a name like `job.start` looks perfectly fine here and 400s in production.
    const wireNames = service.agent.registry.records().map(({ name }) => name);
    assert.ok(wireNames.includes("job_start"), "the job tools reach the model under their wire names");
    for (const name of wireNames) {
      assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/, `${name} is not a provider function name`);
    }
    const console = consoleOf(service);

    /** Send one message and wait for its reply, so the next turn starts from a settled transcript. */
    const ask = async (text: string): Promise<void> => {
      const before = (await console.call("/api/bots/default/history?limit=50")).body.messages as { role: string }[];
      const answered = before.filter((message) => message.role === "assistant").length;
      assert.equal((await console.call("/api/bots/default/messages", { text })).status, 202);
      await waitFor("the reply", async () => {
        const history = await console.call("/api/bots/default/history?limit=50");
        const assistant = (history.body.messages as { role: string }[]).filter((message) => message.role === "assistant");
        return assistant.length > answered ? true : undefined;
      });
    };

    // --- A job is dispatched, outlives its reply, and reports once. ---
    await ask("帮我把这个跑起来");
    assert.equal(dispatched.length, 1, "the model dispatched exactly one job");
    assert.match(dispatched[0]!, /^job:default:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const done = await waitFor("the job to finish", async () => {
      const view = (await console.call("/api/bots/default/jobs")).body;
      return view.jobs[0]?.state === "done" ? view : undefined;
    });
    assert.equal(done.jobs.length, 1);
    assert.deepEqual(
      {
        state: done.jobs[0].state, command: done.jobs[0].command, exitCode: done.jobs[0].exitCode,
        error: done.jobs[0].error, live: done.live,
      },
      { state: "done", command: "echo job-ok", exitCode: 0, error: null, live: 0 },
    );
    assert.match(done.jobs[0].output, /job-ok/, "the console reads back the tail the command wrote");
    assert.ok(done.jobs[0].startedAt && done.jobs[0].finishedAt, "a finished job states when it ran");
    assert.equal(done.notices.length, 1, "one completion writes one notice");
    assert.equal(done.unread, 1);
    assert.equal(done.notices[0].readAt, null);
    assert.match(done.notices[0].text, /^后台作业已完成：echo job-ok/);
    assert.match(done.notices[0].text, /退出码 0/);
    assert.match(done.notices[0].text, /job-ok/, "the notice quotes the output tail");

    // Reading is the operator's own act, and it is bounded to the notices it names.
    assert.deepEqual((await console.call("/api/bots/default/jobs/notices", { noticeIds: [done.notices[0].noticeId] })).body, { read: 1 });
    const readBack = (await console.call("/api/bots/default/jobs")).body;
    assert.equal(readBack.unread, 0);
    assert.ok(readBack.notices[0].readAt);
    assert.deepEqual((await console.call("/api/bots/default/jobs/notices", {})).body, { read: 0 });
    assert.equal((await console.call("/api/bots/default/jobs/notices", { noticeIds: ["not-a-notice"] })).status, 200);
    assert.equal((await console.call("/api/bots/default/jobs/notices", { unknown: 1 })).status, 400);

    // --- A command that exits non-zero is a job that ran, and the model can explain it later. ---
    await ask("再跑一个会失败的");
    const failed = await waitFor("the failing job to finish", async () => {
      const view = (await console.call("/api/bots/default/jobs")).body;
      return view.jobs[0]?.state === "failed" ? view : undefined;
    });
    assert.equal(failed.jobs[0].exitCode, 3);
    assert.equal(failed.jobs[0].error, "JOB_FAILED");
    assert.equal(failed.unread, 1, "a failure is a completion too, and it is announced the same way");
    assert.equal(failed.notices.length, 2);

    // The facts the model reads are the facts the host wrote: the next interaction explains the
    // result, and there was no generation on completion to do it.
    await ask("刚才那个什么情况");
    const statusRead = seen.find((text) => text.includes(`[${dispatched[1]}]`));
    assert.ok(statusRead, `the model must read the job back; saw ${JSON.stringify(seen)}`);
    assert.match(statusRead!, /failed — exit 3/);
    assert.match(statusRead!, /exit 3/);
    await ask("都有哪些作业");
    const listRead = seen.find((text) => text.includes("job(s), newest first"));
    assert.ok(listRead, `the model must be able to enumerate them; saw ${JSON.stringify(seen)}`);
    assert.match(listRead!, /2 job\(s\), newest first/);
    assert.match(listRead!, /\[job:default:/);

    assert.ok(logs.some((line) => line.includes("Background job dispatched")), "the dispatch is in the host's own record");
    assert.ok(logs.some((line) => line.includes("Background job") && line.includes("failed")), logs.join("\n"));
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a live job is real work: it blocks an immediate reclaim and goes away with its bot", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-jobs-removal-"));
  const logs: string[] = [];
  let service: ServiceHandle | undefined;
  const dispatched: string[] = [];
  try {
    const models = modelsOf((transcript) => {
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult") {
        const text = partText(last);
        const jobId = /Dispatched as a background job: (job:worker:[0-9a-f-]+)/.exec(text);
        if (jobId !== null) {
          dispatched.push(jobId[1]!);
          return fauxAssistantMessage("派下去了，慢慢跑吧。");
        }
        return fauxAssistantMessage("好。");
      }
      const ask = lastUserText(transcript.messages);
      if (ask.includes("取消")) {
        return fauxAssistantMessage(fauxToolCall("job_cancel", { jobId: dispatched[0]! }, { id: "c1" }), { stopReason: "toolUse" });
      }
      if (ask.includes("顺便")) return fauxAssistantMessage("在的，你忙你的。");
      return fauxAssistantMessage(fauxToolCall("job_start", { command: "sleep 30" }, { id: "s1" }), { stopReason: "toolUse" });
    });
    service = await startService({
      env: environment(directory), models, log: (line) => logs.push(line), allowLegacyCatalog: true,
    });
    const console = consoleOf(service);
    for (const [botId, name] of [["worker", "Worker"], ["other", "Other"]] as const) {
      // Without a platform manifest there is no default catalog, so the profile is stated here.
      assert.equal((await console.call("/api/bots", { name, botId, profile: DEFAULT_CATALOG_PROFILE })).status, 201);
    }

    assert.equal((await console.call("/api/bots/worker/messages", { text: "跑个很久的" })).status, 202);
    const running = await waitFor("the job to be running", async () => {
      const view = (await console.call("/api/bots/worker/jobs")).body;
      return view.jobs[0]?.state === "running" ? view : undefined;
    });
    assert.equal(running.live, 1);
    assert.equal(running.unread, 0, "a running job has nothing to report yet");
    assert.equal(running.jobs[0].output, null);

    // A job is real resource use: a restart would stop it and leave an outcome nobody saw, so an
    // immediate reclaim of another bot is refused and names what to stop first.
    const refused = await console.call("/api/bots/other", { purge: "now" }, "DELETE");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "busy_bots");
    assert.deepEqual(refused.body.bots, [{ botId: "worker", reason: "background_jobs" }]);

    // Acceptance 2: a request sent while the job runs is answered in the request window, and the job
    // is untouched by it — the background task is outside the conversation's own lifecycle.
    const assistants = async (): Promise<number> =>
      ((await console.call("/api/bots/worker/history?limit=50")).body.messages as { role: string }[])
        .filter((message) => message.role === "assistant").length;
    const answered = await assistants();
    assert.equal((await console.call("/api/bots/worker/messages", { text: "顺便问一句" })).status, 202);
    await waitFor("the second reply", async () => (await assistants()) > answered ? true : undefined);
    assert.equal((await console.call("/api/bots/worker/jobs")).body.jobs[0].state, "running", "the reply did not disturb the job");

    // Cancellation confirms the execution's end state; it does not claim the command had no effects.
    const beforeCancel = await assistants();
    assert.equal((await console.call("/api/bots/worker/messages", { text: "取消那个作业" })).status, 202);
    const canceled = await waitFor("the job to be canceled", async () => {
      const view = (await console.call("/api/bots/worker/jobs")).body;
      return view.jobs[0]?.state === "canceled" ? view : undefined;
    });
    assert.equal(canceled.live, 0);
    assert.equal(canceled.unread, 1);
    assert.equal(canceled.jobs[0].error, "JOB_CANCELED");
    assert.match(canceled.notices[0].text, /^后台作业已取消：sleep 30/);
    // The request that asked for the cancellation must settle too. The job reaching `canceled` says
    // nothing about that reply, and a bot still mid-request is refused removal as `bot_is_running`.
    await waitFor("the cancel reply", async () => (await assistants()) > beforeCancel ? true : undefined);

    // --- Removal takes the job rows and notices with the bot. ---
    const removed = await console.call("/api/bots/worker", {}, "DELETE");
    assert.equal(removed.status, 202, JSON.stringify(removed.body));
    assert.equal((await console.call("/api/bots/worker/jobs")).status, 410, "a removed bot answers for nothing");
    assert.equal(read(join(directory, "inbox.sqlite"), (db) =>
      Number((db.prepare("SELECT count(*) AS count FROM background_jobs WHERE botId = 'worker'").get() as { count: number }).count)), 1);
    await service.close();
    service = undefined;

    service = await startService({
      env: environment(directory), models, log: (line) => logs.push(line), allowLegacyCatalog: true,
    });
    const restarted = consoleOf(service);
    assert.ok(logs.some((line) => line.includes("Bot removed: worker")), logs.join("\n"));
    assert.match(logs.find((line) => line.includes("Bot removed: worker")) ?? "", /1 job row\(s\)/);
    const counts = read(join(directory, "inbox.sqlite"), (db) => ({
      jobs: Number((db.prepare("SELECT count(*) AS count FROM background_jobs WHERE botId = 'worker'").get() as { count: number }).count),
      notices: Number((db.prepare("SELECT count(*) AS count FROM notices WHERE botId = 'worker'").get() as { count: number }).count),
      bots: Number((db.prepare("SELECT count(*) AS count FROM bots WHERE botId = 'worker'").get() as { count: number }).count),
    }));
    // The bot row stays as a tombstone; the work it dispatched does not.
    assert.deepEqual(counts, { jobs: 0, notices: 0, bots: 1 });
    const report = read(join(directory, "inbox.sqlite"), (db) =>
      String((db.prepare("SELECT removalReport FROM bots WHERE botId = 'worker'").get() as { removalReport: string }).removalReport));
    assert.match(report, /"jobs":1/);
    assert.match(report, /"notices":1/);
  } finally {
    await service?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
