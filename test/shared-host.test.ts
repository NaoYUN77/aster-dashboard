// Phase 1 shared Computer / Execution Host: one host, one non-root execution user, per-bot default
// working directories, no OS-level isolation. These tests cover the host's config guard, its root
// check, and the full RPC loopback path for Bash / Read / Write / Edit over direct sessions.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigurationError } from "../src/errors.js";
import { DirectHostError } from "../src/execution/direct-host.js";
import { RpcClientError, RpcExecutionClient } from "../src/execution/rpc-client.js";
import { startRpcAgent } from "../src/execution/rpc-server.js";
import { listenUnixRpc, unixRpcTransport } from "../src/execution/rpc-transport.js";
import {
  assertNotRoot, describeSharedHostConfig, readSharedHostConfig, SharedHostDirectHost,
} from "../src/execution/shared-host.js";

const BASE_ENV = {
  EXECUTION_AGENT_SHARED_HOST: "1",
  EXECUTION_AGENT_WORKSPACES: "/workspaces",
  EXECUTION_AGENT_TMP_ROOT: "/tmp/aster-sessions",
  EXECUTION_AGENT_SHELL: "/bin/bash",
};

test("shared host mode is opt-in and validates every host-owned path", () => {
  assert.equal(readSharedHostConfig({}), undefined);
  assert.equal(readSharedHostConfig({ EXECUTION_AGENT_SHARED_HOST: "0" }), undefined);
  const config = readSharedHostConfig(BASE_ENV);
  assert.deepEqual(config, {
    workspacesRoot: "/workspaces",
    tmpRoot: "/tmp/aster-sessions",
    path: "/usr/local/bin:/usr/bin:/bin",
    shellPath: "/bin/bash",
    outputChunkBytes: 32 * 1024,
    outputBytesPerSecond: 0,
  });
  assert.equal(describeSharedHostConfig(config!).mode, "shared-host");
  assert.equal(describeSharedHostConfig(config!).workspacesRoot, "/workspaces");
  for (const env of [
    { ...BASE_ENV, EXECUTION_AGENT_SHARED_HOST: "yes" },
    { ...BASE_ENV, EXECUTION_AGENT_WORKSPACES: "" },
    { ...BASE_ENV, EXECUTION_AGENT_WORKSPACES: "relative/path" },
    { ...BASE_ENV, EXECUTION_AGENT_TMP_ROOT: "/tmp/../escape" },
    { ...BASE_ENV, EXECUTION_AGENT_SHELL: "" },
    { ...BASE_ENV, EXECUTION_AGENT_OUTPUT_CHUNK_BYTES: "not-a-number" },
    { ...BASE_ENV, EXECUTION_AGENT_OUTPUT_CHUNK_BYTES: "99999999" },
  ]) {
    assert.throws(() => readSharedHostConfig(env), ConfigurationError, JSON.stringify(env));
  }
  assert.equal(
    readSharedHostConfig({ ...BASE_ENV, EXECUTION_AGENT_PATH: "/opt/bin" })!.path,
    "/opt/bin",
  );
});

test("the execution service refuses to run as root and accepts a dedicated uid", () => {
  assert.throws(() => assertNotRoot(() => 0), /must not run as root/);
  assert.doesNotThrow(() => assertNotRoot(() => 1000));
  // Windows has no getuid; the check must not break a non-POSIX host.
  assert.doesNotThrow(() => assertNotRoot(() => undefined));
});

test("shared host serves Bash / Read / Write / Edit over direct RPC sessions", {
  skip: process.platform === "win32" ? "Unix domain sockets and POSIX paths are exercised on POSIX CI" : false,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-shared-"));
  const workspaces = join(directory, "workspaces");
  const tmpRoot = join(directory, "sessions");
  await mkdir(workspaces, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });
  const socketPath = join(directory, "agent.sock");
  const direct = new SharedHostDirectHost({
    workspacesRoot: workspaces,
    tmpRoot,
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    shellPath: "/bin/bash",
    outputChunkBytes: 32 * 1024,
    outputBytesPerSecond: 0,
  });
  const server = await listenUnixRpc(socketPath);
  const agent = startRpcAgent({
    server,
    executionId: "aabbccdd11223344",
    transport: "unix",
    heartbeatMs: 60_000,
    sessionTtlMs: 60_000,
    testExecutorEnabled: false,
    direct,
  });
  const client = new RpcExecutionClient({
    transport: unixRpcTransport(socketPath),
    requestTimeoutMs: 10_000,
  });
  const window = { maxBytes: 64 * 1024, maxLines: 1_000, minIntervalMs: 0, bytesPerSecond: 0 };
  const cwdA = join(workspaces, "bot-a");
  const cwdB = join(workspaces, "bot-b");
  try {
    await client.connect();
    const health = await client.health();
    assert.equal(health.directBash, true);
    assert.equal(health.fileTools, true);
    assert.equal(health.sharedMode, "rw");
    assert.equal(health.ptc, false, "Phase 1 does not migrate codemode");
    assert.equal(health.testExecutor, false);

    await client.openSession("bot-a", { cwd: cwdA });
    await client.openSession("bot-b", { cwd: cwdB });
    assert.equal((await client.openSession("bot-c", { cwd: cwdB })).sessionId, "bot-c");
    await client.closeSession("bot-c");

    // Bash writes into bot A's own default working directory.
    const output: string[] = [];
    const run = client.startBashExecute("bot-a", {
      executor: "bash", command: "pwd && printf 'from-bash' > note.txt",
      cwd: cwdA, env: {}, inheritEnv: false, timeoutMs: 10_000, window,
    }, { deadlineMs: 15_000, onOutput: (event) => output.push(event.text) });
    assert.equal((await run.result).exitCode, 0);
    assert.ok(output.join("").includes(cwdA), "bash ran in bot A's directory");

    // Write / Edit primitives and Read both work over the same session.
    await client.fileRequest("bot-a", "file.write", {
      path: join(cwdA, "written.txt"), content: Buffer.from("from-write").toString("base64"),
    });
    const note = await client.fileRequest("bot-a", "file.readText", { path: join(cwdA, "note.txt") }) as { data: string };
    assert.equal(Buffer.from(note.data, "base64").toString("utf8"), "from-bash");
    const written = await client.fileRequest("bot-a", "file.readText", { path: join(cwdA, "written.txt") }) as { data: string };
    assert.equal(Buffer.from(written.data, "base64").toString("utf8"), "from-write");

    // Bot B keeps its own default directory. Raw bash can still see sibling files (shared host),
    // but each bot's session root and the file primitives remain confined.
    const bOutput: string[] = [];
    const bRun = client.startBashExecute("bot-b", {
      executor: "bash", command: "pwd && ls -a", cwd: cwdB,
      env: {}, inheritEnv: false, timeoutMs: 10_000, window,
    }, { deadlineMs: 15_000, onOutput: (event) => bOutput.push(event.text) });
    assert.equal((await bRun.result).exitCode, 0);
    assert.ok(bOutput.join("").includes(cwdB));
    assert.ok(!bOutput.join("").includes("note.txt"));

    // A file primitive cannot escape the session root.
    await assert.rejects(
      client.fileRequest("bot-a", "file.readText", { path: "/etc/passwd" }),
      (error: unknown) => error instanceof RpcClientError,
    );
    const onDisk = await readFile(join(cwdA, "note.txt"), "utf8");
    assert.equal(onDisk, "from-bash");

    // Timeout reaches the real command and kills its process group; the result stays a failure.
    const slow = client.startBashExecute("bot-b", {
      executor: "bash", command: "sleep 5", cwd: cwdB,
      env: {}, inheritEnv: false, timeoutMs: 250, window,
    }, { deadlineMs: 5_000 });
    await slow.result.then(
      () => assert.fail("a timed out command must not report success"),
      (error: unknown) => assert.ok(error instanceof RpcClientError && error.code === "timeout"),
    );

    await client.closeSession("bot-a");
    await client.closeSession("bot-b");
  } finally {
    await client.close();
    await agent.close();
    await direct.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shared host owns its runtime environment and rejects host-owned wire variables", {
  skip: process.platform === "win32" ? "POSIX paths and /bin/bash are exercised on POSIX CI" : false,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-shared-env-"));
  const workspaces = join(directory, "workspaces");
  const tmpRoot = join(directory, "sessions");
  await mkdir(workspaces, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });
  const cwd = join(workspaces, "bot-a");
  const hostPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const direct = new SharedHostDirectHost({
    workspacesRoot: workspaces,
    tmpRoot,
    path: hostPath,
    shellPath: "/bin/bash",
    outputChunkBytes: 32 * 1024,
    outputBytesPerSecond: 0,
  });
  const window = { maxBytes: 64 * 1024, maxLines: 1_000, minIntervalMs: 0, bytesPerSecond: 0 };
  const signal = new AbortController().signal;
  try {
    await direct.openSession("bot-a", cwd);

    // A task-intent variable passes through; every host-owned value stays fixed by the host.
    const output: string[] = [];
    const result = await direct.execute({
      sessionId: "bot-a",
      payload: {
        executor: "bash",
        command: "printf 'PATH=%s HOME=%s TMPDIR=%s LANG=%s PTC=%s TASK=%s' "
          + '"$PATH" "$HOME" "$TMPDIR" "$LANG" "$PTC_INSIDE_SANDBOX" "$PHASE1_TASK"',
        cwd,
        env: { PHASE1_TASK: "kept" },
        inheritEnv: true,
        timeoutMs: 10_000,
        window,
      },
      signal,
      emit: (_seq, _stream, text) => output.push(text),
    });
    assert.equal(result.exitCode, 0);
    const text = output.join("");
    assert.ok(text.includes(`PATH=${hostPath}`), `PATH was overridden: ${text}`);
    assert.ok(text.includes(`HOME=${cwd}`), `HOME was overridden: ${text}`);
    assert.ok(text.includes("TMPDIR=/tmp"), `TMPDIR was overridden: ${text}`);
    assert.ok(text.includes("LANG=C.UTF-8"), `LANG was overridden: ${text}`);
    assert.ok(text.includes("PTC=1"), `PTC_INSIDE_SANDBOX was overridden: ${text}`);
    assert.ok(text.includes("TASK=kept"), `task variable was lost: ${text}`);

    // The wire explicitly tries to override host-owned values; the request is invalid and never runs.
    await assert.rejects(
      direct.execute({
        sessionId: "bot-a",
        payload: {
          executor: "bash", command: "printf 'should-not-run'", cwd,
          env: {
            PATH: "/nonexistent", HOME: "/etc", TMPDIR: "/etc", LANG: "C", PTC_INSIDE_SANDBOX: "0",
          },
          inheritEnv: true, timeoutMs: 10_000, window,
        },
        signal,
        emit: () => undefined,
      }),
      (error: unknown) => error instanceof DirectHostError
        && error.code === "invalid_request"
        && error.outcome === "not_started"
        && error.message.includes("PATH") && error.message.includes("PTC_INSIDE_SANDBOX"),
    );
    assert.ok(!output.join("").includes("should-not-run"), "an invalid request must not execute");
  } finally {
    await direct.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
