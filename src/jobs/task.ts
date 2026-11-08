// The durable background job (ADR-0024). One task runs one shell command in its own directory and
// commits a terminal outcome; a host callback turns that outcome into an index row and a notice.
//
// Execution is deliberately not retried. The first entry commits `attempts: 1` before touching the
// command, so a process that dies mid-command is found at `attempts: 1` on the next start and is
// recorded as `unknown` instead of being run a second time. An interrupted command may have had
// side effects; the contract says a result that is not known must not be reported as "did not run".
// A re-run is a new job the operator or the model starts explicitly.
//
// Every terminal path commits the same shape: `completed`, with the job's own outcome — including
// `canceled` and `unknown` — as the result. The task-level vocabulary means "the job answered", and
// the answer is the result: a command that exits non-zero is a job that did exactly what it was
// asked, not a broken task. It also keeps the deletion gate's reading of the record honest, since a
// canceled job is explained work rather than an outcome nobody saw.
//
// The task writes nothing into the conversation's model-visible context: its progress lives in its
// own record and the index row, so a job can never pollute the bot's prompt (decision 10).
//
// The job's own directory is made by the shell on a POSIX workspace, not through the environment's
// file API, which deliberately serves only what the model's own file tools need. See the comment at
// the `mkdir` call.

import type { Context } from "@earendil-works/chord/context";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { JOB_OUTPUT_TAIL_BYTES, JOB_TASK_KIND, TailText, type JobOutcome } from "./contracts.js";

export type JobTaskInput = {
  readonly jobId: string;
  readonly botId: string;
  readonly command: string;
  /** Host-derived, never a model parameter. The environment clamps it to the transport's ceiling. */
  readonly timeoutSeconds: number;
};

/** `attempts` is the durable proof that the command may already have run. */
export type JobCheckpoint = { readonly phase: "execute"; readonly attempts: number };

export type JobTaskOptions = {
  /**
   * Called once the command is about to be handed to the environment, after the durable proof that it
   * may run exists. Best-effort: the index row is a projection, and the durable task is the truth.
   */
  readonly onStarted: (jobId: string, botId: string, startedAt: string) => void;
  /**
   * Called once the terminal outcome is durable. `jobId` is the host's own key for the job, passed
   * explicitly because the durable task id is not the identifier the row and the notice use. The
   * callback must be idempotent by `jobId`: a reconciling pass makes the same call after a crash.
   */
  readonly onTerminal: (jobId: string, outcome: JobOutcome) => void;
};

type Runtime = TaskRuntime<JobTaskInput, JobCheckpoint, JobOutcome, object>;

/** A job id is `job:<botId>:<uuid>`; the directory takes the uuid, safe as a path segment. */
export function jobDirectoryName(jobId: string): string {
  return jobId.split(":")[2] ?? jobId;
}

/**
 * One shell word for a host-derived path: single-quoted, so no part of it is read as shell syntax.
 * The value never comes from a model parameter, but a workspace path is deployment configuration and
 * a quote or a space in it must not turn into a second command.
 */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createJobTask(options: JobTaskOptions) {
  /**
   * Commit the outcome, then report it to the host. The commit comes first: a crash in between
   * leaves a terminal task whose index row is still live, which the reconciler converges. The
   * reverse order would leave a row claiming an outcome the durable task never recorded. A failing
   * callback cannot undo the outcome, so it is reported and swallowed; the reconciler retries it
   * from the same durable facts.
   */
  const finish = async (
    runtime: Runtime, context: Context, jobId: string, outcome: JobOutcome,
  ): Promise<void> => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "completed", result: outcome },
    }), context);
    report(options, runtime, jobId, outcome);
  };

  /** The same rule for the callback that only projects progress. */
  const started = (runtime: Runtime, jobId: string, botId: string): void => {
    try {
      options.onStarted(jobId, botId, new Date(runtime.now()).toISOString());
    } catch (error) {
      runtime.report(error);
    }
  };

  return defineTask<JobTaskInput, JobCheckpoint, JobOutcome>({
    name: JOB_TASK_KIND,
    version: 1,
    initial: () => ({ phase: "execute", attempts: 0 }),
    phases: {
      execute: async (task, runtime, context) => {
        const jobId = task.input.jobId;
        if (task.state.checkpoint.attempts > 0) {
          // Durable proof that this command was already handed to the environment. Whether it
          // finished is not knowable from here, so the job is recorded as unknown rather than
          // re-run or reported as never executed.
          await finish(runtime, context, jobId, {
            state: "unknown", exitCode: null, error: "JOB_INTERRUPTED", output: "",
          });
          return;
        }
        // This commit is what makes recovery conservative; it must precede any execution.
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "execute", attempts: 1 } }), context);
        started(runtime, jobId, task.input.botId);

        const env = await runtime.env(context);
        if (env === undefined) {
          await finish(runtime, context, jobId, {
            state: "failed", exitCode: null, error: "JOB_NO_ENVIRONMENT", output: "",
          });
          return;
        }
        // The job directory is derived from the conversation's own working directory, so it stays
        // inside the bot's workspace whatever transport is configured.
        const joined = await env.joinPath([env.cwd, "jobs", jobDirectoryName(jobId)], context);
        if (!joined.ok) {
          await finish(runtime, context, jobId, {
            state: "failed", exitCode: null, error: "JOB_WORKDIR", output: "",
          });
          return;
        }

        // On a POSIX workspace the directory is made with the same primitive the job runs on: a shell
        // command. `exec` is a full shell on every transport, while the remote faces answer
        // `createDir` with `not_supported` by design — they serve only the primitives the model's own
        // read/write/edit tools need (`execution/remote-files.ts`) — so asking them for one is a
        // question nobody answers. `mkdir -p` is idempotent, so a crash between here and the command
        // leaves nothing to undo.
        let ready: boolean;
        if (joined.value.startsWith("/")) {
          try {
            const made = await env.exec(`mkdir -p -- ${shellWord(joined.value)}`, undefined, context);
            ready = made.ok && made.value.exitCode === 0;
          } catch {
            // A throw is a failure to establish the directory, never a success.
            ready = false;
          }
        } else {
          // A working directory that is not a POSIX path is the local Node environment on Windows:
          // a different shell, whose spelling the task cannot know from here. Its own `createDir` is
          // the only primitive left, and a face that refuses it leaves the job unrunnable rather
          // than quietly making the wrong directory.
          try {
            ready = (await env.createDir(joined.value, { recursive: true }, context)).ok;
          } catch {
            ready = false;
          }
        }
        // Cancellation owns its own terminal state; it is never reported as an unrunnable workdir.
        runtime.signal.throwIfAborted();
        if (!ready) {
          await finish(runtime, context, jobId, {
            state: "failed", exitCode: null, error: "JOB_WORKDIR", output: "",
          });
          return;
        }

        const tail = new TailText(JOB_OUTPUT_TAIL_BYTES);
        let result;
        try {
          // The phase's context already carries this invocation's abort signal, so a cancellation
          // reaches the running command: the environment kills the process tree on that signal.
          result = await env.exec(task.input.command, {
            cwd: joined.value,
            timeout: task.input.timeoutSeconds,
            onOutput: (text) => tail.push(text),
          }, context);
        } catch (error) {
          // An environment that throws instead of returning a Result must not be read as success.
          runtime.signal.throwIfAborted();
          await finish(runtime, context, jobId, {
            state: "unknown", exitCode: null, error: "JOB_EXECUTION_ERROR", output: tail.text(),
          });
          return;
        }
        // A signalled invocation is handling cancellation: the abort protocol owns the terminal state.
        runtime.signal.throwIfAborted();

        const output = tail.text();
        if (result.ok) {
          await finish(runtime, context, jobId, result.value.exitCode === 0
            ? { state: "done", exitCode: 0, error: null, output }
            : { state: "failed", exitCode: result.value.exitCode, error: "JOB_FAILED", output });
          return;
        }
        await finish(runtime, context, jobId, {
          state: result.error.code === "timeout" ? "failed" : "unknown",
          exitCode: null,
          error: result.error.code === "timeout" ? "JOB_TIMEOUT" : "JOB_EXECUTION_ERROR",
          output,
        });
      },
    },
    abort: async (task, runtime, context) => {
      // Cancellation confirms the execution's end state. It does not claim the command's side
      // effects never happened, and it never re-runs the command to find out. The output tail seen
      // so far is not available here — the environment's callback owned it — so the notice quotes
      // none rather than a partial one.
      await finish(runtime, context, task.input.jobId, {
        state: "canceled", exitCode: null, error: "JOB_CANCELED", output: "",
      });
    },
  });
}

export type JobTask = ReturnType<typeof createJobTask>;

function report(options: JobTaskOptions, runtime: Runtime, jobId: string, outcome: JobOutcome): void {
  if (jobId === "") {
    // Should not happen: the task is only ever created with its own input. Reporting beats guessing.
    runtime.report(new Error("Background job task has no job id"));
    return;
  }
  try {
    options.onTerminal(jobId, outcome);
  } catch (error) {
    runtime.report(error);
  }
}
