import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import {
  appendPtcOutputInTx,
  ensurePtcJobInTx,
  initialPtcJob,
  markPtcOutputState,
  markPtcWorkspaceReady,
  parsePtcJobState,
  PTC_OUTPUT_DOC_MAX_REFS,
  PtcDocError,
  type PtcOutputRef,
} from "../src/ptc-docs.js";
import type { RpcExecutionClient } from "../src/execution/rpc-client.js";
import { PtcExecutionEnv, PTC_DEFAULT_WINDOW, PTC_MAX_CALL_TIMEOUT_MS } from "../src/ptc-env.js";
import type { PtcSession } from "../src/ptc-session.js";
import type { PtcToolCallPayload, PtcToolCallResult } from "../src/execution/rpc-protocol.js";
import { RpcClientError } from "../src/execution/rpc-client.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const jobId = `ptc-${"a".repeat(32)}`;
const sessionId = "0123456789abcdef";
const conversationId = 1 as ConversationId;
const taskId = 1 as TaskId;
const blob = "b".repeat(64);

function outputRef(overrides: Partial<PtcOutputRef> = {}): PtcOutputRef {
  return {
    blobId: blob,
    jobId,
    sessionId,
    callId: 1,
    path: `/workspace/.ptc/outputs/${blob}`,
    size: 12,
    sha256: blob,
    createdAt: 100,
    expiresAt: 1_000,
    state: "available",
    ...overrides,
  };
}

/** A transaction whose family documents live in one map, one mutable draft per kind/key. */
function memoryTx(): { tx: Tx; documents: Map<string, unknown> } {
  const documents = new Map<string, unknown>();
  const tx = {
    doc: async (
      family: { readonly definition?: { readonly kind?: string } },
      _conversation: ConversationId,
      key: string,
      seed: unknown,
    ) => {
      const id = `${family.definition?.kind ?? "doc"}:${key}`;
      if (!documents.has(id)) documents.set(id, seed);
      return documents.get(id);
    },
  } as unknown as Tx;
  return { tx, documents };
}

test("PTC job records are created once, verified, and marked ready durably", async () => {
  const { tx, documents } = memoryTx();
  const seed = initialPtcJob(jobId, 10);
  const created = await ensurePtcJobInTx(tx, conversationId, seed);
  assert.deepEqual(created, seed);
  const again = await ensurePtcJobInTx(tx, conversationId, initialPtcJob(jobId, 20));
  assert.equal(again.createdAt, 10, "a rerun keeps the original record");

  const ready = await markPtcWorkspaceReady(tx, conversationId, jobId, 30);
  assert.equal(ready.workspaceReady, true);
  assert.equal(ready.updatedAt, 30);
  const idempotent = await markPtcWorkspaceReady(tx, conversationId, jobId, 40);
  assert.equal(idempotent.updatedAt, 30, "an already-ready workspace is not rewritten");

  assert.equal(parsePtcJobState(ready)?.workspaceReady, true);
  assert.equal(parsePtcJobState({ ...ready, version: 99 }), undefined);

  // A record stored under the derived key but naming another job is corruption, never a reuse.
  (documents.get(`aster.ptc.job:${jobId}`) as { jobId: string }).jobId = `ptc-${"c".repeat(32)}`;
  await assert.rejects(
    ensurePtcJobInTx(tx, conversationId, initialPtcJob(jobId, 1)),
    (error: unknown) => error instanceof PtcDocError && error.code === "job-mismatch",
  );
});

test("PTC output refs deduplicate by blob and evict the oldest at the bound", async () => {
  const { tx, documents } = memoryTx();
  const first = await appendPtcOutputInTx(tx, conversationId, jobId, outputRef(), 100);
  assert.equal(first.stored, true);
  assert.equal(first.state.outputs.length, 1);

  const duplicate = await appendPtcOutputInTx(tx, conversationId, jobId, outputRef({ callId: 2 }), 101);
  assert.equal(duplicate.stored, false);
  assert.equal(duplicate.state.outputs.length, 1, "the same blob is one entry");
  assert.equal(duplicate.state.outputs[0]?.callId, 1, "the first observation wins");

  for (let index = 1; index < PTC_OUTPUT_DOC_MAX_REFS + 1; index++) {
    const digest = index.toString(16).padStart(64, "0");
    await appendPtcOutputInTx(tx, conversationId, jobId, outputRef({
      blobId: digest,
      sha256: digest,
      path: `/workspace/.ptc/outputs/${digest}`,
    }), 200 + index);
  }
  const stored = documents.get(`aster.ptc.output:${jobId}`) as { outputs: PtcOutputRef[]; evicted: number };
  assert.equal(stored.outputs.length, PTC_OUTPUT_DOC_MAX_REFS);
  assert.equal(stored.evicted, 1, "the dropped ref is counted, not silently lost");
  assert.equal(stored.outputs[0]?.blobId, "1".padStart(64, "0"), "the oldest surviving ref is second");

  const newest = stored.outputs.at(-1)!;
  assert.equal(await markPtcOutputState(tx, conversationId, jobId, newest.blobId, "evicted", 300), true);
  assert.equal(await markPtcOutputState(tx, conversationId, jobId, "f".repeat(64), "evicted", 300), false);
});

test("PTC output refs must match the job and describe their own bytes", async () => {
  const { tx } = memoryTx();
  await assert.rejects(
    appendPtcOutputInTx(tx, conversationId, jobId, outputRef({ jobId: `ptc-${"d".repeat(32)}` }), 1),
    (error: unknown) => error instanceof PtcDocError && error.code === "job-mismatch",
  );
  await assert.rejects(
    appendPtcOutputInTx(tx, conversationId, jobId, outputRef({ blobId: "e".repeat(64) }), 1),
    (error: unknown) => error instanceof PtcDocError && error.code === "corrupt-state",
  );
  await assert.rejects(
    appendPtcOutputInTx(tx, conversationId, jobId, outputRef({ expiresAt: 1 }), 1),
    (error: unknown) => error instanceof PtcDocError && error.code === "corrupt-state",
  );
});

type Recorded = {
  readonly payload: PtcToolCallPayload;
  readonly deadlineMs: number | undefined;
};

function ptcEnv(options: {
  result?: (payload: PtcToolCallPayload) => Promise<PtcToolCallResult>;
  onOutputRef?: (ref: PtcOutputRef) => Promise<void>;
  file?: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const calls: Recorded[] = [];
  const committed: PtcOutputRef[] = [];
  const session: PtcSession = {
    // Only `startToolCall` and `fileRequest` are reachable from the environment.
    client: {
      startToolCall: (_sessionId: string, payload: PtcToolCallPayload, invoke: { deadlineMs?: number }) => {
        calls.push({ payload, deadlineMs: invoke.deadlineMs });
        const result = options.result === undefined
          ? Promise.resolve({ exitCode: 0, spillTruncated: false, durationMs: 1 })
          : options.result(payload);
        return { id: "call-1", result, cancel: () => undefined };
      },
      fileRequest: (_sessionId: string, method: string, payload: Record<string, unknown>) =>
        options.file === undefined
          ? Promise.reject(new RpcClientError("not_implemented", "no file transport", { outcome: "failed" }))
          : options.file(method, payload),
    } as unknown as RpcExecutionClient,
    sessionId,
    jobId,
    conversationId,
    taskId,
    registerVm: () => undefined,
  };
  const env = new PtcExecutionEnv({
    session,
    callId: 7,
    cwd: "/workspace",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60,
    onOutputRef: async (ref) => {
      committed.push(ref);
      await options.onOutputRef?.(ref);
    },
  });
  return { env, calls, committed };
}

test("the PTC environment turns a shell request into one tool.call and records its output ref", async () => {
  const ref = outputRef();
  const { env, calls, committed } = ptcEnv({
    result: async () => ({ exitCode: 3, spillTruncated: true, durationMs: 5, outputRef: ref }),
  });
  const result = await env.exec("echo hi", {
    timeout: 1.4,
    env: { A: "1" },
    window: { ...PTC_DEFAULT_WINDOW, maxBytes: 10 * 1024 * 1024 },
  }, BACKGROUND_CONTEXT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.exitCode, 3);
  assert.deepEqual(env.outputRef, ref);
  assert.equal(env.spillTruncated, true, "a truncated spill is reported, not hidden");
  assert.deepEqual(committed, [ref], "the ref is persisted before the result reaches the script");

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.payload.tool, "bash");
  assert.equal(call.payload.callId, 7);
  assert.equal(call.payload.args.command, "echo hi");
  assert.equal(call.payload.args.cwd, "/workspace");
  assert.deepEqual(call.payload.args.env, { A: "1" });
  assert.equal(call.payload.args.timeoutMs, 2_000, "a sub-second timeout rounds up, never to zero");
  assert.equal(call.deadlineMs, 62_000, "the transport deadline leaves the runner time to report");
});

test("the PTC environment refuses paths and timeouts it cannot honor", async () => {
  const { env, calls } = ptcEnv();
  const wrongDirectory = await env.exec("id", { cwd: "/tmp" }, BACKGROUND_CONTEXT);
  assert.equal(wrongDirectory.ok, false);
  if (!wrongDirectory.ok) assert.match(wrongDirectory.error.message, /runs commands only in \/workspace/);

  const tooLong = await env.exec("id", { timeout: PTC_MAX_CALL_TIMEOUT_MS / 1_000 }, BACKGROUND_CONTEXT);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.code, "timeout");

  assert.equal(calls.length, 0, "no request reaches the agent without a valid command contract");
});

test("the PTC environment fails the call when its output ref cannot be recorded", async () => {
  const ref = outputRef();
  const { env } = ptcEnv({
    result: async () => ({ exitCode: 0, spillTruncated: false, durationMs: 1, outputRef: ref }),
    onOutputRef: async () => {
      throw new Error("disk full");
    },
  });
  const result = await env.exec("echo hi", undefined, BACKGROUND_CONTEXT);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "callback_error");
    assert.match(result.error.message, /may have run/);
  }
});

test("the PTC environment maps agent failures and delegates file tools to the session", async () => {
  const timeouts = ptcEnv({ result: async () => Promise.reject(new RpcClientError("timeout", "late")) });
  const timeout = await timeouts.env.exec("sleep 9", undefined, BACKGROUND_CONTEXT);
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.error.code, "timeout");

  const unavailable = ptcEnv({ result: async () => Promise.reject(new RpcClientError("unavailable", "gone")) });
  const unknown = await unavailable.env.exec("id", undefined, BACKGROUND_CONTEXT);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error.message, /outcome is unknown/);

  const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const { env } = ptcEnv({
    file: async (method, payload) => {
      requests.push({ method, payload });
      if (method === "file.readText") return { data: Buffer.from("hola").toString("base64") };
      if (method === "file.write") return { info: { name: "b.txt", path: "/workspace/b.txt", kind: "file", size: 4, mtimeMs: 1 } };
      return Promise.reject(new RpcClientError("not_found", "missing", { outcome: "failed" }));
    },
  });
  const read = await env.readTextFile("/workspace/a.txt", BACKGROUND_CONTEXT);
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.value, "hola");
  const written = await env.writeFile("/workspace/b.txt", "data", BACKGROUND_CONTEXT);
  assert.equal(written.ok, true);
  assert.deepEqual(requests.map(({ method }) => method), ["file.readText", "file.write"]);
  assert.equal(requests[1]?.payload.path, "/workspace/b.txt", "the virtual path crosses, never a host path");

  // Namespace operations the sandbox cannot honor stay closed rather than half-implemented.
  const list = await env.listDir("/workspace", BACKGROUND_CONTEXT);
  assert.equal(list.ok, false);
  if (!list.ok) assert.equal(list.error.code, "not_supported");
});
