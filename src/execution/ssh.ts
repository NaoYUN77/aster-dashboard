import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { BrokerConfig, SshConfig } from "./broker-config.js";
import type { ExecRequest } from "./protocol.js";
import { RunnerError, type CommandRunner, type OutputSink } from "./runner.js";

/** POSIX single-quote quoting; the only character that needs care is the quote itself. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The script the execution host runs. `cd` failure is distinguishable as exit 125; the command is
 * parsed by the remote shell exactly once, and argv form is executed without shell re-parsing.
 */
export function buildRemoteScript(request: ExecRequest): string {
  const lines = [`cd -- ${shellQuote(request.cwd)} || exit 125`];
  const entries = Object.entries(request.env);
  if (request.inheritEnv) {
    for (const [key, value] of entries) lines.push(`export ${key}=${shellQuote(value)}`);
    if (typeof request.command === "string") lines.push(request.command);
    else lines.push(`exec ${request.command.map(shellQuote).join(" ")}`);
  } else {
    const prefix = entries.length === 0
      ? "env -i"
      : `env -i ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")}`;
    if (typeof request.command === "string") lines.push(`${prefix} /bin/sh -c ${shellQuote(request.command)}`);
    else lines.push(`exec ${prefix} ${request.command.map(shellQuote).join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * One remote command string. The script travels base64-encoded inside the command so SSH's
 * space-joined argument handling never re-quotes it, and remote `timeout` bounds the process
 * group even if the local SSH client is killed. Exit 124 means the remote timeout fired.
 */
export function buildRemoteCommand(request: ExecRequest): string {
  const encoded = Buffer.from(buildRemoteScript(request), "utf8").toString("base64");
  return `timeout --kill-after=5s ${request.timeoutSeconds}s /bin/sh -c "$(printf %s '${encoded}' | base64 -d)"`;
}

/**
 * SSH argv for one request. Options are fixed here rather than read from a user config, so the
 * target, key and host key policy cannot change behind the broker's back.
 */
export function buildSshArgv(ssh: SshConfig, remoteCommand: string): string[] {
  return [
    ssh.binary,
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ConnectTimeout=${ssh.connectTimeoutSeconds}`,
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-F", ssh.configPath ?? "/dev/null",
    "-o", `UserKnownHostsFile=${ssh.knownHostsPath}`,
    ...(ssh.keyPath === undefined ? [] : ["-o", "IdentitiesOnly=yes", "-i", ssh.keyPath]),
    "-p", String(ssh.port),
    `${ssh.user}@${ssh.host}`,
    remoteCommand,
  ];
}

/**
 * SSH keeps the connection open with pipes; killing the process group on timeout or abort also
 * stops an in-flight transfer. The remote `timeout` remains the primary duration bound; the local
 * timer is a backstop for a wedged SSH client.
 */
export function createSshRunner(config: BrokerConfig): CommandRunner {
  return async (request, sink, signal) => {
    signal.throwIfAborted();
    const argv = buildSshArgv(config.ssh, buildRemoteCommand(request));
    return await new Promise<{ exitCode: number }>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(argv[0]!, argv.slice(1), {
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp",
            LANG: "C.UTF-8",
          },
        });
      } catch (error) {
        reject(new RunnerError("spawn_error", "SSH client could not start", { cause: error }));
        return;
      }
      const stdout = new StringDecoder("utf8");
      const stderr = new StringDecoder("utf8");
      let settled = false;
      let timedOut = false;
      let exitCode: number | null = null;
      let localTimer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (localTimer !== undefined) clearTimeout(localTimer);
        signal.removeEventListener("abort", onAbort);
        child.removeListener("error", onError);
        const out = stdout.end();
        const err = stderr.end();
        if (out) sink.stdout(out);
        if (err) sink.stderr(err);
        fn();
      };
      const killTree = () => {
        try {
          if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // The process may already be gone; the close event still reports the outcome.
        }
      };
      const onAbort = () => {
        killTree();
        finish(() => reject(new RunnerError("aborted", "Command aborted")));
      };
      const onError = (error: Error) => {
        finish(() => reject(new RunnerError("spawn_error", "SSH client could not start", { cause: error })));
      };
      child.once("error", onError);
      child.stdout?.on("data", (chunk: Buffer) => sink.stdout(stdout.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => sink.stderr(stderr.write(chunk)));
      child.once("close", (code) => {
        exitCode = code;
        finish(() => {
          if (signal.aborted) {
            reject(new RunnerError("aborted", "Command aborted"));
          } else if (timedOut) {
            reject(new RunnerError("timeout", "Command timed out"));
          } else if (exitCode === 124) {
            reject(new RunnerError("timeout", "Command timed out"));
          } else if (exitCode === 255) {
            reject(new RunnerError("unknown", "SSH transport failed (exit 255)"));
          } else if (exitCode === null) {
            reject(new RunnerError("unknown", "SSH client ended without an exit code"));
          } else {
            resolve({ exitCode });
          }
        });
      });
      localTimer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, (request.timeoutSeconds + 10) * 1000);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };
}

export type { OutputSink };
