import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClientError, RpcExecutionClient } from "../src/execution/rpc-client.js";
import {
  describeRpcAgentConfig,
  parseAddress,
  readRpcAgentConfig,
  readRpcClientConfig,
} from "../src/execution/rpc-config.js";
import {
  RpcFrameDecoder,
  RpcProtocolError,
  encodeRpcFrame,
  parseRpcFrame,
  type RpcFrame,
  type RpcRequestFrame,
} from "../src/execution/rpc-protocol.js";
import { startRpcAgent, type RpcAgentOptions } from "../src/execution/rpc-server.js";
import {
  listenTlsRpc,
  listenUnixRpc,
  tlsRpcTransport,
  unixRpcTransport,
  type RpcConnection,
} from "../src/execution/rpc-transport.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/rpc-tls", import.meta.url));

type Fixture = {
  readonly ca: Buffer;
  readonly serverCert: Buffer;
  readonly serverKey: Buffer;
  readonly clientCert: Buffer;
  readonly clientKey: Buffer;
  readonly otherClientCert: Buffer;
  readonly otherClientKey: Buffer;
  readonly otherCa: Buffer;
};

async function readFixture(): Promise<Fixture> {
  const [
    ca, serverCert, serverKey, clientCert, clientKey, otherClientCert, otherClientKey, otherCa,
  ] = await Promise.all([
    readFile(join(fixtureDirectory, "ca.crt")),
    readFile(join(fixtureDirectory, "server.crt")),
    readFile(join(fixtureDirectory, "server.key")),
    readFile(join(fixtureDirectory, "client.crt")),
    readFile(join(fixtureDirectory, "client.key")),
    readFile(join(fixtureDirectory, "other-client.crt")),
    readFile(join(fixtureDirectory, "other-client.key")),
    readFile(join(fixtureDirectory, "other-ca.crt")),
  ]);
  return {
    ca,
    serverCert,
    serverKey,
    clientCert,
    clientKey,
    otherClientCert,
    otherClientKey,
    otherCa,
  };
}

type AgentFixture = {
  readonly agent: ReturnType<typeof startRpcAgent>;
  readonly port: number;
  readonly fixture: Fixture;
  close(): Promise<void>;
};

async function startAgent(overrides: Partial<RpcAgentOptions> = {}): Promise<AgentFixture> {
  const fixture = await readFixture();
  const server = await listenTlsRpc({
    host: "127.0.0.1",
    port: 0,
    cert: fixture.serverCert,
    key: fixture.serverKey,
    ca: fixture.ca,
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
    testExecutorEnabled: true,
    ...overrides,
  });
  return {
    agent,
    port: address.port,
    fixture,
    close: () => agent.close(),
  };
}

function clientFor(agent: AgentFixture, overrides: { servername?: string; ca?: Buffer } = {}): RpcExecutionClient {
  return new RpcExecutionClient({
    transport: tlsRpcTransport({
      host: "127.0.0.1",
      port: agent.port,
      servername: overrides.servername ?? "localhost",
      ca: overrides.ca ?? agent.fixture.ca,
      cert: agent.fixture.clientCert,
      key: agent.fixture.clientKey,
      connectTimeoutMs: 3_000,
    }),
    requestTimeoutMs: 5_000,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseFrame(frame: RpcFrame): Extract<RpcFrame, { kind: "response" }> {
  assert.equal(frame.kind, "response");
  return frame as Extract<RpcFrame, { kind: "response" }>;
}

function assertErrorResponse(frame: RpcFrame, code: string): void {
  const response = responseFrame(frame);
  assert.equal(response.status, "error");
  if (response.status !== "error") return;
  assert.equal(response.error.code, code);
}

type FrameCollector = {
  waitFor(predicate: (frame: RpcFrame) => boolean, timeoutMs?: number): Promise<RpcFrame>;
};

function collect(connection: RpcConnection): FrameCollector {
  const frames: RpcFrame[] = [];
  const waiters: Array<{
    readonly predicate: (frame: RpcFrame) => boolean;
    readonly resolve: (frame: RpcFrame) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }> = [];
  connection.onFrame((frame) => {
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  return {
    waitFor(predicate, timeoutMs = 2_000) {
      const existing = frames.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<RpcFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error("timed out waiting for an RPC frame"));
        }, timeoutMs);
        timer.unref();
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

function request(
  id: string,
  method: RpcRequestFrame["method"],
  payload: Record<string, unknown>,
  sessionId?: string,
): RpcRequestFrame {
  return {
    v: 1,
    kind: "request",
    id,
    method,
    deadlineMs: 5_000,
    payload,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

test("RPC frame decoder handles split frames and rejects an oversized frame", () => {
  const frame: RpcFrame = {
    v: 1,
    kind: "request",
    id: "health-1",
    method: "health.check",
    deadlineMs: 1_000,
    payload: {},
  };
  const encoded = encodeRpcFrame(frame);
  const decoder = new RpcFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(encoded.subarray(2, 7)), []);
  const decoded = decoder.push(encoded.subarray(7));
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], frame);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(1024, 0);
  assert.throws(
    () => new RpcFrameDecoder(512).push(oversized),
    (error: unknown) => error instanceof RpcProtocolError && error.code === "too_large",
  );
});

test("RPC parser rejects unknown fields, a wrong version, and an unknown method", () => {
  const base = {
    v: 1,
    kind: "request",
    id: "parse-1",
    method: "health.check",
    deadlineMs: 1_000,
    payload: {},
  };
  assert.equal(parseRpcFrame(base).ok, true);
  assert.equal(parseRpcFrame({ ...base, extra: true }).ok, false);
  assert.equal(parseRpcFrame({ ...base, v: 2 }).ok, false);
  assert.equal(parseRpcFrame({ ...base, method: "unknown.method" }).ok, false);
  // A valid envelope with a bad payload stays a request: the dispatcher answers it and keeps the
  // connection open. Only envelope failures close it.
  const badPayload = parseRpcFrame({ ...base, payload: { extra: true } });
  assert.equal(badPayload.ok, true);
  if (badPayload.ok) {
    const frame = badPayload.value as RpcRequestFrame;
    assert.deepEqual(frame.payload, {});
    assert.deepEqual(frame, {
      ...base,
      payload: {},
      payloadError: { code: "invalid_request", message: "unknown payload field: extra" },
    });
  }
});

test("RPC request payloads classify traversal and syntax errors without failing the frame", () => {
  const base = {
    v: 1,
    kind: "request",
    id: "parse-2",
    method: "file.readText",
    deadlineMs: 1_000,
  };
  const traversal = parseRpcFrame({ ...base, payload: { path: "/shared/../etc/passwd" } });
  assert.equal(traversal.ok, true);
  if (traversal.ok) assert.equal((traversal.value as RpcRequestFrame).payloadError?.code, "permission_denied");
  for (const path of ["/shared/a\0b", "shared/a.txt", "/shared/a\\b"]) {
    const malformed = parseRpcFrame({ ...base, payload: { path } });
    assert.equal(malformed.ok, true);
    if (malformed.ok) assert.equal((malformed.value as RpcRequestFrame).payloadError?.code, "invalid_request");
  }
  const wrongCwd = parseRpcFrame({
    ...base,
    method: "tool.call",
    payload: {
      tool: "bash",
      callId: 1,
      args: {
        command: "id",
        cwd: "/etc",
        env: {},
        inheritEnv: false,
        timeoutMs: 1_000,
        window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
      },
    },
  });
  assert.equal(wrongCwd.ok, true);
  if (wrongCwd.ok) assert.equal((wrongCwd.value as RpcRequestFrame).payloadError?.code, "invalid_request");
});

test("Unix socket transport carries health, session, and a test execution", {
  skip: process.platform === "win32" ? "Unix domain sockets are exercised on POSIX CI" : false,
  timeout: 20_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-rpc-"));
  const socketPath = join(directory, "agent.sock");
  const server = await listenUnixRpc(socketPath);
  const agent = startRpcAgent({
    server,
    executionId: "fedcba9876543210",
    transport: "unix",
    heartbeatMs: 60_000,
    sessionTtlMs: 60_000,
    testExecutorEnabled: true,
  });
  const client = new RpcExecutionClient({
    transport: unixRpcTransport(socketPath),
    requestTimeoutMs: 5_000,
  });
  try {
    await client.connect();
    const health = await client.health();
    assert.equal(health.executionId, "fedcba9876543210");
    assert.equal(health.transport, "unix");

    await client.openSession("sess-unix", { jobId: "job-unix" });
    const output: string[] = [];
    const echo = client.startTestExecute("sess-unix", {
      executor: "test",
      operation: "echo",
      text: "hello over unix",
    }, {
      deadlineMs: 2_000,
      onOutput: (event) => output.push(event.text),
    });
    await echo.result;
    assert.equal(output.join(""), "hello over unix");
    await client.closeSession("sess-unix");
  } finally {
    await client.close();
    await agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC accepts health, streams output, and cancels a running test execution over mutual TLS", { timeout: 20_000 }, async () => {
  const agent = await startAgent();
  const client = clientFor(agent);
  try {
    await client.connect();
    const health = await client.health();
    assert.equal(health.executionId, "0123456789abcdef");
    assert.equal(health.protocol, 1);
    assert.equal(health.transport, "tls");
    assert.equal(health.testExecutor, true);

    const preflight = await client.preflight();
    assert.equal(preflight.ok, true);
    assert.equal(preflight.checks.testExecutor, true);
    assert.equal(preflight.checks.mutualTls, true);

    await client.openSession("sess-main", { jobId: "job-test" });

    const echoOutput: string[] = [];
    const echo = client.startTestExecute("sess-main", {
      executor: "test",
      operation: "echo",
      text: "hello over tls",
    }, {
      deadlineMs: 2_000,
      onOutput: (event) => echoOutput.push(event.text),
    });
    const echoResult = await echo.result;
    assert.equal(echoResult.operation, "echo");
    assert.equal(echoOutput.join(""), "hello over tls");

    const streamOutput: Array<{ seq: number; text: string }> = [];
    const stream = client.startTestExecute("sess-main", {
      executor: "test",
      operation: "stream",
      chunks: 3,
      chunkBytes: 16,
      delayMs: 1,
    }, {
      deadlineMs: 2_000,
      onOutput: (event) => streamOutput.push({ seq: event.seq, text: event.text }),
    });
    const streamResult = await stream.result;
    assert.equal(streamOutput.length, 3);
    assert.deepEqual(streamOutput.map((event) => event.seq), [1, 2, 3]);
    assert.match(streamOutput.map((event) => event.text).join(""), /chunk-0:/);
    assert.equal(streamResult.operation, "stream");
    if (streamResult.operation === "stream") assert.ok(streamResult.bytes > 0);

    const sleeping = client.startTestExecute("sess-main", {
      executor: "test",
      operation: "sleep",
      ms: 5_000,
    }, { deadlineMs: 6_000 });
    await delay(30);
    await client.cancel("sess-main", sleeping.id, "test cancellation");
    await assert.rejects(
      sleeping.result,
      (error: unknown) => error instanceof RpcClientError
        && error.code === "aborted"
        && error.options.outcome === "unknown",
    );

    await client.closeSession("sess-main");
  } finally {
    await client.close();
    await agent.close();
  }
});

test("RPC rejects a missing client certificate, an unknown CA, a wrong server name, and an unlisted client CN", { timeout: 20_000 }, async () => {
  const agent = await startAgent();
  try {
    const noCertificate = new RpcExecutionClient({
      transport: tlsRpcTransport({
        host: "127.0.0.1",
        port: agent.port,
        servername: "localhost",
        ca: agent.fixture.ca,
        connectTimeoutMs: 2_000,
      }),
      requestTimeoutMs: 2_000,
    });
    let withoutCertificateWasUnusable = false;
    try {
      await noCertificate.connect();
      await noCertificate.health();
    } catch {
      withoutCertificateWasUnusable = true;
    } finally {
      await noCertificate.close();
    }
    assert.equal(withoutCertificateWasUnusable, true, "a client without a certificate must not reach health.check");

    const wrongIdentity = new RpcExecutionClient({
      transport: tlsRpcTransport({
        host: "127.0.0.1",
        port: agent.port,
        servername: "localhost",
        ca: agent.fixture.ca,
        cert: agent.fixture.otherClientCert,
        key: agent.fixture.otherClientKey,
        connectTimeoutMs: 2_000,
      }),
      requestTimeoutMs: 2_000,
    });
    let wrongIdentityWasUnusable = false;
    try {
      await wrongIdentity.connect();
      await wrongIdentity.health();
    } catch {
      wrongIdentityWasUnusable = true;
    } finally {
      await wrongIdentity.close();
    }
    assert.equal(wrongIdentityWasUnusable, true, "a certificate with an unlisted CN must not reach health.check");

    const unknownCa = tlsRpcTransport({
      host: "127.0.0.1",
      port: agent.port,
      servername: "localhost",
      ca: agent.fixture.otherCa,
      cert: agent.fixture.clientCert,
      key: agent.fixture.clientKey,
      connectTimeoutMs: 2_000,
    });
    await assert.rejects(unknownCa.connect());

    const wrongName = tlsRpcTransport({
      host: "127.0.0.1",
      port: agent.port,
      servername: "wrong.example",
      ca: agent.fixture.ca,
      cert: agent.fixture.clientCert,
      key: agent.fixture.clientKey,
      connectTimeoutMs: 2_000,
    });
    await assert.rejects(wrongName.connect());
  } finally {
    await agent.close();
  }
});

test("Phase 0 only exposes the test executor and deduplicates request ids per connection", { timeout: 20_000 }, async () => {
  const agent = await startAgent();
  const connection = await tlsRpcTransport({
    host: "127.0.0.1",
    port: agent.port,
    servername: "localhost",
    ca: agent.fixture.ca,
    cert: agent.fixture.clientCert,
    key: agent.fixture.clientKey,
    connectTimeoutMs: 3_000,
  }).connect();
  const frames = collect(connection);
  try {
    connection.send(request("open-1", "session.open", { sessionId: "sess-raw" }));
    const opened = responseFrame(await frames.waitFor((frame) => frame.kind === "response" && frame.id === "open-1"));
    assert.equal(opened.status, "ok");

    // Well-formed for the protocol boundary even though this agent runs Phase 0: the frame is
    // parsed (and so must be valid) before the dispatcher can answer `not_implemented`.
    connection.send(request("bash-1", "execute", {
      executor: "bash",
      command: "id",
      cwd: "/shared",
      env: {},
      inheritEnv: false,
      timeoutMs: 1_000,
      window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
    }, "sess-raw"));
    assertErrorResponse(
      await frames.waitFor((frame) => frame.kind === "response" && frame.id === "bash-1"),
      "not_implemented",
    );

    connection.send(request("tool-1", "tool.call", {
      tool: "bash",
      callId: 1,
      args: {
        command: "id",
        cwd: "/workspace",
        env: {},
        inheritEnv: false,
        timeoutMs: 1_000,
        window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
      },
    }, "sess-raw"));
    assertErrorResponse(
      await frames.waitFor((frame) => frame.kind === "response" && frame.id === "tool-1"),
      "not_implemented",
    );

    connection.send(request("dup-1", "execute", {
      executor: "test",
      operation: "sleep",
      ms: 5_000,
    }, "sess-raw"));
    await delay(30);
    connection.send(request("dup-1", "health.check", {}));
    assertErrorResponse(
      await frames.waitFor((frame) => frame.kind === "response" && frame.id === "dup-1" && frame.status === "error"),
      "invalid_request",
    );
  } finally {
    connection.close();
    await agent.close();
  }
});

test("closing the client fails an in-flight execution as unknown and never auto-reconnects", { timeout: 20_000 }, async () => {
  const agent = await startAgent();
  const client = clientFor(agent);
  try {
    await client.connect();
    await client.openSession("sess-drop");
    const sleeping = client.startTestExecute("sess-drop", {
      executor: "test",
      operation: "sleep",
      ms: 5_000,
    }, { deadlineMs: 6_000 });
    await delay(30);
    await client.close();
    await assert.rejects(
      sleeping.result,
      (error: unknown) => error instanceof RpcClientError
        && error.code === "unavailable"
        && error.options.outcome === "unknown",
    );
    await assert.rejects(client.health(), (error: unknown) =>
      error instanceof RpcClientError && error.code === "unavailable");
  } finally {
    await agent.close();
  }
});

test("agent configuration rejects wildcard and public bind addresses and requires an IP literal", () => {
  const base = {
    EXECUTION_AGENT_BIND: "10.1.2.3",
    EXECUTION_AGENT_PORT: "9443",
    EXECUTION_AGENT_TLS_CERT_PATH: "/run/aster/rpc/server.crt",
    EXECUTION_AGENT_TLS_KEY_PATH: "/run/aster/rpc/server.key",
    EXECUTION_AGENT_TLS_CA_PATH: "/run/aster/rpc/ca.crt",
    EXECUTION_AGENT_CLIENT_CERT_CN: "aster-gateway",
  };
  const config = readRpcAgentConfig(base);
  assert.equal(config.transport, "tls");
  assert.equal(config.bind, "10.1.2.3");
  assert.equal(config.port, 9443);
  assert.equal(config.clientCertName, "aster-gateway");
  assert.match(config.executionId, /^[a-f0-9]{16}$/);
  assert.equal(describeRpcAgentConfig(config).transport, "tls");

  assert.throws(() => readRpcAgentConfig({ ...base, EXECUTION_AGENT_BIND: "0.0.0.0" }), /wildcard/);
  assert.throws(() => readRpcAgentConfig({ ...base, EXECUTION_AGENT_BIND: "8.8.8.8" }), /private or loopback/);
  assert.throws(() => readRpcAgentConfig({ ...base, EXECUTION_AGENT_BIND: "localhost" }), /IP literal/);
  assert.throws(
    () => readRpcAgentConfig({ ...base, EXECUTION_AGENT_REQUIRE_CLIENT_CERT: "0" }),
    /mTLS is required/,
  );
  assert.throws(
    () => readRpcAgentConfig({ ...base, EXECUTION_AGENT_CLIENT_CERT_CN: "" }),
    /EXECUTION_AGENT_CLIENT_CERT_CN/,
  );
});

test("client configuration parses TLS and Unix transports without accepting hostnames in addresses", () => {
  const tls = readRpcClientConfig({
    EXECUTION_RPC_ADDRESS: "EXECUTION_HOST:9443",
    EXECUTION_RPC_CA_PATH: "/run/aster/rpc/ca.crt",
    EXECUTION_RPC_CERT_PATH: "/run/aster/rpc/client.crt",
    EXECUTION_RPC_KEY_PATH: "/run/aster/rpc/client.key",
  });
  assert.equal(tls.transport, "tls");
  assert.equal(tls.host, "EXECUTION_HOST");
  assert.equal(tls.port, 9443);

  const unix = readRpcClientConfig({
    EXECUTION_RPC_TRANSPORT: "unix",
    EXECUTION_RPC_SOCKET: "/run/aster/execution/rpc.sock",
  });
  assert.equal(unix.transport, "unix");
  assert.equal(unix.socketPath, "/run/aster/execution/rpc.sock");

  assert.throws(() => parseAddress("localhost:9443"), /IP literal/);
  assert.deepEqual(parseAddress("[::1]:9443"), { host: "::1", port: 9443 });
});
