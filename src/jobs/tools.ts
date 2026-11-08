// The four job tools (ADR-0024 decision 4): start, list, status, cancel. There is deliberately no
// `job_wait`: any tool that waited would hold the request at the same 300-second wall the job exists
// to move past, and the caller would learn nothing it cannot ask for again later.
//
// The names are snake_case because a tool name is a wire value, not a display string. OpenAI-compatible
// endpoints (DeepSeek included) reject any name that does not match `^[a-zA-Z0-9_-]+$`, so a dotted
// `job.start` is a 400 before the model runs at all — every request of every bot, not merely the tool
// call. The faux provider the tests drive enforces no such rule, which is why only the real endpoint
// caught it. `test/background-jobs.test.ts` now asserts the shape directly.
//
// The tools carry no host facts. A job's bot, conversation, working directory and time limit are
// resolved by the service from the calling conversation and the host's configuration; a command
// string and a job id are all the model supplies. Job ids are validated by shape and then looked up
// under the calling bot, so a well-formed id of another bot's job reads as not found.
//
// Failure semantics are kept apart everywhere: a refusal (`job_start` over the limit, an unknown id)
// is an error result with a business code, a job whose command exited non-zero is a *successful*
// result that reports the exit code, and a job whose result could not be established says so.

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { JOB_COMMAND_DISPLAY_CHARS, JOB_COMMAND_MAX_CHARS, JOB_OUTPUT_TAIL_BYTES, truncate } from "./contracts.js";
import type { BackgroundJobs, JobResult, JobView } from "./service.js";

const JOB_ID_PATTERN = "^job:[a-z0-9][a-z0-9_-]{0,31}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const startOutput = Type.Object(
  {
    jobId: Type.String({ maxLength: 128 }),
    state: Type.String({ maxLength: 16 }),
    command: Type.String({ maxLength: JOB_COMMAND_MAX_CHARS }),
  },
  { additionalProperties: false },
);

const jobOutput = Type.Object(
  {
    jobId: Type.String({ maxLength: 128 }),
    state: Type.String({ maxLength: 16 }),
    command: Type.String({ maxLength: JOB_COMMAND_MAX_CHARS }),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    error: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    startedAt: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
    finishedAt: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
    outputTail: Type.Union([Type.String({ maxLength: JOB_OUTPUT_TAIL_BYTES }), Type.Null()]),
  },
  { additionalProperties: false },
);

const listOutput = Type.Object(
  { jobs: Type.Array(jobOutput, { maxItems: 20 }) },
  { additionalProperties: false },
);

const cancelOutput = Type.Object(
  { jobId: Type.String({ maxLength: 128 }), state: Type.String({ maxLength: 16 }), canceled: Type.Boolean() },
  { additionalProperties: false },
);

/** One job as the model reads it: identity and state first, then the facts, then the output tail. */
function jobText(job: JobView): string {
  const facts = [
    job.exitCode === null ? null : `exit ${job.exitCode}`,
    job.error,
    job.startedAt === null ? null : `started ${job.startedAt}`,
    job.finishedAt === null ? null : `finished ${job.finishedAt}`,
  ].filter((part): part is string => part !== null).join(", ");
  const tail = job.output === null || job.output.trim() === "" ? "" : `\n   output tail:\n${indent(truncate(job.output.trim(), 1_200))}`;
  return `[${job.jobId}] ${job.state} — ${truncate(job.command, JOB_COMMAND_DISPLAY_CHARS)}${facts === "" ? "" : `\n   ${facts}`}${tail}`;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `   ${line}`).join("\n");
}

function jobStructured(job: JobView) {
  return {
    jobId: job.jobId,
    state: job.state,
    command: job.command,
    exitCode: job.exitCode,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    outputTail: job.output === null ? null : truncate(job.output, JOB_OUTPUT_TAIL_BYTES),
  };
}

function errorResult(code: string, message: string) {
  return {
    isError: true as const,
    output: [{ type: "text" as const, text: `${code}: ${message}` }],
    diagnostics: [{ severity: "error" as const, code, message }],
  };
}

type Failed = ReturnType<typeof errorResult>;

function isFailed(value: unknown): value is Failed {
  return typeof value === "object" && value !== null && "isError" in value;
}

/** Render a service refusal as a failed call, or hand the value on. */
function unwrap<T>(result: JobResult<T>): T | Failed {
  return result.ok ? result.value : errorResult(result.error.code, result.error.message);
}

export function jobTools(jobs: BackgroundJobs): ToolRegistration[] {
  const start = defineTool({
    name: "job_start",
    description:
      "Start one shell command as a background job and return at once with its job id. Use this for work that outlives one reply: builds, downloads, long copies, anything slow. The command runs in the bot's own workspace under a dedicated jobs directory with the host's own time limit, and its combined output is kept as a bounded tail. Nothing is sent anywhere when the job finishes and this conversation is not told: read job_status or job_list afterwards and tell the user what actually happened.",
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: JOB_COMMAND_MAX_CHARS, description: "The shell command to run." }),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: startOutput,
    execute: async (args, api: ToolExecutionApi, context: Context) => {
      const outcome = unwrap(await jobs.start(api, { command: args.command }, context));
      if (isFailed(outcome)) return outcome;
      return {
        output: [{
          type: "text",
          text: `Dispatched as a background job: ${outcome.jobId} (${outcome.state}). It keeps running after this reply; ask for its state later with job_status.`,
        }],
        structuredOutput: { jobId: outcome.jobId, state: outcome.state, command: outcome.command },
      };
    },
  });

  const list = defineTool({
    name: "job_list",
    description:
      "List this bot's background jobs, newest first, with their state, exit code, failure code and output tail. Use it to answer what is still running and what finished since the user last asked. A job that finished while nobody was watching appears here; nothing announces it.",
    parameters: Type.Object({}, { additionalProperties: false }),
    structuredOutputSchema: listOutput,
    replay: "safe",
    execute: async (_args, api: ToolExecutionApi) => {
      const outcome = unwrap(await jobs.list(api.conversationId));
      if (isFailed(outcome)) return outcome;
      const text = outcome.length === 0
        ? "No background jobs."
        : `${outcome.length} job(s), newest first:\n${outcome.map(jobText).join("\n")}`;
      return {
        output: [{ type: "text", text }],
        structuredOutput: { jobs: outcome.map(jobStructured) },
      };
    },
  });

  const status = defineTool({
    name: "job_status",
    description:
      "Read one background job of this bot: its state, exit code, failure code and output tail. A command that exited non-zero is a normal read reporting that exit code; only an unknown job id is an error. A job still queued or running is reported as such.",
    parameters: Type.Object(
      { jobId: Type.String({ pattern: JOB_ID_PATTERN, maxLength: 128, description: "The job id job_start returned." }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: jobOutput,
    replay: "safe",
    execute: async (args, api: ToolExecutionApi) => {
      const outcome = unwrap(await jobs.status(api.conversationId, args.jobId));
      if (isFailed(outcome)) return outcome;
      return {
        output: [{ type: "text", text: jobText(outcome) }],
        structuredOutput: jobStructured(outcome),
      };
    },
  });

  const cancel = defineTool({
    name: "job_cancel",
    description:
      "Ask one of this bot's background jobs to stop. This does not undo what the command already did, and it cannot report a cleaner result than the truth: the job ends as canceled. A job that already finished is not an error — the answer says which state it is in.",
    parameters: Type.Object(
      { jobId: Type.String({ pattern: JOB_ID_PATTERN, maxLength: 128, description: "The job id to stop." }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: cancelOutput,
    execute: async (args, api: ToolExecutionApi) => {
      const outcome = unwrap(await jobs.cancel(api.conversationId, args.jobId));
      if (isFailed(outcome)) return outcome;
      const text = outcome.canceled
        ? `Cancellation requested for ${outcome.view.jobId}; it is now ${outcome.view.state}.`
        : `No cancellation was needed: ${outcome.view.jobId} is already ${outcome.view.state}.`;
      return {
        output: [{ type: "text", text }],
        structuredOutput: { jobId: outcome.view.jobId, state: outcome.view.state, canceled: outcome.canceled },
      };
    },
  });

  return [start, list, status, cancel];
}
