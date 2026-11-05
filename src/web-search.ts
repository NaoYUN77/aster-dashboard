import { parseStrictJson } from "./strict-json.js";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_QUERY_CHARS = 128;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export type WebSearchInput = {
  readonly query: string;
  readonly maxResults?: number;
};

export type WebSearchResult = {
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly summary: string;
  readonly siteName: string | null;
  readonly publishedAt: string | null;
};

export type WebSearchOutput = {
  readonly ok: true;
  readonly provider: "deepseek";
  readonly query: string;
  readonly results: readonly WebSearchResult[];
};

export type WebSearchErrorCode =
  | "INVALID_ARGUMENT"
  | "BUSY"
  | "UPSTREAM_REQUEST_REJECTED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_BALANCE_REQUIRED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "UPSTREAM_HTTP_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_PROTOCOL_ERROR"
  | "RESULT_TOO_LARGE";

export type WebSearchFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: WebSearchErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
};

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly retryable: boolean;

  constructor(code: WebSearchErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.retryable = retryable;
  }

  failure(): WebSearchFailure {
    return { ok: false, error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

type WebSearchOptions = {
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Tests replace the provider endpoint without making it a deployment setting. */
  readonly endpoint?: string;
};

export function parseWebSearchInput(value: unknown): Required<WebSearchInput> {
  if (!isRecord(value)) throw invalidInput("Arguments must be an object.");
  const unknown = Object.keys(value).find((key) => key !== "query" && key !== "maxResults");
  if (unknown !== undefined) throw invalidInput(`Unknown argument: ${unknown}.`);
  if (typeof value.query !== "string") throw invalidInput("query must be a string.");
  const query = value.query.trim();
  if (!query) throw invalidInput("query must not be empty.");
  if (hasUnpairedSurrogate(query)) throw invalidInput("query must contain valid Unicode text.");
  if ([...query].length > MAX_QUERY_CHARS) {
    throw invalidInput(`query must be at most ${MAX_QUERY_CHARS} characters.`);
  }
  const maxResults = Object.hasOwn(value, "maxResults") ? value.maxResults : DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > MAX_RESULTS) {
    throw invalidInput(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  return { query, maxResults: maxResults as number };
}

export async function searchWeb(input: unknown, options: WebSearchOptions = {}): Promise<WebSearchOutput> {
  const parsed = parseWebSearchInput(input);
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new WebSearchError("PROVIDER_AUTH_FAILED", "Web search credentials are not configured.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new WebSearchError("INVALID_ARGUMENT", "Web search timeout is invalid.");
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(options.endpoint ?? DEEPSEEK_SEARCH_URL, {
        method: "POST",
        // Inspect redirects instead of following them, so the Authorization header never reaches another origin.
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: parsed.query, count: parsed.maxResults, need_content: false }),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      if (deadline.signal.aborted) throw timeout();
      if (error instanceof WebSearchError) throw error;
      throw new WebSearchError("NETWORK_ERROR", "Web search could not reach the provider.", true);
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
    const output = normalizeResponse(raw, parsed.query, parsed.maxResults);
    if (Buffer.byteLength(JSON.stringify(output)) > MAX_OUTPUT_BYTES) {
      throw new WebSearchError("RESULT_TOO_LARGE", "Web search results exceed the output limit.");
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new WebSearchError("RESULT_TOO_LARGE", "Web search response exceeds the size limit.");
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
        throw new WebSearchError("RESULT_TOO_LARGE", "Web search response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new WebSearchError("NETWORK_ERROR", "Web search response could not be read.", true);
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

function normalizeResponse(value: unknown, query: string, maxResults: number): WebSearchOutput {
  if (!isRecord(value) || !Array.isArray(value.results)) throw protocolError();
  const results = value.results.slice(0, maxResults).map((candidate, index): WebSearchResult => {
    if (!isRecord(candidate)) throw protocolError();
    const title = providerText(candidate.title);
    const url = safeUrl(candidate.url);
    const snippet = providerText(candidate.snippet);
    const summary = candidate.summary === undefined ? "" : providerText(candidate.summary);
    const siteName = nullableText(candidate.site_name);
    const publishedAt = nullableDate(candidate.date);
    if (title === undefined || url === undefined || snippet === undefined || summary === undefined
      || siteName === undefined || publishedAt === undefined) throw protocolError();
    return { rank: index + 1, title, url, snippet, summary, siteName, publishedAt };
  });
  return { ok: true, provider: "deepseek", query, results };
}

function providerText(value: unknown): string | undefined {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return providerText(value);
}

function nullableDate(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|\+00:00)$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function httpError(status: number): WebSearchError {
  if (status === 400 || status === 413) return new WebSearchError("UPSTREAM_REQUEST_REJECTED", "Web search request was rejected.");
  if (status === 401) return new WebSearchError("PROVIDER_AUTH_FAILED", "Web search authentication failed.");
  if (status === 402) return new WebSearchError("PROVIDER_BALANCE_REQUIRED", "Web search account balance is insufficient.");
  if (status === 429) return new WebSearchError("RATE_LIMITED", "Web search rate limit exceeded.", true);
  if (status === 408 || status >= 500) return new WebSearchError("PROVIDER_UNAVAILABLE", "Web search provider is temporarily unavailable.", true);
  return new WebSearchError("UPSTREAM_HTTP_ERROR", "Web search provider returned an unexpected status.");
}

function invalidInput(message: string): WebSearchError {
  return new WebSearchError("INVALID_ARGUMENT", message);
}

function protocolError(): WebSearchError {
  return new WebSearchError("UPSTREAM_PROTOCOL_ERROR", "Web search provider returned an invalid response.");
}

function timeout(): WebSearchError {
  return new WebSearchError("TIMEOUT", "Web search timed out.", true);
}

function cancelled(): WebSearchError {
  return new WebSearchError("CANCELLED", "Web search was cancelled.");
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
