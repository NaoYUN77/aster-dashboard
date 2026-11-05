import { isIP } from "node:net";
import { parseStrictJson } from "./strict-json.js";

const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const MAX_URL_CHARS = 8_192;
const MAX_TITLE_CHARS = 1_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export type WebFetchInput = {
  readonly url: string;
};

export type WebFetchOutput = {
  readonly ok: true;
  readonly provider: "deepseek";
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
};

export type WebFetchErrorCode =
  | "INVALID_ARGUMENT"
  | "BUSY"
  | "UPSTREAM_REQUEST_REJECTED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_BALANCE_REQUIRED"
  | "FETCH_BLOCKED"
  | "CONTENT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "UPSTREAM_HTTP_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_PROTOCOL_ERROR"
  | "RESULT_TOO_LARGE";

export type WebFetchFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: WebFetchErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
};

export class WebFetchError extends Error {
  readonly code: WebFetchErrorCode;
  readonly retryable: boolean;

  constructor(code: WebFetchErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
    this.retryable = retryable;
  }

  failure(): WebFetchFailure {
    return { ok: false, error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

type WebFetchOptions = {
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Tests replace the provider endpoint without making it a deployment setting. */
  readonly endpoint?: string;
};

export function parseWebFetchInput(value: unknown): Required<WebFetchInput> {
  if (!isRecord(value)) throw invalidInput("Arguments must be an object.");
  const unknown = Object.keys(value).find((key) => key !== "url");
  if (unknown !== undefined) throw invalidInput(`Unknown argument: ${unknown}.`);
  if (typeof value.url !== "string") throw invalidInput("url must be a string.");
  const raw = value.url.trim();
  if (!raw) throw invalidInput("url must not be empty.");
  if (hasUnpairedSurrogate(raw) || [...raw].length > MAX_URL_CHARS) {
    throw invalidInput(`url must be valid Unicode and at most ${MAX_URL_CHARS} characters.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidInput("url must be an absolute public HTTP(S) URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username || url.password || url.port
    || !hostname || isIP(hostname) !== 0
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw invalidInput("url must be an absolute public HTTP(S) URL without credentials, a custom port, or an IP-literal host.");
  }
  const normalized = url.toString();
  if ([...normalized].length > MAX_URL_CHARS) {
    throw invalidInput(`url must be at most ${MAX_URL_CHARS} characters after normalization.`);
  }
  return { url: normalized };
}

export async function fetchWeb(input: unknown, options: WebFetchOptions = {}): Promise<WebFetchOutput> {
  const parsed = parseWebFetchInput(input);
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new WebFetchError("PROVIDER_AUTH_FAILED", "Web fetch credentials are not configured.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new WebFetchError("INVALID_ARGUMENT", "Web fetch timeout is invalid.");
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(options.endpoint ?? DEEPSEEK_FETCH_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: parsed.url }),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      if (deadline.signal.aborted) throw timeout();
      if (error instanceof WebFetchError) throw error;
      throw new WebFetchError("NETWORK_ERROR", "Web fetch could not reach the provider.", true);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw httpError(response.status);
    }
    const raw = await readBoundedJson(response, signal).catch((error: unknown) => {
      if (options.signal?.aborted) throw cancelled();
      if (deadline.signal.aborted) throw timeout();
      throw error;
    });
    return normalizeResponse(raw, parsed.url);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new WebFetchError("RESULT_TOO_LARGE", "Web fetch response exceeds the size limit.");
  }
  if (response.body === null) throw protocolError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new WebFetchError("RESULT_TOO_LARGE", "Web fetch response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new WebFetchError("NETWORK_ERROR", "Web fetch response could not be read.", true);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseStrictJson(bytes, MAX_RESPONSE_BYTES);
  } catch {
    throw protocolError();
  }
}

function normalizeResponse(value: unknown, url: string): WebFetchOutput {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.content !== "string"
    || hasUnpairedSurrogate(value.title) || hasUnpairedSurrogate(value.content)
    || [...value.title].length > MAX_TITLE_CHARS) throw protocolError();
  const title = value.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const content = value.content
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  if (!content) throw protocolError();
  const full: WebFetchOutput = { ok: true, provider: "deepseek", url, title, content, truncated: false };
  if (Buffer.byteLength(JSON.stringify(full)) <= MAX_OUTPUT_BYTES) return full;

  const bounded = { ...full, content: "", truncated: true };
  let remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(JSON.stringify(bounded));
  if (remaining <= 0) throw new WebFetchError("RESULT_TOO_LARGE", "Web fetch metadata exceeds the output limit.");
  let excerpt = "";
  for (const character of content) {
    const encoded = JSON.stringify(character);
    const bytes = Buffer.byteLength(encoded) - 2;
    if (bytes > remaining) break;
    excerpt += character;
    remaining -= bytes;
  }
  return { ...bounded, content: excerpt.trimEnd() };
}

function httpError(status: number): WebFetchError {
  if (status === 400 || status === 413) return new WebFetchError("UPSTREAM_REQUEST_REJECTED", "Web fetch request was rejected.");
  if (status === 401) return new WebFetchError("PROVIDER_AUTH_FAILED", "Web fetch authentication failed.");
  if (status === 402) return new WebFetchError("PROVIDER_BALANCE_REQUIRED", "Web fetch account balance is insufficient.");
  if (status === 403) return new WebFetchError("FETCH_BLOCKED", "Web fetch was blocked by the provider safety policy.");
  if (status === 404) return new WebFetchError("CONTENT_UNAVAILABLE", "The page did not provide fetchable content.");
  if (status === 429) return new WebFetchError("RATE_LIMITED", "Web fetch rate limit exceeded.", true);
  if (status === 408 || status >= 500) return new WebFetchError("PROVIDER_UNAVAILABLE", "Web fetch provider is temporarily unavailable.", true);
  return new WebFetchError("UPSTREAM_HTTP_ERROR", "Web fetch provider returned an unexpected status.");
}

function invalidInput(message: string): WebFetchError {
  return new WebFetchError("INVALID_ARGUMENT", message);
}

function protocolError(): WebFetchError {
  return new WebFetchError("UPSTREAM_PROTOCOL_ERROR", "Web fetch provider returned an invalid response.");
}

function timeout(): WebFetchError {
  return new WebFetchError("TIMEOUT", "Web fetch timed out.", true);
}

function cancelled(): WebFetchError {
  return new WebFetchError("CANCELLED", "Web fetch was cancelled.");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
