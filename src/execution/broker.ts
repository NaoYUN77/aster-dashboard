import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { ConfigurationError } from "../errors.js";
import {
  MAX_REQUEST_BYTES,
  parseBrokerRequest,
  type ExecRequest,
  type OutputFrame,
  type ShellWindow,
  type SkippedOutput,
} from "./protocol.js";
import { RunnerError, type CommandRunner, type OutputSink } from "./runner.js";

export type BrokerServerOptions = {
  readonly socketPath: string;
  readonly executionId: string;
  readonly runner: CommandRunner;
  readonly maxConcurrent: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  readonly requestTimeoutMs: number;
};

export type BrokerServer = {
  close(): Promise<void>;
};

type Chunk = { text: string; bytes: number; newlines: number };

function countNewlines(text: string): number {
  let count = 0;
  let at = text.indexOf("\n");
  while (at !== -1) {
    count++;
    at = text.indexOf("\n", at + 1);
  }
  return count;
}

/**
 * Keeps at most `maxBytes` / `maxLines` of a stream and reports what it dropped, matching pi-durable's
 * `ShellOutputInfo.skipped` contract. Output beyond the window never accumulates in the broker.
 */
export class OutputWindow {
  private chunks: Chunk[] = [];
  private bytes = 0;
  private lines = 0;
  private skippedBytes = 0;
  private skippedLines = 0;
  private skippedEndsWithNewline = false;
  private hasSkipped = false;

  constructor(private readonly maxBytes: number, private readonly maxLines: number) {}

  push(text: string): void {
    if (text.length === 0) return;
    const chunk: Chunk = { text, bytes: Buffer.byteLength(text, "utf8"), newlines: countNewlines(text) };
    this.chunks.push(chunk);
    this.bytes += chunk.bytes;
    this.lines += chunk.newlines;
    while (this.chunks.length > 1 && (this.bytes > this.maxBytes || this.lines > this.maxLines)) {
      const dropped = this.chunks.shift()!;
      this.recordSkipped(dropped.text);
      this.bytes -= dropped.bytes;
      this.lines -= dropped.newlines;
    }
    if (this.bytes <= this.maxBytes && this.lines <= this.maxLines) return;
    const last = this.chunks[0];
    if (last === undefined) return;
    let rest = last.text;
    let removed = "";
    if (this.lines > this.maxLines) {
      let cut = -1;
      for (let index = 0; index < this.lines - this.maxLines; index++) {
        cut = rest.indexOf("\n", cut + 1);
        if (cut === -1) break;
      }
      if (cut !== -1) {
        removed += rest.slice(0, cut + 1);
        rest = rest.slice(cut + 1);
      }
    }
    let restBytes = Buffer.byteLength(rest, "utf8");
    if (restBytes > this.maxBytes) {
      const encoded = Buffer.from(rest, "utf8");
      let cut = encoded.length - this.maxBytes;
      // Do not split a UTF-8 sequence.
      while (cut < encoded.length && (encoded[cut]! & 0xc0) === 0x80) cut++;
      removed += encoded.subarray(0, cut).toString("utf8");
      rest = encoded.subarray(cut).toString("utf8");
      restBytes = Buffer.byteLength(rest, "utf8");
    }
    this.recordSkipped(removed);
    this.bytes = restBytes;
    this.lines = countNewlines(rest);
    if (rest.length === 0) this.chunks.shift();
    else this.chunks[0] = { text: rest, bytes: restBytes, newlines: this.lines };
  }

  private recordSkipped(removed: string): void {
    if (removed.length === 0) return;
    this.hasSkipped = true;
    this.skippedBytes += Buffer.byteLength(removed, "utf8");
    this.skippedLines += countNewlines(removed);
    this.skippedEndsWithNewline = removed.endsWith("\n");
  }

  take(): { text: string; skipped?: SkippedOutput } | undefined {
    if (this.chunks.length === 0 && !this.hasSkipped) return undefined;
    const text = this.chunks.map((chunk) => chunk.text).join("");
    const skipped: SkippedOutput | undefined = this.hasSkipped
      ? { bytes: this.skippedBytes, newlines: this.skippedLines, endsWithNewline: this.skippedEndsWithNewline }
      : undefined;
    this.chunks = [];
    this.bytes = 0;
    this.lines = 0;
    this.skippedBytes = 0;
    this.skippedLines = 0;
    this.skippedEndsWithNewline = false;
    this.hasSkipped = false;
    return { text, ...(skipped === undefined ? {} : { skipped }) };
  }
}

/** Keep a single frame comfortably below the client's line limit even after JSON escaping. */
const MAX_FRAME_TEXT = 16_384;
/** Do not add more to an already-backed-up socket; the window keeps only the tail meanwhile. */
const MAX_SOCKET_BACKLOG_BYTES = 1024 * 1024;

function splitText(text: string): string[] {
  if (text.length <= MAX_FRAME_TEXT) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_FRAME_TEXT, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      // 0xD800..0xDBFF followed by 0xDC00..0xDFFF is one surrogate pair; keep it together.
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function windowFor(options: BrokerServerOptions, request: ExecRequest): ShellWindow {
  return request.window ?? {
    maxBytes: options.maxOutputBytes,
    maxLines: options.maxOutputLines,
    minIntervalMs: 0,
    bytesPerSecond: 1,
  };
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket()) {
    throw new ConfigurationError("EXECUTION_BROKER_SOCKET exists and is not a socket; refusing to replace it");
  }
  await unlink(socketPath);
}

/**
 * Listens on the shared host socket. One request per connection keeps cancellation simple: when the
 * control plane disconnects, the request's AbortSignal reaches the SSH child and its process group.
 */
export async function startBrokerServer(options: BrokerServerOptions): Promise<BrokerServer> {
  const clients = new Set<Socket>();
  const active = new Set<AbortController>();
  await removeStaleSocket(options.socketPath);
  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    handleConnection(socket, options, active);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(options.socketPath, 0o600);
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        for (const controller of active) controller.abort();
        for (const socket of clients) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (process.platform !== "win32") await unlink(options.socketPath).catch(() => {});
      })();
      return closing;
    },
  };
}

function handleConnection(
  socket: Socket,
  options: BrokerServerOptions,
  active: Set<AbortController>,
): void {
  socket.setEncoding("utf8");
  socket.setNoDelay(true);
  let buffer = "";
  let seen = false;
  const requestTimer = setTimeout(() => {
    if (!seen) rejectRequest(socket, null, "invalid_request", "request was not received in time");
  }, options.requestTimeoutMs);
  const failInvalid = (message: string) => {
    clearTimeout(requestTimer);
    rejectRequest(socket, null, "invalid_request", message);
  };
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    if (seen) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      failInvalid(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    seen = true;
    clearTimeout(requestTimer);
    const line = buffer.slice(0, newline);
    buffer = "";
    const parsed = parseBrokerRequest(line);
    if (!parsed.ok) {
      rejectRequest(socket, null, "invalid_request", parsed.message);
      return;
    }
    if (parsed.value.type === "ping") {
      send(socket, {
        v: 1, type: "pong", protocol: 1, executionId: options.executionId,
      });
      socket.end();
      return;
    }
    if (active.size >= options.maxConcurrent) {
      rejectRequest(socket, parsed.value.id, "busy", "execution broker is busy; retry the command");
      return;
    }
    void runRequest(socket, options, parsed.value, active);
  });
  socket.on("close", () => clearTimeout(requestTimer));
}

async function runRequest(
  socket: Socket,
  options: BrokerServerOptions,
  request: ExecRequest,
  active: Set<AbortController>,
): Promise<void> {
  const controller = new AbortController();
  active.add(controller);
  const window = windowFor(options, request);
  const stdout = new OutputWindow(window.maxBytes, window.maxLines);
  const stderr = new OutputWindow(window.maxBytes, window.maxLines);
  let settled = false;
  socket.once("close", () => {
    if (!settled) controller.abort();
  });
  const sendFrames = (stream: "stdout" | "stderr", buffered: OutputWindow, force = false) => {
    // A slow reader must not turn the socket queue into an unbounded buffer. The window keeps the
    // tail and counts what it drops; a later drain (or the final forced flush) sends that tail.
    if (!force && socket.writableLength > MAX_SOCKET_BACKLOG_BYTES) return;
    const taken = buffered.take();
    if (taken === undefined) return;
    for (const [index, text] of splitText(taken.text).entries()) {
      const frame: OutputFrame = {
        v: 1, type: "output", id: request.id, stream, text,
        ...(index === 0 && taken.skipped !== undefined ? { skipped: taken.skipped } : {}),
      };
      send(socket, frame);
    }
  };
  const flush = (force = false) => {
    sendFrames("stdout", stdout, force);
    sendFrames("stderr", stderr, force);
  };
  const timer = window.minIntervalMs > 0 ? setInterval(flush, window.minIntervalMs) : undefined;
  timer?.unref();
  if (timer === undefined) socket.on("drain", flush);
  const sink: OutputSink = {
    stdout(text) {
      stdout.push(text);
      if (window.minIntervalMs === 0) sendFrames("stdout", stdout);
    },
    stderr(text) {
      stderr.push(text);
      if (window.minIntervalMs === 0) sendFrames("stderr", stderr);
    },
  };
  try {
    const outcome = await options.runner(request, sink, controller.signal);
    if (timer !== undefined) clearInterval(timer);
    flush(true);
    send(socket, { v: 1, type: "exit", id: request.id, exitCode: outcome.exitCode });
  } catch (error) {
    if (timer !== undefined) clearInterval(timer);
    flush(true);
    const failure = error instanceof RunnerError
      ? { code: error.code, message: error.message }
      : { code: "unknown" as const, message: "command runner failed" };
    send(socket, { v: 1, type: "error", id: request.id, code: failure.code, message: failure.message });
  } finally {
    settled = true;
    active.delete(controller);
    socket.end();
  }
}

function send(socket: Socket, frame: object): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(frame)}\n`);
}

function rejectRequest(
  socket: Socket,
  id: string | null,
  code: "invalid_request" | "busy",
  message: string,
): void {
  send(socket, { v: 1, type: "error", id, code, message });
  socket.end();
}
