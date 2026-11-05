// The owner's local console: a small authenticated HTTP surface over the bot manager.
//
// Interface: `startConsole()` listens on the configured address and returns a handle whose
// `close()` stops accepting connections and detaches every event stream. Routes:
//   GET  /                        the static page
//   GET  /api/bots                bots with their run state
//   POST /api/bots                create a bot from a name, a role and a system prompt
//   POST /api/bots/:id/messages   durably accept one request; answers with its id
//   POST /api/bots/:id/cancel     withdraw the bot's pending request and stop its run
//   GET  /api/bots/:id/history    the conversation's model-visible history
//   GET  /api/bots/:id/events     server-sent events for that conversation
//
// Inputs: the validated console configuration, the bot manager and the shutdown signal. Nothing
// from a request names a path, a model, a tool or a conversation: those are host decisions.
//
// Errors: every failure is a typed JSON answer with its status; an unknown bot is 404, an invalid
// body 400, a full bot list 409. The token is compared in constant time and is required on every
// route, including the event stream.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { BotManager } from "./bot-manager.js";
import type { ConsoleConfig } from "./config.js";
import { NotFoundError, StateError } from "./errors.js";

const MAX_BODY_BYTES = 64 * 1024;
const BOT_PATH = /^\/api\/bots\/([a-z0-9][a-z0-9_-]{0,31})(\/(messages|cancel|history|events))?$/;
/** Comment frames keep proxies and browsers from closing an idle stream. */
const HEARTBEAT_MS = 20_000;

export type ConsoleHandle = {
  readonly port: number;
  readonly address: string;
  close(): Promise<void>;
};

export type ConsoleOptions = {
  readonly config: ConsoleConfig;
  readonly bots: BotManager;
  readonly signal: AbortSignal;
  readonly log?: (line: string) => void;
};

/** Compared without an early exit, so a wrong token cannot be narrowed by timing. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

function headerToken(request: IncomingMessage, url: URL): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  // EventSource cannot set headers; the query token is the only option for the stream.
  return url.searchParams.get("token") ?? undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new StateError("Request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StateError("Request body must be JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

/**
 * The browser only needs the shape, not pi-durable's whole event vocabulary. Text deltas and tool
 * boundaries are what a chat view renders; everything else is summarized by its kind.
 */
function consoleEvents(events: readonly AgentEvent[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const event of events) {
    switch (event.type) {
      case "message_update": {
        const text = event.changes
          .flatMap((change) => change.type === "text_delta" ? [change.delta] : [])
          .join("");
        if (text !== "") out.push({ type: "delta", text });
        break;
      }
      case "tool_execution_start":
        out.push({ type: "tool", name: event.toolName.slice(0, 64), callId: event.toolCallId.slice(0, 128) });
        break;
      case "tool_execution_end":
        out.push({ type: "tool_end", name: event.toolName.slice(0, 64), callId: event.toolCallId.slice(0, 128) });
        break;
      case "run_start":
        out.push({ type: "run_start" });
        break;
      case "run_end":
        out.push({ type: "run_end" });
        break;
      case "entry_appended":
        out.push({ type: "entry", kind: String(event.entry.kind ?? "").slice(0, 32) });
        break;
      case "message_end":
        out.push({ type: "message_end" });
        break;
      case "task_failed":
        out.push({ type: "error", message: event.message.slice(0, 200) });
        break;
      default:
        break;
    }
  }
  return out;
}

export async function startConsole(options: ConsoleOptions): Promise<ConsoleHandle> {
  const { config, bots } = options;
  const page = await readFile(join(config.webDir, "index.html"), "utf8");
  const streams = new Set<{ stop(): Promise<void> }>();
  let closing = false;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof NotFoundError) {
        send(response, 404, { error: error.message });
        return;
      }
      if (error instanceof StateError) {
        send(response, 400, { error: error.message });
        return;
      }
      // Anything else is a host bug or a closed database; the caller learns nothing about it.
      options.log?.(`Console request failed: ${error instanceof Error ? error.message : "internal error"}`);
      send(response, 500, { error: "internal" });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://console");
    if (!tokenMatches(config.token, headerToken(request, url) ?? "")) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/") {
      // The page is static; the nonce makes its inline script the only one allowed to run.
      const nonce = randomBytes(16).toString("base64");
      const html = page.replaceAll("{{NONCE}}", nonce);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'nonce-" + nonce + "'",
          "connect-src 'self'",
          "img-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      response.end(html);
      return;
    }
    if (method === "GET" && url.pathname === "/api/bots") {
      send(response, 200, { bots: bots.views() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/bots") {
      if (bots.views().length >= config.maxBots) {
        send(response, 409, { error: "bot limit reached" });
        return;
      }
      const body = (await readJson(request)) as Record<string, unknown>;
      const bot = await bots.create({
        name: body.name,
        role: body.role,
        systemPrompt: body.systemPrompt,
        botId: body.botId,
        toolScope: body.toolScope,
      });
      send(response, 201, { bot });
      return;
    }
    const match = BOT_PATH.exec(url.pathname);
    if (match === null) {
      send(response, 404, { error: "not found" });
      return;
    }
    const botId = match[1] as string;
    const action = match[3];
    if (method === "POST" && action === "messages") {
      const body = (await readJson(request)) as Record<string, unknown>;
      const accepted = bots.send(botId, body.text);
      send(response, 202, accepted);
      return;
    }
    if (method === "POST" && action === "cancel") {
      send(response, 200, await bots.cancel(botId));
      return;
    }
    if (method === "GET" && action === "history") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      send(response, 200, { messages: await bots.history(botId, Number.isSafeInteger(limit) ? limit : 100) });
      return;
    }
    if (method === "GET" && action === "events") {
      await stream(botId, response);
      return;
    }
    send(response, 404, { error: "not found" });
  }

  async function stream(botId: string, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    const write = (payload: unknown): void => {
      if (!response.writableEnded) response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    let watcher: { stop(): Promise<void> } | undefined;
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const cleanup = async (): Promise<void> => {
      clearInterval(heartbeat);
      streams.delete(watcher ?? { stop: async () => {} });
      await watcher?.stop().catch(() => undefined);
      watcher = undefined;
    };
    response.on("close", () => {
      void cleanup();
    });
    try {
      const attached = await bots.watch(botId, (events) => {
        const mapped = consoleEvents(events);
        if (mapped.length > 0) write({ type: "events", events: mapped });
      });
      watcher = attached;
      streams.add(attached);
      write({ type: "snapshot", state: bots.views().find((view) => view.botId === botId) ?? null });
    } catch (error) {
      write({ type: "error", message: error instanceof StateError ? error.message : "stream failed" });
      response.end();
      clearInterval(heartbeat);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new StateError("Console could not determine its listening address");
  }

  const onAbort = (): void => {
    void close();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    options.signal.removeEventListener("abort", onAbort);
    for (const stream of streams) await stream.stop().catch(() => undefined);
    streams.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { port: address.port, address: `${config.host}:${address.port}`, close };
}
