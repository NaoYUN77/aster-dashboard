import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { fetchWeb, WebFetchError, type WebFetchFailure, type WebFetchOutput } from "./web-fetch.js";
import { searchWeb, WebSearchError, type WebSearchFailure, type WebSearchOutput } from "./web-search.js";
import type { GovernedTool } from "./tools.js";

const MAX_CONCURRENT_REQUESTS = 2;
const errorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  retryable: Type.Boolean(),
}, { additionalProperties: false });
const failureSchema = Type.Object({
  ok: Type.Literal(false),
  error: errorSchema,
}, { additionalProperties: false });
const webSearchOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    provider: Type.Literal("deepseek"),
    query: Type.String(),
    results: Type.Array(Type.Object({
      rank: Type.Integer({ minimum: 1 }),
      title: Type.String(),
      url: Type.String(),
      snippet: Type.String(),
      summary: Type.String(),
      siteName: Type.Union([Type.String(), Type.Null()]),
      publishedAt: Type.Union([Type.String(), Type.Null()]),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  failureSchema,
]);
const webFetchOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    provider: Type.Literal("deepseek"),
    url: Type.String(),
    title: Type.String(),
    content: Type.String(),
    truncated: Type.Boolean(),
  }, { additionalProperties: false }),
  failureSchema,
]);

export type WebToolsOptions = {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
};

function toolResult(
  result: WebSearchOutput | WebSearchFailure | WebFetchOutput | WebFetchFailure,
  isError = false,
): ToolExecutionResult {
  const text = JSON.stringify(result);
  return {
    ...(isError ? { isError: true } : {}),
    output: [{ type: "text", text }],
    structuredOutput: JSON.parse(text),
  };
}

/** Built-in web tools bound to host credentials; secrets are never model parameters. */
export function createWebExtension(options: WebToolsOptions) {
  let activeRequests = 0;
  const webSearch = Object.assign(defineTool({
    name: "web_search",
    description: "Search the public web for current information and return source URLs with concise snippets.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 128, description: "The search query." }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Maximum result count." })),
    }, { additionalProperties: false }),
    structuredOutputSchema: webSearchOutputSchema,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return toolResult(new WebSearchError("BUSY", "Web search is busy; try again later.", true).failure(), true);
      }
      activeRequests++;
      try {
        const result = await searchWeb(args, {
          apiKey: options.apiKey,
          signal: context.abortSignal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return toolResult(result);
      } catch (cause) {
        if (context.abortSignal?.aborted) throw cause;
        const failure = cause instanceof WebSearchError
          ? cause
          : new WebSearchError("NETWORK_ERROR", "Web search failed.", true);
        return toolResult(failure.failure(), true);
      } finally {
        activeRequests--;
      }
    },
  }), {
    governance: {
      source: { kind: "builtin" as const, extension: "web-tools" },
      trust: "trusted" as const,
      authz: "read" as const,
    },
  }) satisfies GovernedTool;

  const webFetch = Object.assign(defineTool({
    name: "web_fetch",
    description: "Fetch one public web page by URL and return its extracted Markdown content.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 8_192, description: "An absolute public HTTP(S) page URL." }),
    }, { additionalProperties: false }),
    structuredOutputSchema: webFetchOutputSchema,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return toolResult(new WebFetchError("BUSY", "Web fetch is busy; try again later.", true).failure(), true);
      }
      activeRequests++;
      try {
        const result = await fetchWeb(args, {
          apiKey: options.apiKey,
          signal: context.abortSignal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return toolResult(result);
      } catch (cause) {
        if (context.abortSignal?.aborted) throw cause;
        const failure = cause instanceof WebFetchError
          ? cause
          : new WebFetchError("NETWORK_ERROR", "Web fetch failed.", true);
        return toolResult(failure.failure(), true);
      } finally {
        activeRequests--;
      }
    },
  }), {
    governance: {
      source: { kind: "builtin" as const, extension: "web-tools" },
      trust: "trusted" as const,
      authz: "read" as const,
    },
  }) satisfies GovernedTool;

  return defineExtension({ name: "web-tools", tools: [webSearch, webFetch] });
}
