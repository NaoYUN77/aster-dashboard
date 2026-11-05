import { connect, type Socket } from "node:net";
import {
  MAX_FRAME_BYTES,
  parseBrokerFrame,
  type BrokerErrorCode,
  type BrokerRequest,
  type ExecRequest,
  type ExitFrame,
  type OutputFrame,
  type PongFrame,
} from "./protocol.js";

export type BrokerClientErrorCode = BrokerErrorCode | "unavailable";

export class BrokerClientError extends Error {
  override name = "BrokerClientError";
  constructor(readonly code: BrokerClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export type BrokerClientOptions = {
  readonly socketPath: string;
  readonly connectTimeoutMs: number;
};

type ExchangeOptions = {
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
  readonly onOutput?: (frame: OutputFrame) => void;
};

/**
 * One request per connection. The broker is a private host socket shared with the application
 * container; there is no authentication layer beyond the socket's ownership and mode.
 */
export class BrokerClient {
  private readonly active = new Set<Socket>();

  constructor(private readonly options: BrokerClientOptions) {}

  async ping(options: { signal?: AbortSignal } = {}): Promise<PongFrame> {
    const frame = await this.exchange({ v: 1, type: "ping" }, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      deadlineMs: this.options.connectTimeoutMs,
    });
    if (frame.type !== "pong") throw new BrokerClientError("unknown", "broker returned an unexpected reply");
    return frame;
  }

  async exec(request: ExecRequest, options: {
    readonly signal?: AbortSignal;
    readonly onOutput?: (frame: OutputFrame) => void;
  } = {}): Promise<ExitFrame> {
    const frame = await this.exchange(request, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      deadlineMs: request.timeoutSeconds * 1000 + 5_000,
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    });
    if (frame.type !== "exit") throw new BrokerClientError("unknown", "broker returned an unexpected reply");
    return frame;
  }

  /** Shutdown only; request cancellation goes through the request's AbortSignal. */
  abortAll(): void {
    for (const socket of this.active) socket.destroy();
    this.active.clear();
  }

  private exchange(
    request: BrokerRequest,
    options: ExchangeOptions,
  ): Promise<PongFrame | ExitFrame> {
    if (options.signal?.aborted) {
      return Promise.reject(new BrokerClientError("aborted", "request aborted"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let timer: NodeJS.Timeout | undefined;
      const socket = connect({ path: this.options.socketPath });
      this.active.add(socket);
      const finish = (error?: BrokerClientError, reply?: PongFrame | ExitFrame) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.active.delete(socket);
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(reply!);
      };
      const onAbort = () => finish(new BrokerClientError("aborted", "request aborted"));
      timer = setTimeout(
        () => finish(new BrokerClientError(request.type === "exec" ? "timeout" : "unavailable", "execution broker did not answer in time")),
        options.deadlineMs,
      );
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("error", (error) => finish(new BrokerClientError("unavailable", "execution broker is unavailable", { cause: error })));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
          finish(new BrokerClientError("unknown", "execution broker sent an oversized frame"));
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseBrokerFrame(line);
          if (!parsed.ok) {
            finish(new BrokerClientError("unknown", "execution broker sent an invalid frame"));
            return;
          }
          const frame = parsed.value;
          if (frame.type === "output") {
            if (request.type !== "exec" || frame.id !== request.id) {
              finish(new BrokerClientError("unknown", "execution broker sent an unexpected output frame"));
              return;
            }
            try {
              options.onOutput?.(frame);
            } catch {
              finish(new BrokerClientError("unknown", "output handler failed"));
              return;
            }
          } else if (frame.type === "error") {
            finish(new BrokerClientError(frame.code, frame.message));
            return;
          } else if (frame.type === "exit") {
            if (request.type !== "exec" || frame.id !== request.id) {
              finish(new BrokerClientError("unknown", "execution broker sent an unexpected exit frame"));
              return;
            }
            finish(undefined, frame);
            return;
          } else {
            if (request.type !== "ping") {
              finish(new BrokerClientError("unknown", "execution broker sent an unexpected reply"));
              return;
            }
            finish(undefined, frame);
            return;
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => {
        finish(new BrokerClientError(request.type === "exec" ? "unknown" : "unavailable",
          "execution broker closed the connection"));
      });
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
    });
  }
}
