import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClientError, RpcExecutionClient } from "../src/execution/rpc-client.js";
import { startRpcAgent } from "../src/execution/rpc-server.js";
import { listenTlsRpc, tlsRpcTransport } from "../src/execution/rpc-transport.js";
import type { DirectHost } from "../src/execution/ptc-host.js";
import { PtcHostError } from "../src/execution/ptc-host.js";
import type { RpcBashExecutePayload, RpcFileMethod, RpcSkippedOutput } from "../src/execution/rpc-protocol.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/rpc-tls", import.meta.url));

/** A direct host that records what crossed the wire instead of starting bwrap. */
class RecordingDirectHost implements DirectHost {
  readonly enabled = true;
  readonly sharedMode = "rw" as const;
  readonly sessions: string[] = [];
  readonly executions: RpcBashExecutePayload[] = [];
  readonly files: Array<{ method: RpcFileMethod; payload: Record<string, unknown> }> = [];
  readonly closed: string[] = [];

  async preflight(): Promise<Record<string, boolean | null>> {
    return { direct: true, sharedWorkspace: true, directTmpRoot: true };
  }

  async openSession(sessionId: string): Promise<{ sharedMode: "ro" | "rw"; tmpPath: string }> {
    this.sessions.push(sessionId);
    return { sharedMode: "rw", tmpPath: "/srv/aster/direct-tmp/one" };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }

  async execute(input: {
    sessionId: string;
    payload: RpcBashExecutePayload;
    signal: AbortSignal;
    emit: (seq: number, stream: "stdout" | "stderr", text: string, skipped?: RpcSkippedOutput) => void;
  }): Promise<{ exitCode: number; durationMs: number }> {
    this.executions.push(input.payload);
    input.emit(1, "stdout", "first\n");
    input.emit(2, "stderr", "second\n");
    return { exitCode: 3, durationMs: 5 };
  }

  async fileRequest(input: {
    sessionId: string;
    method: RpcFileMethod;
    payload: Record<string, unknown>;
  }): Promise<unknown> {
    this.files.push({ method: input.method, payload: input.payload });
    if (input.method === "file.write") {
      return { info: { name: "a.txt", path: "/shared/a.txt", kind: "file", size: 4, mtimeMs: 1 } };
    }
    if (input.method === "file.readText") return { data: Buffer.from("hola").toString("base64") };
    throw new PtcHostError("not_found", "missing", "failed");
  }
}

test("direct sessions run bash and file primitives over RPC", { timeout: 30_000 }, async () => {
  const [ca, cert, key, clientCert, clientKey] = await Promise.all([
    readFile(join(fixtureDirectory, "ca.crt")),
    readFile(join(fixtureDirectory, "server.crt")),
    readFile(join(fixtureDirectory, "server.key")),
    readFile(join(fixtureDirectory, "client.crt")),
    readFile(join(fixtureDirectory, "client.key")),
  ]);
  const direct = new RecordingDirectHost();
  const server = await listenTlsRpc({
    host: "127.0.0.1",
    port: 0,
    cert,
    key,
    ca,
    requireClientCert: true,
    allowedClientNames: ["aster-test-gateway"],
    maxFrameBytes: 4 * 1024 * 1024,
  });
  const address = server.address();
  assert.ok(!("path" in address));
  const agent = startRpcAgent({
    server,
    executionId: "0123456789abcdef",
    transport: "tls",
    heartbeatMs: 60_000,
    sessionTtlMs: 60_000,
    testExecutorEnabled: false,
    direct,
  });
  const client = new RpcExecutionClient({
    transport: tlsRpcTransport({
      host: "127.0.0.1",
      port: address.port,
      servername: "localhost",
      ca,
      cert: clientCert,
      key: clientKey,
      connectTimeoutMs: 3_000,
    }),
    requestTimeoutMs: 5_000,
  });
  try {
    await client.connect();
    const health = await client.health();
    assert.equal(health.phase, 2);
    assert.equal(health.directBash, true);
    assert.equal(health.fileTools, true);
    assert.equal(health.sharedMode, "rw");
    assert.ok(health.methods.includes("file.write"));

    const preflight = await client.preflight();
    assert.equal(preflight.checks.direct, true);

    const opened = await client.openSession("0123456789abcdef");
    assert.deepEqual(opened.direct, { sharedMode: "rw", workspace: "/shared", tmp: "/tmp" });
    assert.deepEqual(direct.sessions, ["0123456789abcdef"]);

    const output: Array<{ text: string; stream: string }> = [];
    const handle = client.startBashExecute("0123456789abcdef", {
      executor: "bash",
      command: "printf hi",
      cwd: "/shared/project",
      env: { A: "1" },
      inheritEnv: false,
      timeoutMs: 2_000,
      window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
    }, {
      deadlineMs: 10_000,
      onOutput: (event) => output.push({ text: event.text, stream: event.stream }),
    });
    const result = await handle.result;
    assert.deepEqual(result, { exitCode: 3, durationMs: 5 });
    assert.deepEqual(output, [
      { text: "first\n", stream: "stdout" },
      { text: "second\n", stream: "stderr" },
    ]);
    assert.equal(direct.executions[0]?.cwd, "/shared/project");
    assert.deepEqual(direct.executions[0]?.env, { A: "1" });

    const written = await client.fileRequest("0123456789abcdef", "file.write", {
      path: "/shared/a.txt",
      content: Buffer.from("hola").toString("base64"),
    }) as { info: { path: string } };
    assert.equal(written.info.path, "/shared/a.txt");
    const text = await client.fileRequest("0123456789abcdef", "file.readText", { path: "/shared/a.txt" }) as { data: string };
    assert.equal(Buffer.from(text.data, "base64").toString("utf8"), "hola");

    await assert.rejects(
      client.fileRequest("0123456789abcdef", "file.stat", { path: "/shared/missing" }),
      (error: unknown) => error instanceof RpcClientError
        && error.code === "not_found"
        && error.options.outcome === "failed",
    );

    // A syntactically valid frame with a bad payload is answered on that request only: traversal is
    // an authorization failure, a NUL or relative path is a malformed one, and the connection stays.
    await assert.rejects(
      client.fileRequest("0123456789abcdef", "file.readText", { path: "/shared/../etc/passwd" }),
      (error: unknown) => error instanceof RpcClientError
        && error.code === "permission_denied"
        && error.options.outcome === "not_started",
    );
    await assert.rejects(
      client.fileRequest("0123456789abcdef", "file.readText", { path: "/shared/a\0b" }),
      (error: unknown) => error instanceof RpcClientError
        && error.code === "invalid_request"
        && error.options.outcome === "not_started",
    );
    await assert.rejects(
      client.fileRequest("0123456789abcdef", "file.readText", { path: "shared/a.txt" }),
      (error: unknown) => error instanceof RpcClientError && error.code === "invalid_request",
    );
    await assert.rejects(
      client.startToolCall("0123456789abcdef", {
        tool: "bash",
        callId: 1,
        args: {
          command: "id",
          // Deliberately outside the sandbox workspace; the payload gate must refuse it.
          cwd: "/etc" as unknown as "/workspace",
          env: {},
          inheritEnv: false,
          timeoutMs: 1_000,
          window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
        },
      }).result,
      (error: unknown) => error instanceof RpcClientError && error.code === "invalid_request",
    );
    const healthAfterBadPayloads = await client.health();
    assert.equal(healthAfterBadPayloads.executionId, "0123456789abcdef");
    assert.equal(direct.files.length, 3, "no rejected payload reached the host");

    // A job-scoped session belongs to the PTC sandbox and never gets the direct bash executor.
    await client.openSession("fedcba9876543210", { jobId: `ptc-${"a".repeat(32)}` });
    await assert.rejects(
      client.startBashExecute("fedcba9876543210", {
        executor: "bash",
        command: "id",
        cwd: "/shared",
        env: {},
        inheritEnv: false,
        timeoutMs: 1_000,
        window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
      }).result,
      (error: unknown) => error instanceof RpcClientError && error.code === "not_implemented",
    );

    await client.closeSession("0123456789abcdef");
    assert.deepEqual(direct.closed, ["0123456789abcdef"]);
  } finally {
    await client.close().catch(() => undefined);
    await agent.close().catch(() => undefined);
  }
});
