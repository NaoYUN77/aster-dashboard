// The sandbox arguments are a contract with the installed bubblewrap, not with a particular
// release: 0.11.1 sets PR_SET_NO_NEW_PRIVS itself and exits with "Unknown option" on flags it does
// not define. These cases pin the isolation flags that must be there and the ones that must not.

import assert from "node:assert/strict";
import test from "node:test";
import { buildBwrapArgv, buildDirectBwrapArgv } from "../src/execution/ptc-bwrap.js";
import { readPtcConfig } from "../src/execution/ptc-config.js";

const config = readPtcConfig({
  PTC_ENABLED: "1",
  PTC_CGROUP_ROOT: "/sys/fs/cgroup/system.slice/aster-rpc-agent.service/ptc",
});
if (config === undefined) throw new Error("PTC_ENABLED=1 must produce a config");

/** Flags shared by both sandboxes, in the order bwrap receives them. */
const ISOLATION = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-cgroup",
  "--unshare-net",
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
];

test("a job sandbox keeps every namespace, drops capabilities and does not bind the whole root", () => {
  const argv = buildBwrapArgv(config, "/srv/aster/jobs/ptc-1");

  assert.equal(argv[0], config.bwrapPath);
  assert.deepEqual(argv.slice(1, 1 + ISOLATION.length), ISOLATION);
  assert.ok(!argv.includes("--no-new-privs"), "bubblewrap enables no-new-privs itself; 0.11.1 rejects the flag");
  assert.ok(!argv.includes("--unshare-all"), "sharing must stay explicit");
  assert.deepEqual(
    argv.slice(argv.indexOf("--bind"), argv.indexOf("--bind") + 3),
    ["--bind", "/srv/aster/jobs/ptc-1", "/workspace"],
    "the workspace is the only writable persistent mount",
  );
  assert.ok(!argv.some((arg, index) => arg === "--bind" && argv[index + 1] === "/"),
    "a whole-root bind would expose the host");
  assert.ok(argv.includes("--clearenv"));
});

test("a direct sandbox isolates the command and hides the control plane's app root", () => {
  const argv = buildDirectBwrapArgv(
    config,
    { sharedPath: "/srv/shared", tmpPath: "/srv/tmp/session", cwd: "/shared" },
    { executor: "bash", command: "hostname", cwd: "/shared", env: {}, inheritEnv: false, timeoutMs: 1_000,
      window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 } },
  );

  assert.deepEqual(argv.slice(1, 1 + ISOLATION.length), ISOLATION);
  assert.ok(!argv.includes("--no-new-privs"));
  assert.ok(!argv.includes(config.appRoot), "a direct command needs no part of the control plane");
  // The command follows `--`; without it bwrap would read a leading `-` as its own option.
  assert.deepEqual(argv.slice(-4), ["--", "/bin/sh", "-c", "hostname"]);
});
