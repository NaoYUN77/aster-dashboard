import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ConfigurationError, readExecutionConfig } from "../src/config.js";
import { BrokerClient } from "../src/execution/broker-client.js";
import { startBrokerServer, type BrokerServer } from "../src/execution/broker.js";
import type { ExecRequest } from "../src/execution/protocol.js";
import { RemoteExecutionEnv } from "../src/execution/remote-env.js";
import { RunnerError, type CommandRunner } from "../src/execution/runner.js";

const EXECUTION_ID = "0000000000000001";

async function socketLocation(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (process.platform === "win32") {
    return { path: `\\\\.\\pipe\\aster-execution-env-${randomUUID()}`, cleanup: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "aster-execution-env-"));
  return { path: join(directory, "broker.sock"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function withEnvironment(
  runner: CommandRunner,
  body: (env: RemoteExecutionEnv, server: BrokerServer) => Promise<void>,
  options: { maxTimeoutSeconds?: number; defaultTimeoutSeconds?: number; maxConcurrent?: number } = {},
): Promise<void> {
  const location = await socketLocation();
  const server = await startBrokerServer({
    socketPath: location.path,
    executionId: EXECUTION_ID,
    runner,
    maxConcurrent: options.maxConcurrent ?? 4,
    maxOutputBytes: 4096,
    maxOutputLines: 100,
    requestTimeoutMs: 2000,
  });
  const client = new BrokerClient({ socketPath: location.path, connectTimeoutMs: 2000 });
  const env = new RemoteExecutionEnv({
    client,
    executionId: EXECUTION_ID,
    cwd: "/srv/work",
    defaultTimeoutSeconds: options.defaultTimeoutSeconds ?? 30,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
  });
  try {
    await body(env, server);
  } finally {
    client.abortAll();
    await server.close();
    await location.cleanup();
  }
}

test("remote execution config is opt-in and validated before startup", () => {
  assert.equal(readExecutionConfig({}), undefined);
  assert.equal(readExecutionConfig({ EXECUTION_MODE: "local" }), undefined);
  assert.throws(() => readExecutionConfig({ EXECUTION_MODE: "sideways" }), ConfigurationError);
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote", EXECUTION_REMOTE_TRANSPORT: "carrier-pigeon", EXECUTION_REMOTE_CWD: "/srv/work",
  }), (error) => error instanceof ConfigurationError && /EXECUTION_REMOTE_TRANSPORT/.test(error.message));

  // The cwd is shared by both transports, so it is required before either one's own settings.
  assert.throws(() => readExecutionConfig({ EXECUTION_MODE: "remote" }), (error) =>
    error instanceof ConfigurationError && /EXECUTION_REMOTE_CWD/.test(error.message));
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote", EXECUTION_REMOTE_CWD: "/srv/work",
  }), (error) => error instanceof ConfigurationError && /EXECUTION_BROKER_SOCKET/.test(error.message));
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote", EXECUTION_REMOTE_CWD: "srv/work", EXECUTION_BROKER_SOCKET: "/run/broker.sock",
  }), ConfigurationError);
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote", EXECUTION_REMOTE_CWD: "/srv/work\nx", EXECUTION_BROKER_SOCKET: "/run/broker.sock",
  }), ConfigurationError);
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote", EXECUTION_REMOTE_CWD: "/srv/work",
    EXECUTION_BROKER_SOCKET: "run/broker.sock",
  }), ConfigurationError);
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote", EXECUTION_REMOTE_CWD: "/srv/work",
    EXECUTION_BROKER_SOCKET: "/run/broker.sock",
    EXECUTION_DEFAULT_TIMEOUT_SECONDS: "120", EXECUTION_MAX_TIMEOUT_SECONDS: "60",
  }), (error) => error instanceof ConfigurationError && /DEFAULT_TIMEOUT/.test(error.message));

  // The rpc transport only exposes `/shared`, so its cwd must live there.
  assert.throws(() => readExecutionConfig({
    EXECUTION_MODE: "remote",
    EXECUTION_REMOTE_TRANSPORT: "rpc",
    EXECUTION_REMOTE_CWD: "/srv/work",
    EXECUTION_RPC_TRANSPORT: "unix",
    EXECUTION_RPC_SOCKET: "/run/aster/agent.sock",
  }), (error) => error instanceof ConfigurationError && /\/shared/.test(error.message));

  assert.deepEqual(readExecutionConfig({
    EXECUTION_MODE: "remote",
    EXECUTION_BROKER_SOCKET: "/run/execution/broker.sock",
    EXECUTION_REMOTE_CWD: "/srv/work",
  }), {
    transport: "ssh",
    brokerSocket: "/run/execution/broker.sock",
    remoteCwd: "/srv/work",
    connectTimeoutMs: 5000,
    defaultTimeoutSeconds: 300,
    maxTimeoutSeconds: 3600,
  });
  assert.deepEqual(readExecutionConfig({
    EXECUTION_MODE: "remote",
    EXECUTION_BROKER_SOCKET: "/run/execution/broker.sock",
    EXECUTION_REMOTE_CWD: "/srv/work",
    EXECUTION_BROKER_CONNECT_TIMEOUT_MS: "1000",
    EXECUTION_DEFAULT_TIMEOUT_SECONDS: "10",
    EXECUTION_MAX_TIMEOUT_SECONDS: "20",
  }), {
    transport: "ssh",
    brokerSocket: "/run/execution/broker.sock",
    remoteCwd: "/srv/work",
    connectTimeoutMs: 1000,
    defaultTimeoutSeconds: 10,
    maxTimeoutSeconds: 20,
  });
  assert.deepEqual(readExecutionConfig({
    EXECUTION_MODE: "remote",
    EXECUTION_REMOTE_TRANSPORT: "rpc",
    EXECUTION_REMOTE_CWD: "/shared/project",
    EXECUTION_RPC_TRANSPORT: "unix",
    EXECUTION_RPC_SOCKET: "/run/aster/agent.sock",
  }), {
    transport: "rpc",
    remoteCwd: "/shared/project",
    rpc: {
      transport: "unix",
      socketPath: "/run/aster/agent.sock",
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxFrameBytes: 4 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
    },
    defaultTimeoutSeconds: 300,
    maxTimeoutSeconds: 3600,
  });
  // Selecting rpc never leaves the broker settings in effect.
  const rpcOnly = readExecutionConfig({
    EXECUTION_MODE: "remote",
    EXECUTION_REMOTE_TRANSPORT: "rpc",
    EXECUTION_REMOTE_CWD: "/shared",
    EXECUTION_RPC_TRANSPORT: "unix",
    EXECUTION_RPC_SOCKET: "/run/aster/agent.sock",
    EXECUTION_BROKER_SOCKET: "/run/execution/broker.sock",
  });
  assert.equal(rpcOnly?.transport, "rpc");
  assert.equal(Object.hasOwn(rpcOnly ?? {}, "brokerSocket"), false);
});

test("remote env forwards command, cwd, env and timeout to the broker", async () => {
  const captured: { request?: ExecRequest } = {};
  await withEnvironment(async (request, sink) => {
    captured.request = request;
    sink.stdout("out\n");
    sink.stderr("err\n");
    return { exitCode: 3 };
  }, async (env) => {
    const output: string[] = [];
    const result = await env.exec(["printf", "%s", "a b"], {
      cwd: "nested",
      env: { LANG: "C.UTF-8" },
      inheritEnv: false,
      timeout: 12.4,
      onOutput: (text, _context, info) => output.push(`${info.stream}:${text}`),
    }, BACKGROUND_CONTEXT);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.exitCode, 3);
    assert.deepEqual(output, ["stdout:out\n", "stderr:err\n"]);
  });

  // The broker receives the validated request after the client has finished.
  assert.equal(captured.request?.command.length, 3);
  assert.equal(captured.request?.cwd, "/srv/work/nested");
  assert.deepEqual(captured.request?.env, { LANG: "C.UTF-8" });
  assert.equal(captured.request?.inheritEnv, false);
  assert.equal(captured.request?.timeoutSeconds, 13);
});

test("remote env resolves absolute cwd and applies the default timeout", async () => {
  const captured: { request?: ExecRequest } = {};
  await withEnvironment(async (request) => {
    captured.request = request;
    return { exitCode: 0 };
  }, async (env) => {
    const result = await env.exec("pwd", { cwd: "/var/tmp/../work" }, BACKGROUND_CONTEXT);
    assert.equal(result.ok, true);
  });
  assert.equal(captured.request?.cwd, "/var/work");
  assert.equal(captured.request?.timeoutSeconds, 30);
  assert.equal(captured.request?.inheritEnv, true);
});

test("remote env rejects an over-limit timeout without contacting the broker", async () => {
  let contacted = false;
  await withEnvironment(async () => {
    contacted = true;
    return { exitCode: 0 };
  }, async (env) => {
    const result = await env.exec("sleep 1", { timeout: 61 }, BACKGROUND_CONTEXT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "timeout");
  }, { maxTimeoutSeconds: 60 });
  assert.equal(contacted, false);
});

test("remote env maps broker failures to execution errors", async () => {
  await withEnvironment(async () => {
    throw new RunnerError("spawn_error", "SSH client could not start");
  }, async (env) => {
    const result = await env.exec("true", undefined, BACKGROUND_CONTEXT);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "spawn_error");
      assert.match(result.error.message, /SSH client/);
    }
  });
});

test("remote env cancellation reaches the broker and the runner", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  await withEnvironment(async (_request, _sink, signal) => {
    started();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    throw new RunnerError("aborted", "Command aborted");
  }, async (env) => {
    const controller = new AbortController();
    const pending = env.exec("sleep 60", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    await running;
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "aborted");
    for (let index = 0; index < 20 && !aborted; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(aborted, true);
  });
});

test("remote env fails closed for filesystem tools", async () => {
  await withEnvironment(async () => ({ exitCode: 0 }), async (env) => {
    const operations = [
      env.readTextFile("/srv/work/a", BACKGROUND_CONTEXT),
      env.readTextLines("/srv/work/a", undefined, BACKGROUND_CONTEXT),
      env.readBinaryFile("/srv/work/a", BACKGROUND_CONTEXT),
      env.writeFile("/srv/work/a", "x", BACKGROUND_CONTEXT),
      env.appendFile("/srv/work/a", "x", BACKGROUND_CONTEXT),
      env.fileInfo("/srv/work/a", BACKGROUND_CONTEXT),
      env.listDir("/srv/work", BACKGROUND_CONTEXT),
      env.listFiles("/srv/work", undefined, BACKGROUND_CONTEXT),
      env.exists("/srv/work/a", BACKGROUND_CONTEXT),
      env.createDir("/srv/work/d", undefined, BACKGROUND_CONTEXT),
      env.remove("/srv/work/a", undefined, BACKGROUND_CONTEXT),
      env.createTempDir(undefined, BACKGROUND_CONTEXT),
      env.createTempFile(undefined, BACKGROUND_CONTEXT),
      env.canonicalPath("/srv/work/a", BACKGROUND_CONTEXT),
      env.renameFile("/srv/work/a", "/srv/work/b", BACKGROUND_CONTEXT),
      env.watch([{ path: "/srv/work" }], () => {}, BACKGROUND_CONTEXT),
      env.openTextLineReader("/srv/work/a", BACKGROUND_CONTEXT),
      env.openBinaryReader("/srv/work/a", undefined, BACKGROUND_CONTEXT),
      env.openDirReader("/srv/work", BACKGROUND_CONTEXT),
    ] as const;
    for (const pending of operations) {
      const result = await pending;
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "not_supported");
        assert.match(result.error.message, /phase 1 runs commands only/);
      }
    }
  });
});

test("remote env resolves paths against the execution host's cwd", async () => {
  await withEnvironment(async () => ({ exitCode: 0 }), async (env) => {
    const relative = await env.absolutePath("a/../b", BACKGROUND_CONTEXT);
    assert.deepEqual(relative, { ok: true, value: "/srv/work/b" });
    const absolute = await env.absolutePath("/var/tmp/./x", BACKGROUND_CONTEXT);
    assert.deepEqual(absolute, { ok: true, value: "/var/tmp/x" });
    const home = await env.absolutePath("~/secret", BACKGROUND_CONTEXT);
    assert.equal(home.ok, false);
    if (!home.ok) assert.equal(home.error.code, "invalid");
    const nul = await env.absolutePath("/srv/\0x", BACKGROUND_CONTEXT);
    assert.equal(nul.ok, false);

    const joined = await env.joinPath(["/srv/work", "a", "..", "b"], BACKGROUND_CONTEXT);
    assert.deepEqual(joined, { ok: true, value: "/srv/work/b" });
    const joinedNul = await env.joinPath(["/srv/work", "a\0b"], BACKGROUND_CONTEXT);
    assert.equal(joinedNul.ok, false);
  });
});

test("remote env reports an unavailable broker instead of running locally", async () => {
  const location = await socketLocation();
  const client = new BrokerClient({ socketPath: location.path, connectTimeoutMs: 500 });
  const env = new RemoteExecutionEnv({
    client,
    executionId: EXECUTION_ID,
    cwd: "/srv/work",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60,
  });
  try {
    const result = await env.exec("true", undefined, BACKGROUND_CONTEXT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "unknown");
  } finally {
    client.abortAll();
    await location.cleanup();
  }
});
