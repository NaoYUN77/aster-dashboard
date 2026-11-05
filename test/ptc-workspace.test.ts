import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PtcConfig } from "../src/execution/ptc-config.js";
import { PtcHostError } from "../src/execution/ptc-host.js";
import { jobWorkspacePath, preparePtcWorkspace } from "../src/execution/ptc-workspace.js";

const JOB_ID = `ptc-${"a".repeat(32)}`;

async function config(t: { after(fn: () => Promise<void>): void }): Promise<PtcConfig> {
  const root = await mkdtemp(join(tmpdir(), "aster-workspace-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return {
    workspaceRoot: root,
    sharedWorkspace: undefined,
    sharedWorkspaceMode: "none",
    directEnabled: false,
    directTmpRoot: join(root, "direct"),
    cgroupRoot: "/sys/fs/cgroup/aster-ptc",
    cgroupMemoryMaxBytes: 1,
    cgroupPidsMax: 1,
    cgroupCpuMax: "100000 100000",
    outputChunkBytes: 1_024,
    outputBytesPerSecond: 0,
    nestedOutputMaxBytes: 1_024,
    nestedOutputMaxLines: 10,
    spillMaxBytes: 1_024,
    allowDegraded: false,
    jobRetentionHours: 1,
    bwrapPath: "bwrap",
    appRoot: root,
    runnerEntry: join(root, "runner.js"),
    nodePath: "/usr/bin:/bin",
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("a ready workspace that disappeared is refused without recreating its job directory", async (t) => {
  const cfg = await config(t);
  const first = await preparePtcWorkspace(cfg, JOB_ID, false);
  assert.deepEqual(first, { path: "/workspace", created: true, reused: false });
  await rm(join(cfg.workspaceRoot, JOB_ID), { recursive: true, force: true });

  await assert.rejects(
    preparePtcWorkspace(cfg, JOB_ID, true),
    (error: unknown) => error instanceof PtcHostError
      && error.code === "workspace_missing"
      && error.outcome === "not_started",
  );
  assert.equal(await exists(join(cfg.workspaceRoot, JOB_ID)), false, "no empty job directory was left behind");
});

test("a first open creates the workspace and a replay reuses it", async (t) => {
  const cfg = await config(t);
  const first = await preparePtcWorkspace(cfg, JOB_ID, false);
  assert.equal(first.created, true);
  assert.equal(first.reused, false);
  assert.equal(await exists(jobWorkspacePath(cfg, JOB_ID)), true);

  const replay = await preparePtcWorkspace(cfg, JOB_ID, true);
  assert.deepEqual(replay, { path: "/workspace", created: false, reused: true });
});
