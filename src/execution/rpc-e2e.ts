import { randomUUID } from "node:crypto";
import { RpcClientError } from "./rpc-client.js";
import { readRpcClientConfig } from "./rpc-config.js";
import { connectRpcClient } from "./rpc-connect.js";

const USAGE = `Usage: node dist/src/execution/rpc-e2e.js

Runs the Phase 0 acceptance loop from the gateway host: health, preflight, session.open, a streamed
test execution, cancellation of a sleeping execution, and session.close. Reads EXECUTION_RPC_*.
Only the restricted test executor is used; this command cannot run a shell command.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const client = await connectRpcClient(readRpcClientConfig());
  const sessionId = `e2e-${randomUUID().slice(0, 8)}`;
  try {
    const health = await client.health();
    const preflight = await client.preflight();
    await client.openSession(sessionId, { jobId: "e2e-job" });

    const streamed: string[] = [];
    const stream = client.startTestExecute(sessionId, {
      executor: "test",
      operation: "stream",
      chunks: 3,
      chunkBytes: 32,
      delayMs: 5,
    }, {
      deadlineMs: 5_000,
      onOutput: (event) => streamed.push(event.text),
    });
    const streamResult = await stream.result;
    const streamBytes = streamResult.operation === "stream" ? streamResult.bytes : 0;

    const sleeping = client.startTestExecute(sessionId, {
      executor: "test",
      operation: "sleep",
      ms: 5_000,
    }, { deadlineMs: 6_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await client.cancel(sessionId, sleeping.id, "e2e cancel");
    let cancelCode: string | undefined;
    let cancelOutcome: string | undefined;
    try {
      await sleeping.result;
    } catch (error) {
      if (error instanceof RpcClientError) {
        cancelCode = error.code;
        cancelOutcome = error.options.outcome;
      } else {
        throw error;
      }
    }
    await client.closeSession(sessionId);
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      executionId: health.executionId,
      transport: health.transport,
      protocol: health.protocol,
      preflightOk: preflight.ok,
      streamChunks: streamed.length,
      streamBytes,
      cancelCode,
      cancelOutcome,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof RpcClientError ? error.code : "E2E_FAILED";
  const message = error instanceof RpcClientError ? error.message : "RPC end-to-end check failed";
  process.stderr.write(`${JSON.stringify({ status: "error", code, message })}\n`);
  process.exitCode = 1;
}
