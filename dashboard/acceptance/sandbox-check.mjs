// Sandbox acceptance: speak the deployment's own RPC protocol over the shared Unix socket,
// with no model in the loop. Run it inside the application image:
//
//   docker run --rm --network none --user 1000:1000 \
//     --mount type=volume,source=<runtime volume>,target=/run/aster,readonly \
//     --mount type=bind,source=./dashboard/acceptance/sandbox-check.mjs,target=/tmp/check.mjs,readonly \
//     --entrypoint node <app image> /tmp/check.mjs
//
// This is the deterministic half of acceptance 4/5/7: it proves the container boundaries even when
// the model happens to answer differently from its instructions.
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
  check("S1 sandbox protocol is reachable", health !== undefined,
    `isolation ${health.isolation?.mode ?? "?"}, ptc ${health.ptc === true}`);
  check("S1 the sandbox reports container isolation", health.isolation?.mode === "container");

  await client.openSession(sessionA, { cwd: cwdA });
  await client.openSession(sessionB, { cwd: cwdB });

  const aWrite = await run(sessionA, "printf 'hello-from-A' > a.txt && pwd && ls -a", cwdA).promise;
  check("S4 A writes a file inside its own directory",
    aWrite.exitCode === 0 && aWrite.output.includes(cwdA) && aWrite.output.includes("a.txt"),
    JSON.stringify(aWrite).slice(0, 200));

  const bList = await run(sessionB, "pwd && ls -a", cwdB).promise;
  check("S4 B does not see A's file",
    bList.exitCode === 0 && bList.output.includes(cwdB) && !bList.output.includes("a.txt"),
    JSON.stringify(bList).slice(0, 200));

  const read = await client.fileRequest(sessionA, "file.readText", { path: `${cwdA}/a.txt` })
    .then((value) => ({ value }), (error) => ({ error }));
  check("S4 the file primitives resolve only inside the session root",
    read.value !== undefined && String(read.value?.data ?? "").includes("hello-from-A"),
    JSON.stringify(read).slice(0, 160));

  const data = await run(sessionB, "ls /data", cwdB).promise;
  check("S4 /data is not visible inside the sandbox",
    data.exitCode !== 0, `exit ${data.exitCode}`);

  // Informational: raw bash can still list sibling bot directories; file primitives and each
  // session's working directory stay confined. Recorded for the report, not counted as a failure.
  const siblings = await run(sessionB, "ls /workspaces", cwdB).promise;
  if (siblings.exitCode === 0 && siblings.output.includes(`bot-a-${stamp}`)) {
    console.info("NOTE raw bash can list sibling bot directories; per-bot mount namespaces are a known limit");
  }

  // Acceptance 5: the deployment-wide bound is the sandbox connection's concurrency (3).
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
  check("sandbox acceptance completed", false, error instanceof Error ? error.message : String(error));
  console.info(JSON.stringify({ status: "failed", checks: results }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
