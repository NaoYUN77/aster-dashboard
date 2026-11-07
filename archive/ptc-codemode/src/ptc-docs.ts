// Durable control-plane records for the remote PTC sandbox.
//
// Interface
//   PtcJobDoc    (conversation family, key = jobId)  workspace identity and readiness
//   PtcOutputDoc (conversation family, key = jobId)  bounded OutputRef metadata
//   ensurePtcJob(tx, conversationId, job)            create-or-verify the job record
//   markPtcWorkspaceReady(tx, conversationId, id)    record that the runner mounted the workspace
//   appendPtcOutput(tx, conversationId, id, ref)     add one ref, deduplicating and evicting
//   markPtcOutputState(tx, conversationId, ...)      evicted/unknown transitions
//
// Inputs: host-derived identity (`jobId`), host clock milliseconds, and OutputRef values produced by
// the execution agent. Nothing here is a model parameter.
//
// Errors: a stored value that fails its schema or names another job throws `PtcDocError` before any
// mutation; the caller's commit then fails and the tool call reports failure instead of pretending
// the output was recorded.
//
// Side effects: only the caller's transaction. This module never commits.
//
// Storage: full output never enters SQLite. The documents hold identities, sizes, hashes, sandbox
// paths and lifetimes; the bytes stay in the execution host's workspace.

import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const PTC_DOC_VERSION = 1;
export const PTC_JOB_DOC_KIND = "aster.ptc.job";
export const PTC_OUTPUT_DOC_KIND = "aster.ptc.output";
/** Same bound as the job workspace retention list; older refs are evicted with a counted reason. */
export const PTC_OUTPUT_DOC_MAX_REFS = 256;

export const PTC_JOB_ID_PATTERN = "^ptc-[a-f0-9]{32}$";
export const PTC_SESSION_ID_PATTERN = "^[a-f0-9]{16}$";
export const PTC_SHA256_PATTERN = "^[a-f0-9]{64}$";

export class PtcDocError extends Error {
  constructor(readonly code: "corrupt-state" | "job-mismatch", message: string) {
    super(message);
    this.name = "PtcDocError";
  }
}

const PTC_OUTPUT_PATH_MAX_BYTES = 512;

export const PtcOutputRefSchema = Type.Object(
  {
    blobId: Type.String({ pattern: PTC_SHA256_PATTERN }),
    jobId: Type.String({ pattern: PTC_JOB_ID_PATTERN }),
    sessionId: Type.String({ pattern: PTC_SESSION_ID_PATTERN }),
    callId: Type.Integer({ minimum: 1 }),
    path: Type.String({ minLength: 1, maxLength: PTC_OUTPUT_PATH_MAX_BYTES }),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ pattern: PTC_SHA256_PATTERN }),
    createdAt: Type.Integer({ minimum: 0 }),
    expiresAt: Type.Integer({ minimum: 0 }),
    state: Type.Union([Type.Literal("available"), Type.Literal("evicted"), Type.Literal("unknown")]),
  },
  { additionalProperties: false },
);
export type PtcOutputRef = Static<typeof PtcOutputRefSchema>;

export const PtcJobStateSchema = Type.Object(
  {
    version: Type.Literal(PTC_DOC_VERSION),
    jobId: Type.String({ pattern: PTC_JOB_ID_PATTERN }),
    workspaceReady: Type.Boolean(),
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PtcJobState = Static<typeof PtcJobStateSchema>;

export const PtcOutputStateSchema = Type.Object(
  {
    version: Type.Literal(PTC_DOC_VERSION),
    jobId: Type.String({ pattern: PTC_JOB_ID_PATTERN }),
    outputs: Type.Array(PtcOutputRefSchema, { maxItems: PTC_OUTPUT_DOC_MAX_REFS }),
    /** Refs dropped by the bound, so a missing entry is never mistaken for "never produced". */
    evicted: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PtcOutputState = Static<typeof PtcOutputStateSchema>;

export const PtcJobDoc = defineDocFamily({
  kind: PTC_JOB_DOC_KIND,
  version: PTC_DOC_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed: PtcJobState): PtcJobState => seed,
});

export const PtcOutputDoc = defineDocFamily({
  kind: PTC_OUTPUT_DOC_KIND,
  version: PTC_DOC_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed: PtcOutputState): PtcOutputState => seed,
});

export function initialPtcJob(jobId: string, now: number): PtcJobState {
  return {
    version: PTC_DOC_VERSION,
    jobId,
    workspaceReady: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function initialPtcOutput(jobId: string, now: number): PtcOutputState {
  return {
    version: PTC_DOC_VERSION,
    jobId,
    outputs: [],
    evicted: 0,
    updatedAt: now,
  };
}

function assertValue<T>(schema: TSchema, value: unknown, code: "corrupt-state", message: string): T {
  if (!Value.Check(schema, value)) throw new PtcDocError(code, message);
  return value as T;
}

function assertJobIdentity(jobId: string, value: { jobId: string }): void {
  if (value.jobId !== jobId) {
    throw new PtcDocError("job-mismatch", "PTC document is stored under a different job id");
  }
}

/** Validate a ref the execution agent returned before persisting it. */
export function assertPtcOutputRef(value: unknown, jobId: string): PtcOutputRef {
  const ref = assertValue<PtcOutputRef>(PtcOutputRefSchema, value, "corrupt-state", "PTC output reference is invalid");
  assertJobIdentity(jobId, ref);
  if (ref.blobId !== ref.sha256) {
    throw new PtcDocError("corrupt-state", "PTC output reference content id does not match its hash");
  }
  if (ref.expiresAt < ref.createdAt) {
    throw new PtcDocError("corrupt-state", "PTC output reference expires before it was created");
  }
  return ref;
}

/**
 * Create the job record, or verify the one an earlier attempt left. A stored job for another id, or
 * one that no longer matches the derived identity, is a mismatch rather than a silent reuse.
 */
export async function ensurePtcJobInTx(tx: Tx, conversationId: ConversationId, job: PtcJobState): Promise<PtcJobState> {
  const seed = assertValue<PtcJobState>(PtcJobStateSchema, job, "corrupt-state", "PTC job seed is invalid");
  const stored = await tx.doc(PtcJobDoc, conversationId, job.jobId, seed);
  const current = assertValue<PtcJobState>(PtcJobStateSchema, stored, "corrupt-state", "Stored PTC job is invalid");
  assertJobIdentity(job.jobId, current);
  // `stored` is an overlay proxy: reading it after the caller's commit settles throws. The caller
  // uses this value to decide `workspaceReady`, so return a detached snapshot.
  return { ...current };
}

/** Mark the workspace as mounted. The flag is durable before `vm.start`, so a restart reuses it. */
export async function markPtcWorkspaceReady(
  tx: Tx,
  conversationId: ConversationId,
  jobId: string,
  now: number,
): Promise<PtcJobState> {
  const stored = await tx.doc(PtcJobDoc, conversationId, jobId, initialPtcJob(jobId, now));
  const current = assertValue<PtcJobState>(PtcJobStateSchema, stored, "corrupt-state", "Stored PTC job is invalid");
  assertJobIdentity(jobId, current);
  if (current.workspaceReady) return { ...current };
  const next: PtcJobState = { ...current, workspaceReady: true, updatedAt: now };
  Object.assign(stored, next);
  return next;
}

/**
 * Record one output reference. The same blob from a retried call is not duplicated; when the bound
 * is reached the oldest ref is dropped and the drop is counted.
 */
export async function appendPtcOutputInTx(
  tx: Tx,
  conversationId: ConversationId,
  jobId: string,
  ref: PtcOutputRef,
  now: number,
): Promise<{ state: PtcOutputState; stored: boolean }> {
  const validated = assertPtcOutputRef(ref, jobId);
  const stored = await tx.doc(PtcOutputDoc, conversationId, jobId, initialPtcOutput(jobId, now));
  const current = assertValue<PtcOutputState>(PtcOutputStateSchema, stored, "corrupt-state", "Stored PTC output list is invalid");
  assertJobIdentity(jobId, current);
  if (current.outputs.some((entry) => entry.blobId === validated.blobId)) {
    return { state: { ...current }, stored: false };
  }
  const outputs = [...current.outputs, validated];
  let evicted = current.evicted;
  while (outputs.length > PTC_OUTPUT_DOC_MAX_REFS) {
    outputs.shift();
    evicted += 1;
  }
  const next: PtcOutputState = { ...current, outputs, evicted, updatedAt: now };
  Object.assign(stored, next);
  return { state: next, stored: true };
}

/** Persist a later observation of one blob's availability (`evicted`, `unknown`, `available`). */
export async function markPtcOutputState(
  tx: Tx,
  conversationId: ConversationId,
  jobId: string,
  blobId: string,
  state: PtcOutputRef["state"],
  now: number,
): Promise<boolean> {
  const stored = await tx.doc(PtcOutputDoc, conversationId, jobId, initialPtcOutput(jobId, now));
  const current = assertValue<PtcOutputState>(PtcOutputStateSchema, stored, "corrupt-state", "Stored PTC output list is invalid");
  assertJobIdentity(jobId, current);
  const index = current.outputs.findIndex((entry) => entry.blobId === blobId);
  if (index < 0) return false;
  if (current.outputs[index]!.state === state) return true;
  const outputs = current.outputs.map((entry, position) => position === index ? { ...entry, state } : entry);
  Object.assign(stored, { outputs, updatedAt: now } satisfies Partial<PtcOutputState>);
  return true;
}

/** Read-only view for logs; a corrupt record yields `undefined` rather than a fabricated state. */
export function parsePtcJobState(value: unknown): PtcJobState | undefined {
  if (!Value.Check(PtcJobStateSchema, value)) return undefined;
  return value as PtcJobState;
}
