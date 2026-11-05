import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClientError, RpcExecutionClient } from "../src/execution/rpc-client.js";
import { PTC_WORKSPACE_PATH } from "../src/execution/rpc-protocol.js";
import { startRpcAgent } from "../src/execution/rpc-server.js";
import { listenTlsRpc, tlsRpcTransport } from "../src/execution/rpc-transport.js";
import { TestPtcHost } from "./ptc-test-host.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/rpc-tls", import.meta.url));

test("PTC RPC runs a VM, routes its nested call to the sandbox, and answers the VM", { timeout: 30_000 }, async () => {
  const [ca, cert, key, clientCert, clientKey] = await Promise.all([
    readFile(join(fixtureDirectory, "ca.crt")),
    readFile(join(fixtureDirectory, "server.crt")),
    readFile(join(fixtureDirectory, "server.key")),
    readFile(join(fixtureDirectory, "client.crt")),
    readFile(join(fixtureDirectory, "client.key")),
  ]);
  const ptc = new TestPtcHost();
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
    ptc,
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
    assert.equal(health.phase, 1);
    assert.equal(health.ptc, true);
    assert.equal(health.testExecutor, false);
    assert.equal(health.directBash, false);
    assert.equal(health.fileTools, true);
    assert.ok(health.methods.includes("file.write"));

    const preflight = await client.preflight();
    assert.equal(preflight.ok, true);
    assert.equal(preflight.checks.ptc, true);

    // A session id that cannot name a cgroup is the client's mistake, not a sandbox failure.
    await assert.rejects(
      client.openSession("acc-1234abcd", { jobId: "job-ptc-1" }),
      (error: unknown) => error instanceof RpcClientError
        && error.code === "invalid_request"
        && /16 lowercase hexadecimal/.test(error.message),
    );

    const opened = await client.openSession("0a1b2c3d4e5f6071", { jobId: "job-ptc-1" });
    assert.equal(opened.workspaceReady?.created, true);

    const output: string[] = [];
    let callArgs: unknown;
    let terminal: Record<string, unknown> | undefined;
    let handlerFailure: unknown;
    const handle = client.startVm("0a1b2c3d4e5f6071", {
      request: {
        data: {
          code: `
            const first = await tools.bash({ command: "printf nested" });
            return first.output;
          `,
          tools: [{ name: "bash", jsName: "bash", description: "Run a command" }],
          globals: [],
          store: {},
        },
      },
    }, {
      deadlineMs: 10_000,
      onVmMessage: (event) => {
        const messages = event.messages as Array<Record<string, unknown>>;
        terminal = messages.find((message) => message.type === "done") ?? terminal;
        if (event.callId === undefined) return;
        const callId = event.callId;
        const call = messages.find((message) => message.type === "call" && message.id === callId);
        callArgs = JSON.parse(String(call?.args));
        void (async () => {
          // Answering a call the VM is not waiting on must fail, not report `delivered: true`.
          await assert.rejects(
            client.replyVm("0a1b2c3d4e5f6071", {
              callId: callId + 1,
              reply: { type: "result", id: callId + 1, ok: true, payload: "{}" },
            }),
            (error: unknown) => error instanceof RpcClientError && error.code === "invalid_request",
          );
          const tool = client.startToolCall("0a1b2c3d4e5f6071", {
            tool: "bash",
            callId,
            args: {
              command: "printf nested",
              cwd: PTC_WORKSPACE_PATH,
              env: {},
              inheritEnv: false,
              timeoutMs: 1_000,
              window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
            },
          }, {
            deadlineMs: 5_000,
            onToolOutput: (chunk) => output.push(chunk.text),
          });
          try {
            const result = await tool.result;
            await client.replyVm("0a1b2c3d4e5f6071", {
              callId,
              reply: {
                type: "result",
                id: callId,
                ok: true,
                payload: JSON.stringify({ output: output.join(""), exitCode: result.exitCode }),
              },
            });
          } catch (error) {
            await client.replyVm("0a1b2c3d4e5f6071", {
              callId,
              reply: {
                type: "result",
                id: callId,
                ok: false,
                payload: error instanceof Error ? error.message : "the nested call failed",
              },
            });
          }
        })().catch((error: unknown) => {
          handlerFailure = error;
        });
      },
    });
    await handle.result;
    assert.equal(handlerFailure, undefined, "the VM message handler failed");

    assert.deepEqual(callArgs, { command: "printf nested" }, "the VM's argument object crossed unchanged");
    assert.equal(ptc.calls.length, 1, "the nested call ran once in the sandbox");
    assert.equal(ptc.calls[0]?.args.command, "printf nested");
    assert.equal(ptc.calls[0]?.args.cwd, PTC_WORKSPACE_PATH);
    assert.deepEqual(output, ["out-1"], "windowed output reached the gateway");
    assert.equal(terminal?.ok, true);
    assert.match(String(terminal?.value), /out-1/, "the script returned the tool result");

    await client.closeSession("0a1b2c3d4e5f6071");
  } finally {
    await client.close();
    await agent.close();
  }
});
