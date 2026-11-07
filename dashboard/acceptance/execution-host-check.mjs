// Shared-host acceptance: speak the deployment's own RPC protocol over the shared Unix socket,
// with no model in the loop. Run it inside the application image:
//
//   docker run --rm --network none --user 1000:1000 \
//     --mount type=volume,source=<runtime volume>,target=/run/aster,readonly \
//     --mount type=bind,source=./dashboard/acceptance/execution-host-check.mjs,target=/check.mjs,readonly \
//     --entrypoint node <app image> /check.mjs
//
// This is the deterministic half of acceptance 4/5/7: it proves the Phase 1 shared-host boundaries
// even when the model happens to answer differently from its instructions. One non-root Execution
// Host serves every bot; there is no per-bot container and no OS-level isolation in this MVP.
import { readRpcClientConfig } from "/app/dist/src/execution/rpc-config.js";
import { connectRpcClient } from "/app/dist/src/execution/rpc-connect.js";

const window = { maxBytes: 256 * 1024, maxLines: 2000, minIntervalMs: 0, bytesPerSecond: 4 * 1024 * 1024 };
const stamp = Date.now().toString(36);
const sessionA = `acc-a-${stamp}`;
const sessionB = `acc-b-${stamp}`;
const cwdA = `/workspaces/bot-a-${stamp}`;
const cwdB = `/workspaces/bot-b-${stamp}`;
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.info(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

const client = await connectRpcClient(readRpcClientConfig());

function run(sessionId, command, cwd, timeoutMs = 60_000) {
  const chunks = [];
  const handle = client.startBashExecute(sessionId, {
    executor: "bash", command, cwd, env: {}, inheritEnv: false, timeoutMs, window,
  }, { onOutput: (event) => chunks.push(event.text) });
  return {
    handle,
    promise: handle.result.then(
      (value) => ({ exitCode: value.exitCode, durationMs: value.durationMs, output: chunks.join("") }),
      (error) => ({ error: error?.code ?? "failed", outcome: error?.options?.outcome, message: error?.message ?? "", output: chunks.join("") }),
    ),
  };
}

try {
  const health = await client.health();
  check("S1 the shared host RPC protocol is reachable", health !== undefined,
    `directBash ${health.directBash === true}, fileTools ${health.fileTools === true}, sharedMode ${health.sharedMode ?? "?"}, ptc ${health.ptc === true}`);
  check("S1 Phase 1 advertises Bash and file primitives on one shared host",
    health.directBash === true && health.fileTools === true
      && health.sharedMode === "rw" && health.ptc === false && health.testExecutor === false);

  await client.openSession(sessionA, { cwd: cwdA });
  await client.openSession(sessionB, { cwd: cwdB });

  const aWrite = await run(sessionA, "printf 'hello-from-A' > a.txt && pwd && ls -a", cwdA).promise;
  check("S4 A writes a file inside its own default directory",
    aWrite.exitCode === 0 && aWrite.output.includes(cwdA) && aWrite.output.includes("a.txt"),
    JSON.stringify(aWrite).slice(0, 200));

  const bList = await run(sessionB, "pwd && ls -a", cwdB).promise;
  check("S4 B's own default directory does not contain A's file",
    bList.exitCode === 0 && bList.output.includes(cwdB) && !bList.output.includes("a.txt"),
    JSON.stringify(bList).slice(0, 200));

  const read = await client.fileRequest(sessionA, "file.readText", { path: `${cwdA}/a.txt` })
    .then((value) => ({ value }), (error) => ({ error }));
  // The protocol carries file content as base64 (write takes contentBase64); decode before asserting.
  const readText = read.value?.data === undefined
    ? ""
    : Buffer.from(String(read.value.data), "base64").toString("utf8");
  check("S4 the file primitive reads the session's own file",
    readText === "hello-from-A",
    JSON.stringify(read).slice(0, 160));

  const escape = await client.fileRequest(sessionA, "file.readText", { path: `${cwdA}/../bot-b-${stamp}/b.txt` })
    .then(() => undefined, (error) => error);
  check("S4 the file primitive rejects paths that leave the session root",
    escape?.code === "permission_denied", escape?.code ?? "no error");

  const appData = await client.fileRequest(sessionB, "file.readText", { path: "/data/inbox.sqlite" })
    .then(() => undefined, (error) => error);
  check("S4 the file primitive cannot reach /data",
    appData?.code === "permission_denied", appData?.code ?? "no error");

  // The base image declares VOLUME /data, so an empty /data exists in the execution host; what
  // matters is that no application data is mounted there.
  const data = await run(sessionB, "ls -A /data", cwdB).promise;
  check("S4 /data carries no app data inside the execution host",
    data.exitCode !== 0 || data.output.trim() === "",
    `exit ${data.exitCode}${data.output.trim() === "" ? "" : ` entries: ${data.output.trim()}`}`);

  // Informational: by design raw bash shares the host and can list sibling bot directories. This
  // is the accepted single-user MVP boundary, not a per-bot isolation failure.
  const siblings = await run(sessionB, "ls /workspaces", cwdB).promise;
  if (siblings.exitCode === 0 && siblings.output.includes(`bot-a-${stamp}`)) {
    console.info("NOTE raw bash can list sibling bot directories; the shared host provides no OS-level isolation by design");
  }

  // Acceptance 5: the deployment-wide bound is the execution host's concurrency (3).
  const started = Date.now();
  const [sleepA, sleepB] = [
    run(sessionA, "sleep 30; echo SLEPT-A", cwdA, 90_000).promise,
    run(sessionB, "sleep 30; echo SLEPT-B", cwdB, 90_000).promise,
  ];
  const slept = await Promise.all([sleepA, sleepB]);
  const elapsed = Date.now() - started;
  check("S5 two 30s commands run in parallel",
    slept.every((result) => result.exitCode === 0) && elapsed < 48_000,
    `${Math.round(elapsed / 1000)}s (serial would be ~60s)`);

  // Acceptance 7: cancelling one session's command does not touch the other session.
  const cancelledRun = run(sessionA, "sleep 30; echo NEVER", cwdA, 90_000);
  const quickRun = run(sessionB, "sleep 2; echo B-OK", cwdB, 90_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cancelStarted = Date.now();
  await cancelledRun.handle.cancel("acceptance cancel");
  const cancelled = await cancelledRun.promise;
  const cancelMs = Date.now() - cancelStarted;
  check("S7 cancel stops the command promptly",
    cancelled.error !== undefined && cancelMs < 10_000,
    `${cancelled.error ?? "no error"} in ${cancelMs}ms`);
  const quick = await quickRun.promise;
  check("S7 the other session keeps running",
    quick.exitCode === 0 && quick.output.includes("B-OK"),
    JSON.stringify(quick).slice(0, 160));

  await client.closeSession(sessionA);
  await client.closeSession(sessionB);
  const failed = results.filter((result) => !result.ok);
  console.info(JSON.stringify({ status: failed.length === 0 ? "ok" : "failed", checks: results }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  check("shared-host acceptance completed", false, error instanceof Error ? error.message : String(error));
  console.info(JSON.stringify({ status: "failed", checks: results }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
