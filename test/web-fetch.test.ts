import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fetchWeb, parseWebFetchInput, WebFetchError } from "../src/web-fetch.js";
import { createWebExtension } from "../src/web-tools.js";
import { createToolRegistry } from "../src/tools.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof WebFetchError ? error.code : undefined;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("web fetch accepts public page URLs and rejects ambiguous network targets", () => {
  assert.deepEqual(parseWebFetchInput({ url: " https://Example.com/a?q=1#part " }), {
    url: "https://example.com/a?q=1#part",
  });
  for (const value of [
    null,
    {},
    { url: "" },
    { url: "file:///etc/passwd" },
    { url: "https://user:pass@example.com" },
    { url: "http://127.0.0.1/admin" },
    { url: "http://[::1]/" },
    { url: "http://localhost/" },
    { url: "https://service.internal/" },
    { url: "https://example.com:8443/" },
    { url: "https://example.com", extra: true },
    { url: `https://example.com/${"x".repeat(8_193)}` },
    { url: `https://example.com/${"é".repeat(4_090)}` },
    { url: "https://example.com/\ud800" },
  ]) assert.throws(() => parseWebFetchInput(value), (error) => errorCode(error) === "INVALID_ARGUMENT");
});

test("DeepSeek fetch request keeps credentials in headers and normalizes Markdown", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const output = await fetchWeb({ url: "https://example.com/article" }, {
    apiKey: "test-secret",
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse({ title: "  Example\n article ", content: "# Heading\r\n\r\nBody\u0000 text.  " });
    },
  });
  assert.equal(request?.url, "https://api.deepseek.com/v1/tools/fetch");
  assert.equal(request?.init?.redirect, "manual");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { url: "https://example.com/article" });
  assert.doesNotMatch(String(request?.init?.body), /test-secret/);
  assert.deepEqual(output, {
    ok: true,
    provider: "deepseek",
    url: "https://example.com/article",
    title: "Example article",
    content: "# Heading\n\nBody  text.",
    truncated: false,
  });
});

test("large page content is explicitly marked and bounded at a Unicode boundary", async () => {
  const output = await fetchWeb({ url: "https://example.com/large" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ title: "Large", content: "😀".repeat(100_000) }),
  });
  assert.equal(output.truncated, true);
  assert.equal(output.content.includes("�"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 24 * 1024);
});

test("empty or malformed provider content fails instead of pretending fetch succeeded", async () => {
  for (const response of [
    {},
    { title: null, content: "body" },
    { title: "title", content: "" },
    { title: "title", content: " \n " },
    { title: "x".repeat(1_001), content: "body" },
    { title: "title", content: "\ud800" },
  ]) {
    await assert.rejects(
      fetchWeb({ url: "https://example.com" }, { apiKey: "key", fetch: async () => jsonResponse(response) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("Fetch statuses are categorized without exposing response bodies or credentials", async () => {
  const cases = [
    [400, "UPSTREAM_REQUEST_REJECTED"],
    [401, "PROVIDER_AUTH_FAILED"],
    [402, "PROVIDER_BALANCE_REQUIRED"],
    [403, "FETCH_BLOCKED"],
    [404, "CONTENT_UNAVAILABLE"],
    [429, "RATE_LIMITED"],
    [504, "PROVIDER_UNAVAILABLE"],
    [418, "UPSTREAM_HTTP_ERROR"],
  ] as const;
  for (const [status, expected] of cases) {
    await assert.rejects(
      fetchWeb({ url: "https://example.com" }, {
        apiKey: "secret-never-returned",
        fetch: async () => new Response("body secret-never-returned", { status }),
      }),
      (error) => errorCode(error) === expected && !String(error).includes("secret-never-returned"),
    );
  }
});

test("fetch timeout and caller cancellation abort provider I/O", async () => {
  let timeoutSignal: AbortSignal | undefined;
  await assert.rejects(fetchWeb({ url: "https://example.com/timeout" }, {
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
  const pending = fetchWeb({ url: "https://example.com/cancel" }, {
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

test("oversized upstream Fetch responses fail before parsing", async () => {
  await assert.rejects(fetchWeb({ url: "https://example.com/large" }, {
    apiKey: "key",
    fetch: async () => new Response("x", { headers: { "content-length": String(512 * 1024 + 1) } }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
});

test("built-in cancellation rejects the tool attempt instead of committing an error result", async () => {
  const controller = new AbortController();
  const registry = createToolRegistry([createWebExtension({
    apiKey: "key",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  })], { log: () => {} });
  const tool = registry.snapshot().tools().find(({ tool }) => tool.name === "web_fetch")!.tool;
  const pending = tool.execute({ url: "https://example.com" }, {
    conversationId: 1, taskId: 2, callId: "cancel",
  } as ToolExecutionApi, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
  controller.abort();
  await assert.rejects(pending);
});

test("built-in web extension exposes both read-only tools with shared bounded concurrency", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const registry = createToolRegistry([createWebExtension({
    apiKey: "host-secret",
    fetch: async (input, init) => {
      await held;
      return String(input).endsWith("/fetch")
        ? jsonResponse({ title: "Title", content: "Body" })
        : jsonResponse({ results: [] });
    },
  })], { authority: "restricted", log: () => {} });
  assert.deepEqual(registry.records().map(({ name }) => name), ["web_search", "web_fetch"]);
  for (const name of ["web_search", "web_fetch"]) {
    assert.equal(registry.lookup(name)?.authz, "read");
    assert.equal(registry.lookup(name)?.replay, "unsafe");
  }
  const tools = Object.fromEntries(registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
  const api = (callId: string) => ({ conversationId: 1, taskId: 2, callId }) as ToolExecutionApi;
  const first = tools.web_search!.execute({ query: "one" }, api("one"), BACKGROUND_CONTEXT);
  const second = tools.web_fetch!.execute({ url: "https://example.com/two" }, api("two"), BACKGROUND_CONTEXT);
  const busy = await tools.web_fetch!.execute({ url: "https://example.com/three" }, api("three"), BACKGROUND_CONTEXT);
  assert.equal(busy.isError, true);
  assert.equal((busy.structuredOutput as { error?: { code?: string } }).error?.code, "BUSY");
  release!();
  assert.equal((await first).isError, undefined);
  assert.equal((await second).isError, undefined);
});
