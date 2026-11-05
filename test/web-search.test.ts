import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createToolRegistry } from "../src/tools.js";
import { parseWebSearchInput, searchWeb, WebSearchError } from "../src/web-search.js";
import { createWebExtension } from "../src/web-tools.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof WebSearchError ? error.code : undefined;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function providerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rerank_score: 2.5,
    title: "DeepSeek Search",
    url: "https://example.com/search#fragment",
    snippet: "A concise snippet.",
    summary: "A longer summary.",
    content: "",
    site_name: "Example",
    site_icon: null,
    date: "2026-10-29T01:02:03Z",
    authority: 3,
    ...overrides,
  };
}

test("web search input is narrow, Unicode-aware, and applies a deterministic result default", () => {
  assert.deepEqual(parseWebSearchInput({ query: "  current news  " }), { query: "current news", maxResults: 5 });
  assert.deepEqual(parseWebSearchInput({ query: "😀".repeat(128), maxResults: 10 }), { query: "😀".repeat(128), maxResults: 10 });
  for (const value of [
    null,
    {},
    { query: "" },
    { query: "x", maxResults: 0 },
    { query: "x", maxResults: null },
    { query: "x", extra: true },
    { query: "x".repeat(129) },
    { query: "\ud800" },
  ]) {
    assert.throws(() => parseWebSearchInput(value), (error) => errorCode(error) === "INVALID_ARGUMENT");
  }
});

test("DeepSeek requests keep credentials in headers and normalize strict provider results", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const output = await searchWeb({ query: " node 24 ", maxResults: 2 }, {
    apiKey: "test-secret",
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse({ results: [
        providerResult(),
        providerResult({
          title: "Second",
          url: "http://example.org/#/article/42",
          snippet: "second",
          summary: "second summary",
          site_name: null,
          date: "2026-10-29T01:02:03+00:00",
          authority: -1,
          rerank_score: 0,
        }),
      ], ignored: "provider extension" });
    },
  });

  assert.equal(request?.url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(request?.init?.redirect, "manual");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body, { query: "node 24", count: 2, need_content: false });
  assert.doesNotMatch(JSON.stringify(body), /test-secret/);
  assert.deepEqual(output, {
    ok: true,
    provider: "deepseek",
    query: "node 24",
    results: [
      {
        rank: 1,
        title: "DeepSeek Search",
        url: "https://example.com/search#fragment",
        snippet: "A concise snippet.",
        summary: "A longer summary.",
        siteName: "Example",
        publishedAt: "2026-10-29T01:02:03.000Z",
      },
      {
        rank: 2,
        title: "Second",
        url: "http://example.org/#/article/42",
        snippet: "second",
        summary: "second summary",
        siteName: null,
        publishedAt: "2026-10-29T01:02:03.000Z",
      },
    ],
  });
});

test("DeepSeek-supported empty result text remains a successful search", async () => {
  const output = await searchWeb({ query: "OpenAI blog latest", maxResults: 5 }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [
      providerResult({
        title: "",
        url: "https://b.test",
        snippet: "",
        summary: "",
        site_name: null,
        site_icon: null,
        date: null,
        authority: -1,
        rerank_score: 1.2,
      }),
    ] }),
  });

  assert.deepEqual(output, {
    ok: true,
    provider: "deepseek",
    query: "OpenAI blog latest",
    results: [{
      rank: 1,
      title: "",
      url: "https://b.test/",
      snippet: "",
      summary: "",
      siteName: null,
      publishedAt: null,
    }],
  });
});

test("an omitted optional DeepSeek summary normalizes to empty text", async () => {
  const result = providerResult();
  delete result.summary;

  const output = await searchWeb({ query: "missing summary" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [result] }),
  });

  assert.equal(output.results[0]?.summary, "");
});

test("an empty DeepSeek date normalizes to an unknown publication date", async () => {
  const output = await searchWeb({ query: "unknown date" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [providerResult({ date: "" })] }),
  });

  assert.equal(output.results[0]?.publishedAt, null);
});

test("unused DeepSeek result metadata cannot invalidate consumed search fields", async () => {
  const result = providerResult();
  delete result.rerank_score;
  delete result.authority;
  delete result.content;
  delete result.site_icon;

  const output = await searchWeb({ query: "minimal metadata" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [result] }),
  });

  assert.equal(output.results[0]?.title, "DeepSeek Search");
});

test("provider results beyond the requested maximum are not exposed", async () => {
  const output = await searchWeb({ query: "bounded results", maxResults: 1 }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [
      providerResult({ title: "First" }),
      providerResult({ title: "Second" }),
    ] }),
  });

  assert.deepEqual(output.results.map(({ title }) => title), ["First"]);
});

test("provider text is governed by total budgets rather than undocumented field limits", async () => {
  const title = "t".repeat(501);
  const output = await searchWeb({ query: "long title" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [providerResult({ title })] }),
  });

  assert.equal(output.results[0]?.title, title);
});

test("empty results succeed while malformed result fields fail the whole response", async () => {
  assert.deepEqual(await searchWeb({ query: "nothing" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [] }),
  }), { ok: true, provider: "deepseek", query: "nothing", results: [] });

  for (const result of [
    providerResult({ title: 1 }),
    providerResult({ snippet: 1 }),
    providerResult({ summary: null }),
    providerResult({ site_name: 1 }),
    providerResult({ date: "not-a-date" }),
    providerResult({ date: "2026-02-30T01:02:03Z" }),
    providerResult({ url: "file:///etc/passwd" }),
  ]) {
    await assert.rejects(
      searchWeb({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ results: [result] }) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("provider failures are categorized without exposing response bodies or credentials", async () => {
  const cases = [
    [400, "UPSTREAM_REQUEST_REJECTED"],
    [401, "PROVIDER_AUTH_FAILED"],
    [402, "PROVIDER_BALANCE_REQUIRED"],
    [429, "RATE_LIMITED"],
    [504, "PROVIDER_UNAVAILABLE"],
    [418, "UPSTREAM_HTTP_ERROR"],
  ] as const;
  for (const [status, expected] of cases) {
    await assert.rejects(
      searchWeb({ query: "x" }, {
        apiKey: "secret-never-returned",
        fetch: async () => new Response("provider body with secret-never-returned", { status }),
      }),
      (error) => errorCode(error) === expected && !String(error).includes("secret-never-returned"),
    );
  }
  await assert.rejects(
    searchWeb({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ unexpected: true }) }),
    (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
  );
});

test("timeouts and caller cancellation abort the provider request", async () => {
  let timeoutSignal: AbortSignal | undefined;
  await assert.rejects(searchWeb({ query: "timeout" }, {
    apiKey: "key",
    timeoutMs: 10,
    fetch: async (_input, init) => {
      timeoutSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        timeoutSignal?.addEventListener("abort", () => reject(timeoutSignal?.reason), { once: true });
      });
    },
  }), (error) => errorCode(error) === "TIMEOUT");
  assert.equal(timeoutSignal?.aborted, true);

  const caller = new AbortController();
  let callerSignal: AbortSignal | undefined;
  const pending = searchWeb({ query: "cancel" }, {
    apiKey: "key",
    signal: caller.signal,
    fetch: async (_input, init) => {
      callerSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        callerSignal?.addEventListener("abort", () => reject(callerSignal?.reason), { once: true });
      });
    },
  });
  caller.abort();
  await assert.rejects(pending, (error) => errorCode(error) === "CANCELLED");
  assert.equal(callerSignal?.aborted, true);
});

test("oversized upstream responses and normalized outputs fail explicitly", async () => {
  await assert.rejects(searchWeb({ query: "large" }, {
    apiKey: "key",
    fetch: async () => new Response("x", { headers: { "content-length": String(256 * 1024 + 1) } }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
  await assert.rejects(searchWeb({ query: "large normalized output", maxResults: 10 }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: Array.from({ length: 10 }, (_, index) => providerResult({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      snippet: "s".repeat(2_000),
      summary: "m".repeat(4_000),
    })) }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
});

test("built-in web search registers with read governance and host-only credentials", async () => {
  let authorization: string | null = null;
  const registry = createToolRegistry([createWebExtension({
    apiKey: "host-secret",
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({ results: [] });
    },
  })], { authority: "restricted", log: () => {} });
  const record = registry.lookup("web_search");
  assert.ok(record);
  assert.deepEqual(record.source, { kind: "builtin", extension: "web-tools" });
  assert.equal(record.authz, "read");
  assert.equal(record.trust, "trusted");
  assert.equal(record.replay, "unsafe");
  const tool = registry.snapshot().tools().find(({ tool }) => tool.name === "web_search")!.tool;
  assert.equal(JSON.stringify(tool.parameters).includes("apiKey"), false);
  const result = await tool.execute({ query: "test" }, {
    conversationId: 1, taskId: 2, callId: "search",
  } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(result.isError, undefined);
  assert.equal(authorization, "Bearer host-secret");
  assert.deepEqual(result.structuredOutput, { ok: true, provider: "deepseek", query: "test", results: [] });
  assert.deepEqual(result.output, [{ type: "text", text: JSON.stringify(result.structuredOutput) }]);
});
