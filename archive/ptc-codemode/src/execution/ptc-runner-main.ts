/**
 * Entry point for the sandboxed PTC runner. The agent starts this after it has created the
 * workspace and the sandbox; stdin/stdout carry length-prefixed frames only, never diagnostics.
 */
import { ConfigurationError } from "../errors.js";
import { PtcFileService, type PtcFileRoot } from "./ptc-fs.js";
import { PtcRunnerCore, executeLocalBash, type BashOptions } from "./ptc-runner-core.js";
import {
  PtcRunnerFrameDecoder,
  encodeRunnerFrame,
  parseHostFrame,
  type RunnerToHost,
} from "./ptc-runner-protocol.js";
import { PTC_SANDBOX_WORKSPACE } from "./ptc-workspace.js";

function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || !value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
    throw new ConfigurationError(`${name} must be an absolute path without '..'`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigurationError(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function optionalAbsolute(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  return absolute(env, name);
}

/**
 * The roots the runner may expose to file tools. They are the paths as seen *inside* the sandbox:
 * `/workspace` and `/shared` are mounts, and `/tmp` exists only when bwrap gave it a private tmpfs.
 * No root is ever the host root, and a read-only shared mount makes `file.write` fail closed.
 */
function fileRoots(env: NodeJS.ProcessEnv): PtcFileRoot[] {
  const roots: PtcFileRoot[] = [
    { virtual: "/workspace", host: absolute(env, "PTC_RUNNER_WORKSPACE"), writable: true },
  ];
  const shared = optionalAbsolute(env, "PTC_RUNNER_SHARED");
  const sharedMode = env.PTC_RUNNER_SHARED_MODE ?? "none";
  if (sharedMode !== "none" && sharedMode !== "ro" && sharedMode !== "rw") {
    throw new ConfigurationError("PTC_RUNNER_SHARED_MODE must be none, ro or rw");
  }
  if (sharedMode === "none" && shared !== undefined) {
    throw new ConfigurationError("PTC_RUNNER_SHARED is set but PTC_RUNNER_SHARED_MODE is none");
  }
  if (sharedMode !== "none" && shared === undefined) {
    throw new ConfigurationError("PTC_RUNNER_SHARED_MODE requires PTC_RUNNER_SHARED");
  }
  if (shared !== undefined) {
    roots.push({ virtual: "/shared", host: shared, writable: sharedMode === "rw" });
  }
  const tmp = optionalAbsolute(env, "PTC_RUNNER_TMP");
  if (tmp !== undefined) roots.push({ virtual: "/tmp", host: tmp, writable: true });
  return roots;
}

function bashOptions(env: NodeJS.ProcessEnv): BashOptions {
  return {
    workspacePath: absolute(env, "PTC_RUNNER_WORKSPACE"),
    // The reference path is the sandbox path, independent of where the workspace is mounted.
    sandboxWorkspace: PTC_SANDBOX_WORKSPACE,
    shellPath: absolute(env, "PTC_RUNNER_SHELL"),
    outputMaxBytes: integer(env, "PTC_RUNNER_OUTPUT_MAX_BYTES", 32 * 1024, 256, 1024 * 1024),
    outputMaxLines: integer(env, "PTC_RUNNER_OUTPUT_MAX_LINES", 1_000, 1, 100_000),
    outputBytesPerSecond: integer(env, "PTC_RUNNER_OUTPUT_BYTES_PER_SECOND", 0, 0, 1_000_000_000),
    spillMaxBytes: integer(env, "PTC_RUNNER_SPILL_MAX_BYTES", 64 * 1024 * 1024, 1_024, 1024 * 1024 * 1024),
    jobRetentionMs: integer(env, "PTC_RUNNER_JOB_RETENTION_MS", 168 * 3_600_000, 60_000, 365 * 24 * 3_600_000),
  };
}

let queue: Promise<void> = Promise.resolve();
let exiting = false;

function exitWhenFlushed(code: number): void {
  if (exiting) return;
  exiting = true;
  queue = queue.then(() => {
    process.exit(code);
  });
}

function write(frame: RunnerToHost): void {
  queue = queue.then(async () => {
    const buffer = encodeRunnerFrame(frame);
    if (!process.stdout.write(buffer)) {
      await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
    }
  }).catch((error: unknown) => {
    process.stderr.write(`ptc runner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
  if (frame.t === "done") exitWhenFlushed(0);
  if (frame.t === "error") exitWhenFlushed(1);
}

function main(): void {
  let core: PtcRunnerCore;
  try {
    core = new PtcRunnerCore({
      bash: bashOptions(process.env),
      files: new PtcFileService({ roots: fileRoots(process.env) }),
    }, write);
  } catch (error) {
    // Nothing is listening for frames yet; exiting non-zero is the only honest signal.
    process.stderr.write(`ptc runner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }

  const decoder = new PtcRunnerFrameDecoder();
  let first = true;
  const fail = (message: string): void => {
    write({ t: "error", code: "protocol_error", message: message.slice(0, 2_048) });
    core.cancel();
  };

  process.stdin.on("data", (chunk: Buffer) => {
    let frames: Buffer[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      fail(error instanceof Error ? error.message : "frame decoding failed");
      return;
    }
    for (const frame of frames) {
      const parsed = parseHostFrame(frame);
      if (!parsed.ok) {
        fail(parsed.message);
        return;
      }
      if (first && parsed.value.t !== "start") {
        fail("the first frame must be start");
        return;
      }
      first = false;
      void core.handle(parsed.value);
    }
  });
  process.stdin.on("end", () => {
    core.cancel();
    exitWhenFlushed(0);
  });
  process.stdin.on("error", () => {
    core.cancel();
    exitWhenFlushed(1);
  });
}

main();
