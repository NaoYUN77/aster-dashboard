import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BrokerClient, BrokerClientError } from "../src/execution/broker-client.js";
import { startBrokerServer, type BrokerServer } from "../src/execution/broker.js";
import type { SshConfig } from "../src/execution/broker-config.js";
import { parseBrokerFrame, type ExecRequest } from "../src/execution/protocol.js";
import { RunnerError, type CommandRunner } from "../src/execution/runner.js";
import { buildRemoteCommand, buildRemoteScript, buildSshArgv } from "../src/execution/ssh.js";

const EXECUTION_ID = "0000000000000001";

function request(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    v: 1,
    type: "exec",
    id: "call-1",
    command: "echo hello",
    cwd: "/srv/work",
    env: {},
    inheritEnv: true,
    timeoutSeconds: 30,
    ...overrides,
  };
}

async function socketLocation(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (process.platform === "win32") {
    return { path: `\\\\.\\pipe\\aster-execution-${randomUUID()}`, cleanup: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "aster-execution-broker-"));
  return { path: join(directory, "broker.sock"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function start(
  runner: CommandRunner,
  overrides: Partial<Parameters<typeof startBrokerServer>[0]> = {},
): Promise<{ server: BrokerServer; socketPath: string; cleanup: () => Promise<void> }> {
  const location = await socketLocation();
  const server = await startBrokerServer({
    socketPath: location.path,
    executionId: EXECUTION_ID,
    runner,
    maxConcurrent: 4,
    maxOutputBytes: 4096,
    maxOutputLines: 100,
    requestTimeoutMs: 2000,
    ...overrides,
  });
  return {
    server,
    socketPath: location.path,
    cleanup: async () => {
      await server.close();
      await location.cleanup();
    },
  };
}

function rawRequest(socketPath: string, payload: string): Promise<ReturnType<typeof parseBrokerFrame>[]> {
  return new Promise((resolve, reject) => {
    const frames: ReturnType<typeof parseBrokerFrame>[] = [];
    const socket = connect({ path: socketPath });
    let buffer = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(frames);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        frames.push(parseBrokerFrame(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });
}

test("broker answers ping with its execution identity", async () => {
  const broker = await start(async () => ({ exitCode: 0 }));
  try {
    const client = new BrokerClient({ socketPath: broker.socketPath, connectTimeoutMs: 2000 });
    const pong = await client.ping();
    assert.equal(pong.protocol, 1);
    assert.equal(pong.executionId, EXECUTION_ID);
  } finally {
    await broker.cleanup();
  }
});

test("broker streams stdout and stderr and returns the exit code", async () => {
  const broker = await start(async (request, sink) => {
    assert.equal(request.cwd, "/srv/work");
    sink.stdout("out");
    sink.stderr("err");
    return { exitCode: 7 };
  });
  try {
    const client = new BrokerClient({ socketPath: broker.socketPath, connectTimeoutMs: 2000 });
    const output: string[] = [];
    const exit = await client.exec(request(), {
      onOutput: (frame) => output.push(`${frame.stream}:${frame.text}`),
    });
    assert.equal(exit.exitCode, 7);
    assert.deepEqual(output, ["stdout:out", "stderr:err"]);
  } finally {
    await broker.cleanup();
  }
});

test("broker maps runner failures to typed error frames", async () => {
  const broker = await start(async () => {
    throw new RunnerError("spawn_error", "SSH client could not start");
  });
  try {
    const client = new BrokerClient({ socketPath: broker.socketPath, connectTimeoutMs: 2000 });
    await assert.rejects(client.exec(request()), (error) =>
      error instanceof BrokerClientError && error.code === "spawn_error");
  } finally {
    await broker.cleanup();
  }
});

test("broker limits concurrent executions", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const broker = await start(async () => {
    started();
    await gate;
    return { exitCode: 0 };
  }, { maxConcurrent: 1 });
  try {
    const client = new BrokerClient({ socketPath: broker.socketPath, connectTimeoutMs: 2000 });
    const first = client.exec(request({ id: "first" }));
    await running;
    await assert.rejects(client.exec(request({ id: "second" })), (error) =>
      error instanceof BrokerClientError && error.code === "busy");
    release();
    assert.equal((await first).exitCode, 0);
  } finally {
    await broker.cleanup();
  }
});

test("a disconnected client cancels the running command", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const broker = await start(async (_request, _sink, signal) => {
    started();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    throw new RunnerError("aborted", "Command aborted");
  });
  try {
    const client = new BrokerClient({ socketPath: broker.socketPath, connectTimeoutMs: 2000 });
    const controller = new AbortController();
    const pending = client.exec(request(), { signal: controller.signal });
    await running;
    controller.abort();
    await assert.rejects(pending, (error) =>
      error instanceof BrokerClientError && error.code === "aborted");
    for (let index = 0; index < 20 && !aborted; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(aborted, true);
  } finally {
    await broker.cleanup();
  }
});

test("broker rejects malformed requests without executing anything", async () => {
  let executed = false;
  const broker = await start(async () => { executed = true; return { exitCode: 0 }; });
  try {
    const frames = await rawRequest(broker.socketPath, `${JSON.stringify({ v: 1, type: "exec", id: "x" })}\n`);
    assert.equal(frames.length, 1);
    const frame = frames[0];
    assert.ok(frame?.ok);
    assert.equal(frame.value.type, "error");
    assert.equal(frame.value.type === "error" ? frame.value.code : undefined, "invalid_request");
    assert.equal(executed, false);
  } finally {
    await broker.cleanup();
  }
});

test("SSH argv fixes the target and host-key policy", () => {
  const ssh: SshConfig = {
    binary: "ssh",
    host: "EXECUTION_HOST",
    user: "aster",
    port: 2222,
    keyPath: "/run/aster/ssh/id_execution",
    knownHostsPath: "/run/aster/ssh/known_hosts",
    connectTimeoutSeconds: 7,
  };
  const argv = buildSshArgv(ssh, "true");
  assert.deepEqual(argv.slice(0, 5), ["ssh", "-T", "-o", "BatchMode=yes", "-o"]);
  assert.ok(argv.includes("StrictHostKeyChecking=yes"));
  assert.ok(argv.includes("ConnectTimeout=7"));
  assert.ok(argv.includes("ClearAllForwardings=yes"));
  assert.ok(argv.includes("RequestTTY=no"));
  assert.deepEqual(argv.slice(argv.indexOf("-F"), argv.indexOf("-F") + 2), ["-F", "/dev/null"]);
  assert.ok(argv.includes("UserKnownHostsFile=/run/aster/ssh/known_hosts"));
  assert.ok(argv.includes("IdentitiesOnly=yes"));
  assert.deepEqual(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2), ["-i", "/run/aster/ssh/id_execution"]);
  assert.deepEqual(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2), ["-p", "2222"]);
  assert.equal(argv.at(-2), "aster@EXECUTION_HOST");
  assert.equal(argv.at(-1), "true");
  const withoutKey = buildSshArgv({ ...ssh, keyPath: undefined }, "true");
  assert.ok(!withoutKey.includes("IdentitiesOnly=yes"));
  assert.ok(withoutKey.includes("/dev/null"));
});

test("remote script quotes cwd, env and argv without re-parsing", () => {
  const script = buildRemoteScript(request({
    cwd: "/srv/work/it's here",
    env: { A: "1", B: "two words" },
    command: "printf '%s' \"$A\"",
  }));
  assert.equal(script,
    "cd -- '/srv/work/it'\\''s here' || exit 125\n" +
    "export A='1'\n" +
    "export B='two words'\n" +
    "printf '%s' \"$A\"\n");
  const argv = buildRemoteScript(request({ command: ["printf", "%s", "a b"] }));
  assert.ok(argv.endsWith("exec 'printf' '%s' 'a b'\n"));
  const clean = buildRemoteScript(request({ inheritEnv: false, env: { A: "1" }, command: "env" }));
  assert.ok(clean.endsWith("env -i A='1' /bin/sh -c 'env'\n"));
  const cleanArgv = buildRemoteScript(request({ inheritEnv: false, env: {}, command: ["/bin/true", "x"] }));
  assert.ok(cleanArgv.endsWith("exec env -i '/bin/true' 'x'\n"));
});

test("remote command carries the script base64 and bounds it with timeout", () => {
  const source = request({ timeoutSeconds: 42, cwd: "/srv/work" });
  const command = buildRemoteCommand(source);
  assert.match(command, /^timeout --kill-after=5s 42s \/bin\/sh -c "\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 -d\)"$/);
  const encoded = command.slice(command.indexOf("printf %s '") + 11, command.indexOf("' | base64 -d"));
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), buildRemoteScript(source));
});
