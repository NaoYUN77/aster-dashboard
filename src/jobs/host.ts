// The durable-task side of the job service: the only place that reads the base's task records for a
// job. Three operations, deliberately narrow — read one record, enumerate the job kind, request an
// abort — so the service can never reach further into the harness than a job needs.
//
// Task ids are the base's branded numbers and are stored as text in the index row. The conversion
// happens here, at the boundary, and only for a shape a task id can actually have: a decimal string
// of a positive integer. A row that holds anything else names no task, which is reported as such
// rather than repaired into a plausible number.

import type { Context } from "@earendil-works/chord/context";
import type { Harness, Storage, TaskId, TaskRecord } from "@earendil-works/pi-durable";
import { JOB_SCAN_MAX_PAGES, JOB_SCAN_PAGE, JOB_TASK_KIND } from "./contracts.js";
import type { JobTaskFacts, JobTaskHost } from "./service.js";

type AnyTask = TaskRecord<unknown, unknown, unknown>;

export function createJobTaskHost(harness: Harness, storage: Storage, context: Context): JobTaskHost {
  const factsOf = (record: AnyTask): JobTaskFacts | undefined => {
    const jobId = jobIdOf(record);
    // A task of this kind without its own input is not one this host created; refusing to claim it
    // is what keeps a foreign record from being projected into an index row.
    if (jobId === undefined) return undefined;
    const state = record.state;
    const settled = state.status === "terminal" || state.status === "completing";
    return Object.freeze({
      taskId: String(record.id),
      jobId,
      conversationId: String(record.conversationId),
      settled,
      outcome: settled ? state.outcome : undefined,
    });
  };

  return {
    async task(taskId) {
      const id = taskIdFrom(taskId);
      if (id === undefined) return undefined;
      const record = await harness.getTask(id, context);
      return record === undefined ? undefined : factsOf(record as AnyTask);
    },
    async tasks() {
      const found: JobTaskFacts[] = [];
      let cursor: Parameters<Storage["scanTasks"]>[2];
      for (let page = 0; page < JOB_SCAN_MAX_PAGES; page += 1) {
        // Newest first: a live row can only name a recent task, so the bound trims history rather
        // than the work in flight. The count is logged by the service when rows were reconciled.
        const scanned = await storage.scanTasks({ kind: JOB_TASK_KIND, order: "descending" }, JOB_SCAN_PAGE, cursor, context);
        for (const record of scanned.items) {
          const facts = factsOf(record as AnyTask);
          if (facts !== undefined) found.push(facts);
        }
        cursor = scanned.next;
        if (cursor === undefined) break;
      }
      return Object.freeze(found);
    },
    async abort(taskId) {
      const id = taskIdFrom(taskId);
      if (id === undefined) return "missing";
      // Checked first, so an id the store does not hold is answered as absent instead of as an error
      // the caller would have to interpret. Tasks are never deleted while the store lives, so the
      // read cannot go stale in a way that matters.
      const record = await harness.getTask(id, context);
      if (record === undefined) return "missing";
      return harness.abortTask(id, context);
    },
  };
}

/** The job id inside a job task's input, or undefined for a record that is not one of ours. */
function jobIdOf(record: AnyTask): string | undefined {
  const input = record.input;
  if (input === null || typeof input !== "object") return undefined;
  const jobId = (input as { jobId?: unknown }).jobId;
  return typeof jobId === "string" && jobId !== "" ? jobId : undefined;
}

/** A stored task id back into the base's brand, at the one boundary that decodes it. */
function taskIdFrom(value: string): TaskId | undefined {
  if (!/^[1-9]\d{0,15}$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id as TaskId : undefined;
}
