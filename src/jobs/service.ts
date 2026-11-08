// The background-job host (ADR-0024). One object owns the durable command task, the index row, the
// completion notice and the startup reconciler that converges the row with the durable record.
//
// Division of truth: `harness.getTask(taskId)` is the durable truth, the `background_jobs` row is an
// enumerable projection, and the notice is a deterministic host-written line. The task commits its
// outcome, then calls back here; a crash in between leaves a live row for a terminal task, which the
// next start converges from the durable record instead of guessing.
//
// Nothing here reads a model parameter to decide anything material. The bot, the conversation, the
// working directory, the timeout and the job id are all host facts; a tool call contributes a command
// string and, for the read and cancel tools, a job id that is looked up under the calling bot.

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  LIVE_JOB_STATES,
  jobIdFor,
  type BackgroundJobRecord,
  type BackgroundJobState,
  type Inbox,
  type NoticeRecord,
} from "../inbox.js";
import {
  JOB_COMMAND_MAX_CHARS,
  JOB_LIVE_LIMIT,
  jobNoticeText,
  parseJobOutcome,
  type JobOutcome,
} from "./contracts.js";
import { createJobTask, type JobTaskInput } from "./task.js";
import { jobTools } from "./tools.js";

/** Rows one console view shows. Bounded like every other list in this repository. */
export const JOB_VIEW_LIMIT = 20;

/** One durable task of the job kind, as the host reads it. */
export type JobTaskFacts = {
  readonly taskId: string;
  /** The job id the task was created with; a task of this kind without one is not ours to claim. */
  readonly jobId: string;
  readonly conversationId: string;
  /** True once the outcome is decided, whether or not the record already reads `terminal`. */
  readonly settled: boolean;
  readonly outcome: unknown;
};

/**
 * The durable-task surface the job service needs. Narrow on purpose: the service can read one task,
 * enumerate the job kind, and request an abort — nothing else of the harness is reachable from it.
 */
export type JobTaskHost = {
  task(taskId: string): Promise<JobTaskFacts | undefined>;
  /** Every job-kind task, live or terminal, newest first, up to the host's own bound. */
  tasks(): Promise<readonly JobTaskFacts[]>;
  /** `missing` when no such task exists; the row then cannot be trusted to describe one. */
  abort(taskId: string): Promise<"marked" | "terminal" | "missing">;
};

/** The store surface the service needs; `Inbox` satisfies it. */
export type JobIndex = Pick<
  Inbox,
  | "botByConversation" | "bot" | "createJob" | "jobById" | "jobForBot" | "jobsForBot"
  | "liveJobsForBot" | "liveJobs" | "markJobRunning" | "linkJobTask" | "finishJob"
  | "noticesForBot" | "unreadNotices" | "markNoticesRead" | "deleteBotJobs"
>;

/** The dispatcher a tool call hands over: its conversation and the base's task creation. */
export type JobDispatcher = Pick<ToolExecutionApi, "conversationId" | "createTask">;

export type BackgroundJobsOptions = {
  readonly index: JobIndex;
  /**
   * Per-command ceiling, derived by the host from the execution transport's own bound. It is never a
   * model parameter and never exceeds what the transport accepts.
   */
  readonly timeoutSeconds: number;
  readonly log?: (line: string) => void;
};

/** A business refusal: the request was understood and declined, and nothing was dispatched. */
export type JobRefusal = { readonly code: string; readonly message: string };
export type JobResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JobRefusal };

/** One job as the console and the model read it. */
export type JobView = {
  readonly jobId: string;
  readonly state: BackgroundJobState;
  readonly command: string;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly output: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
};

export type NoticeView = {
  readonly noticeId: string;
  readonly jobId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly readAt: string | null;
};

/** Everything the console needs about one bot's jobs, in one read. */
export type BotJobsView = {
  readonly jobs: readonly JobView[];
  readonly notices: readonly NoticeView[];
  readonly unread: number;
  readonly live: number;
};

export type JobStartInput = { readonly command: string };

export class BackgroundJobs {
  readonly #index: JobIndex;
  readonly #timeoutSeconds: number;
  readonly #log: (line: string) => void;
  readonly #task: ReturnType<typeof createJobTask>;
  #host: JobTaskHost | undefined;

  constructor(options: BackgroundJobsOptions) {
    this.#index = options.index;
    this.#timeoutSeconds = options.timeoutSeconds;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#task = createJobTask({
      onStarted: (jobId, botId) => this.#started(jobId, botId),
      onTerminal: (jobId, outcome) => this.#settled(jobId, outcome),
    });
  }

  /**
   * Bind the durable task surface. The extension is installed before the harness exists, so this is
   * called immediately after it opens and before any tool can run.
   */
  attach(host: JobTaskHost): void {
    this.#host = host;
  }

  /** The extension the host installs: the job task and the four tools that reach it. */
  extension(): Extension {
    return defineExtension({ name: "background-jobs", tasks: [this.#task], tools: jobTools(this) });
  }

  /**
   * Converge every live row with the durable records. Runs once at startup, before scheduling
   * resumes, and that is the only moment it is sound: it decides `JOB_NOT_DISPATCHED` from the
   * absence of a durable task, which would be wrong for a dispatch that is still in flight.
   *
   * Every repair is derived from the durable record: a job whose task exists and is settled is
   * finished from that outcome, and a job whose task exists and is live is left to run.
   */
  async reconcile(): Promise<{ readonly rows: number; readonly linked: number; readonly finished: number; readonly anomalies: number }> {
    const host = this.#hostOrThrow();
    const facts = await host.tasks();
    const byJob = new Map(facts.map((fact) => [fact.jobId, fact]));
    let linked = 0;
    let finished = 0;
    let anomalies = 0;
    const rows = this.#index.liveJobs();
    for (const row of rows) {
      const fact = byJob.get(row.jobId);
      if (fact === undefined) {
        // The row was written and the durable task never was: the command was not dispatched. The
        // row is the only record of the intent, so the job ends here with that reason, and the
        // operator sees it in the index instead of a row that runs forever.
        finished += 1;
        this.#terminate(row, {
          state: "failed", exitCode: null, error: "JOB_NOT_DISPATCHED", output: "",
        }, "the durable task was never created");
        continue;
      }
      if (row.taskId !== fact.taskId) {
        // The row is written before the task, so a live row with no link is the crash-between case:
        // the row and the durable task are the same job and the fill is the repair. A link that
        // cannot be filled is not that case — the dispatcher stated this row's task id from the
        // task it created, so a differing fact means the two records disagree about which task this
        // job is, and no end state may be stated from that. `linkJobTask` refuses to repoint a row.
        if (!this.#index.linkJobTask(row.jobId, fact.taskId)) {
          anomalies += 1;
          finished += 1;
          this.#terminate(row, {
            state: "unknown", exitCode: null, error: "JOB_TASK_MISMATCH", output: "",
          }, "the row and the durable task name different tasks");
          continue;
        }
        linked += 1;
      }
      if (!fact.settled) continue;
      const outcome = parseJobOutcome(fact.outcome);
      if (outcome === undefined) {
        // A terminal record this build cannot read. Reporting the job as `unknown` keeps the row
        // honest: the work ended, and what it produced is not something this host can state.
        anomalies += 1;
        finished += 1;
        this.#terminate(row, {
          state: "unknown", exitCode: null, error: "JOB_OUTCOME_UNREADABLE", output: "",
        }, "the durable outcome is not in a readable shape");
        continue;
      }
      finished += 1;
      this.#terminate(row, outcome, "the durable task settled while the row was still live");
    }
    if (rows.length > 0) {
      this.#log(`Background jobs: reconciled ${rows.length} live row(s) (${linked} linked, ${finished} finished, ${anomalies} anomalous)`);
    }
    return Object.freeze({ rows: rows.length, linked, finished, anomalies });
  }

  /**
   * Dispatch one command as a background job. The row is written before the task: a crash in between
   * leaves a job the operator can see and the reconciler can close, never a running command with no
   * record. The reverse order would leave a command whose dispatch nobody can enumerate.
   *
   * The bot is resolved from the calling conversation, and its own row must be active: a deleted or
   * disabled bot is not a context in which new work may be dispatched, whatever the model asks.
   */
  async start(api: JobDispatcher, input: JobStartInput, context: Context): Promise<JobResult<JobView>> {
    const command = input.command.trim();
    if (command === "") return refuse("JOB_EMPTY_COMMAND", "The command is empty");
    if (command.length > JOB_COMMAND_MAX_CHARS) {
      return refuse("JOB_COMMAND_TOO_LONG", `The command is longer than ${JOB_COMMAND_MAX_CHARS} characters`);
    }
    const bot = this.#index.botByConversation(String(api.conversationId));
    if (bot === undefined) return refuse("JOB_NO_BOT", "This conversation is not a bot's");
    if (bot.status !== "active") {
      return refuse("JOB_BOT_INACTIVE", `Bot ${bot.botId} is ${bot.status}; no new job may be dispatched for it`);
    }
    const botId = bot.botId;
    const live = this.#index.liveJobsForBot(botId);
    if (live.length >= JOB_LIVE_LIMIT) {
      // Dispatched work is real resource use; the bound is the host's, not a suggestion the model may
      // argue with. The refusal names what is already running so the caller can cancel or wait.
      return refuse(
        "JOB_LIMIT_REACHED",
        `${live.length} job(s) of this bot are still unfinished (limit ${JOB_LIVE_LIMIT}): ${live.map((job) => job.jobId).join(", ")}`,
      );
    }
    const jobId = jobIdFor(botId, randomUUID());
    const conversationId = String(api.conversationId);
    const createdAt = new Date().toISOString();
    this.#index.createJob({
      jobId, botId, conversationId, taskId: "", kind: "command", command, state: "queued", createdAt,
    });
    const task: JobTaskInput = {
      jobId,
      botId,
      command,
      timeoutSeconds: this.#timeoutSeconds,
    };
    let taskId: TaskId<JobOutcome>;
    try {
      taskId = await api.createTask(this.#task, task, {
        // Conversation-owned and background: excluded from idle waits, conversation aborts and
        // cascades, so a request that times out at 300s does not kill the job it dispatched. No
        // `abandonOnRestart`: the job survives a restart and resumes from its own checkpoint.
        ownership: { kind: "conversation" },
        background: true,
      }, context);
    } catch (error) {
      // The task was not created, so the command was never handed to an environment. The row is
      // closed here rather than left live for a reconciler that would report the same thing later.
      this.#log(`Background job ${jobId} was not dispatched: ${describe(error)}`);
      this.#terminate(
        { jobId, botId, conversationId, taskId: "", kind: "command", command, state: "queued", exitCode: null, error: null, output: null, createdAt, startedAt: null, finishedAt: null },
        { state: "failed", exitCode: null, error: "JOB_NOT_DISPATCHED", output: "" },
        "the base refused to create the task",
      );
      throw error;
    }
    this.#index.linkJobTask(jobId, String(taskId));
    this.#log(`Background job dispatched: ${jobId} (bot ${botId}, task ${String(taskId)})`);
    const row = await this.#converge(jobId);
    return { ok: true, value: this.#row(row ?? this.#requireRow(jobId)) };
  }

  /** This bot's jobs, newest first. A read: it converges only the rows it is about to show. */
  async list(conversationId: number | string): Promise<JobResult<readonly JobView[]>> {
    const botId = this.#botOrRefuse(conversationId);
    if (typeof botId !== "string") return botId;
    const rows = this.#index.jobsForBot(botId, JOB_VIEW_LIMIT);
    const views: JobView[] = [];
    for (const row of rows) views.push(this.#row((await this.#converge(row.jobId)) ?? row));
    return { ok: true, value: Object.freeze(views) };
  }

  /** One job of this bot, or a refusal naming why it cannot be read. */
  async status(conversationId: number | string, jobId: string): Promise<JobResult<JobView>> {
    const botId = this.#botOrRefuse(conversationId);
    if (typeof botId !== "string") return botId;
    if (this.#index.jobForBot(botId, jobId) === undefined) {
      return refuse("JOB_NOT_FOUND", `No job ${jobId} belongs to this bot`);
    }
    const row = (await this.#converge(jobId)) ?? this.#index.jobForBot(botId, jobId);
    if (row === undefined) return refuse("JOB_NOT_FOUND", `No job ${jobId} belongs to this bot`);
    return { ok: true, value: this.#row(row) };
  }

  /**
   * Ask the durable task to stop. Cancellation confirms the execution's end state; it never claims
   * the command's side effects did not happen, and it never re-runs the command to find out.
   *
   * The abort is asynchronous on the base's side: this waits a bounded moment for the terminal
   * record so the answer can be the outcome rather than a promise, and reports the request as
   * pending when the bounded wait runs out.
   */
  async cancel(conversationId: number | string, jobId: string): Promise<JobResult<{ readonly view: JobView; readonly canceled: boolean }>> {
    const botId = this.#botOrRefuse(conversationId);
    if (typeof botId !== "string") return botId;
    const row = this.#index.jobForBot(botId, jobId);
    if (row === undefined) return refuse("JOB_NOT_FOUND", `No job ${jobId} belongs to this bot`);
    if (!isLive(row.state)) {
      // The desired end state already holds; saying so is more useful than an error.
      return { ok: true, value: { view: this.#row(row), canceled: false } };
    }
    if (row.taskId === "") {
      // A live row with no task id means the dispatch never completed. Tool calls of one bot run
      // one at a time, so nothing is in flight now; the job is closed with the reason.
      this.#terminate(row, { state: "failed", exitCode: null, error: "JOB_NOT_DISPATCHED", output: "" },
        "cancelled while the dispatch had not completed");
      const closed = this.#index.jobById(jobId);
      if (closed === undefined) return refuse("JOB_NOT_FOUND", `No job ${jobId} belongs to this bot`);
      return { ok: true, value: { view: this.#row(closed), canceled: false } };
    }
    const facts = await this.#hostOrThrow().task(row.taskId);
    if (facts === undefined) {
      // The durable record is gone, so this host cannot say whether the command ran. The row keeps
      // that uncertainty instead of inventing an outcome, and stops counting as unfinished work.
      this.#terminate(row, { state: "unknown", exitCode: null, error: "JOB_TASK_MISSING", output: "" },
        "the durable task record is not in the store");
      const closed = this.#index.jobById(jobId);
      return closed === undefined
        ? refuse("JOB_NOT_FOUND", `No job ${jobId} belongs to this bot`)
        : { ok: true, value: { view: this.#row(closed), canceled: false } };
    }
    if (facts.settled) {
      const converged = await this.#converge(jobId);
      return { ok: true, value: { view: this.#row(converged ?? row), canceled: false } };
    }
    const result = await this.#hostOrThrow().abort(row.taskId);
    if (result === "missing") return refuse("JOB_TASK_MISSING", "The durable task is not in the store");
    const settled = await this.#awaitSettled(jobId);
    return { ok: true, value: { view: this.#row(settled ?? this.#index.jobForBot(botId, jobId) ?? row), canceled: true } };
  }

  // --- Console views. Reads only; the console never starts or stops a job. ---

  view(botId: string): BotJobsView {
    const jobs = this.#index.jobsForBot(botId, JOB_VIEW_LIMIT).map((row) => this.#row(row));
    return Object.freeze({
      jobs: Object.freeze(jobs),
      notices: Object.freeze(this.#index.noticesForBot(botId, JOB_VIEW_LIMIT).map(noticeView)),
      unread: this.#index.unreadNotices(botId),
      live: this.#index.liveJobsForBot(botId).length,
    });
  }

  /** Mark this bot's notices read; the console calls this when it shows them. */
  markRead(botId: string, noticeIds?: readonly string[]): number {
    return this.#index.markNoticesRead(botId, noticeIds);
  }

  /** Drop one bot's jobs and notices, for the reclaim pass. Returns how many rows left. */
  forget(botId: string): { readonly jobs: number; readonly notices: number } {
    return this.#index.deleteBotJobs(botId);
  }

  // --- Internals ---

  /**
   * Reconcile one row with its durable record, leaving it alone when it is already terminal or when
   * the task is still live. Only an exact `getTask` read is used here: no scans, so a dispatch in
   * flight in another call cannot be mistaken for a job that never started.
   */
  async #converge(jobId: string): Promise<BackgroundJobRecord | undefined> {
    const row = this.#index.jobById(jobId);
    if (row === undefined || !isLive(row.state) || row.taskId === "" || this.#host === undefined) return row;
    const facts = await this.#host.task(row.taskId);
    if (facts === undefined || !facts.settled) return row;
    const outcome = parseJobOutcome(facts.outcome);
    this.#terminate(row, outcome ?? {
      state: "unknown", exitCode: null, error: "JOB_OUTCOME_UNREADABLE", output: "",
    }, outcome === undefined ? "the durable outcome is not in a readable shape" : "the durable task settled");
    return this.#index.jobById(jobId) ?? row;
  }

  /** Wait, bounded, for the abort invocation to commit. The base schedules it; it is not instant. */
  async #awaitSettled(jobId: string): Promise<BackgroundJobRecord | undefined> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = this.#index.jobById(jobId);
      if (row === undefined || !isLive(row.state)) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.#index.jobById(jobId);
  }

  /** Finish one row from a decided outcome and write its notice. Idempotent by the row's own state. */
  #terminate(row: BackgroundJobRecord, outcome: JobOutcome, why: string): void {
    const finishedAt = new Date().toISOString();
    const settled = this.#index.finishJob(row.jobId, {
      state: outcome.state,
      exitCode: outcome.exitCode,
      error: outcome.error,
      output: outcome.output === "" ? null : outcome.output,
      notice: jobNoticeText(row.jobId, row.command, outcome, elapsedMs(row, finishedAt)),
      finishedAt,
    });
    if (settled) {
      this.#log(`Background job ${row.jobId}: ${outcome.state}${outcome.error === null ? "" : ` (${outcome.error})`} — ${why}`);
    }
  }

  /** The durable task's own callback: the outcome is already committed when this runs. */
  #settled(jobId: string, outcome: JobOutcome): void {
    const row = this.#index.jobById(jobId);
    if (row === undefined) {
      this.#log(`Background job ${jobId} settled with no index row; the notice was not written`);
      return;
    }
    this.#terminate(row, outcome, "the task reported its outcome");
  }

  #started(jobId: string, botId: string): void {
    if (!this.#index.markJobRunning(botId, jobId, new Date().toISOString())) {
      // The row is already terminal: a cancellation reached the job before its first execution.
      this.#log(`Background job ${jobId} started after its row was already finished`);
    }
  }

  #requireRow(jobId: string): BackgroundJobRecord {
    const row = this.#index.jobById(jobId);
    if (row === undefined) throw new Error(`Background job ${jobId} has no index row`);
    return row;
  }

  #hostOrThrow(): JobTaskHost {
    if (this.#host === undefined) throw new Error("Background jobs are not attached to a task host");
    return this.#host;
  }

  /** The calling conversation's bot, or the refusal a tool reports when there is none. */
  #botOrRefuse(conversationId: number | string): string | JobResult<never> {
    const bot = this.#index.botByConversation(String(conversationId));
    return bot?.botId ?? refuse("JOB_NO_BOT", "This conversation is not a bot's");
  }

  #row(row: BackgroundJobRecord): JobView {
    return Object.freeze({
      jobId: row.jobId,
      state: row.state,
      command: row.command,
      exitCode: row.exitCode,
      error: row.error,
      output: row.output,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  }
}

/** The bot that owns a conversation, or undefined when the conversation is not a bot's. */
export function botForConversation(index: JobIndex, conversationId: number | string): string | undefined {
  return index.botByConversation(String(conversationId))?.botId;
}

function noticeView(notice: NoticeRecord): NoticeView {
  return Object.freeze({
    noticeId: notice.noticeId,
    jobId: notice.jobId,
    text: notice.text,
    createdAt: notice.createdAt,
    readAt: notice.readAt,
  });
}

function isLive(state: BackgroundJobState): boolean {
  return LIVE_JOB_STATES.includes(state);
}

/** Wall-clock milliseconds from the row's own timestamps; null when they cannot be read as dates. */
function elapsedMs(row: BackgroundJobRecord, finishedAt: string): number | null {
  const started = Date.parse(row.startedAt ?? row.createdAt);
  const ended = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return ended - started;
}

function refuse(code: string, message: string): JobResult<never> {
  return { ok: false, error: Object.freeze({ code, message }) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
