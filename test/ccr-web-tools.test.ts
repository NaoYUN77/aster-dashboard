import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { spawn } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createToolRegistry } from "../src/tools.js";
import { ccrArguments, createCcrWebExtension } from "../src/ccr-web-tools.js";

test("CCR command arguments isolate each native web tool", () => {
  assert.deepEqual(ccrArguments("research-profile", "web_search"), [
    "research-profile", "cli", "--", "--print", "--output-format", "text", "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--no-session-persistence", "--tools", "WebSearch", "--allowedTools", "WebSearch", "-p",
  ]);
  assert.deepEqual(ccrArguments("research-profile", "web_fetch").slice(-5), [
    "--tools", "WebFetch", "--allowedTools", "WebFetch", "-p",
  ]);
});

test("CCR web extension exposes search and fetch and rejects non-public URLs", async () => {
  const calls: { tool: string; prompt: string }[] = [];
  const registry = createToolRegistry([createCcrWebExtension({
    command: "ccr",
    profile: "research-profile",
    run: async (tool, prompt) => {
      calls.push({ tool, prompt });
      return `result for ${tool}`;
    },
  })], { log: () => {} });
  assert.deepEqual(registry.records().map(({ name }) => name), ["web_search", "web_fetch"]);
  for (const name of ["web_search", "web_fetch"]) {
    assert.equal(registry.lookup(name)?.authz, "read");
    assert.equal(registry.lookup(name)?.replay, "unsafe");
  }
  const tools = Object.fromEntries(registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
  const api = (callId: string) => ({ conversationId: 1, taskId: 2, callId }) as ToolExecutionApi;

  const search = await tools.web_search!.execute({ query: "climate data" }, api("search"), BACKGROUND_CONTEXT);
  assert.equal((search.structuredOutput as { ok: boolean }).ok, true);
  assert.equal(calls[0]?.tool, "web_search");
  assert.match(calls[0]?.prompt ?? "", /climate data/);

  const rejected = await tools.web_fetch!.execute({ url: "http://127.0.0.1/private" }, api("private"), BACKGROUND_CONTEXT);
  assert.equal((rejected.structuredOutput as { ok: boolean }).ok, false);
  assert.equal(calls.length, 1);

  const fetched = await tools.web_fetch!.execute({ url: "https://example.org/page" }, api("fetch"), BACKGROUND_CONTEXT);
  assert.equal((fetched.structuredOutput as { ok: boolean }).ok, true);
  assert.equal(calls[1]?.tool, "web_fetch");
  assert.match(calls[1]?.prompt ?? "", /https:\/\/example\.org\/page/);
});

test("CCR process boundary pipes the prompt and preserves stdout/stderr failures", async () => {
  let command = "";
  let args: readonly string[] = [];
  let prompt = "";
  const fakeSpawn = ((executable: string, argv: readonly string[]) => {
    command = executable;
    args = argv;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
    queueMicrotask(() => {
      child.stdout.end("search result");
      child.stderr.end("router diagnostic");
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof spawn;
  const registry = createToolRegistry([createCcrWebExtension({
    command: "ccr",
    profile: "research-profile",
    spawn: fakeSpawn,
  })], { log: () => {} });
  const searchTool = registry.snapshot().tools().find(({ tool }) => tool.name === "web_search")!.tool;
  const result = await searchTool.execute({ query: "term; still stdin" }, {
    conversationId: 1, taskId: 2, callId: "spawn-success",
  } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(command, "ccr");
  assert.deepEqual(args, ccrArguments("research-profile", "web_search"));
  assert.match(prompt, /term; still stdin/);
  assert.equal((result.structuredOutput as { output: string }).output, "search result");

  const failedSpawn = ((executable: string, argv: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end("gateway unavailable");
      child.emit("close", 7, null);
    });
    return child;
  }) as unknown as typeof spawn;
  const failedRegistry = createToolRegistry([createCcrWebExtension({
    command: "ccr",
    profile: "research-profile",
    spawn: failedSpawn,
  })], { log: () => {} });
  const failedTool = failedRegistry.snapshot().tools().find(({ tool }) => tool.name === "web_search")!.tool;
  const failed = await failedTool.execute({ query: "term" }, {
    conversationId: 1, taskId: 2, callId: "spawn-failure",
  } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(failed.isError, true);
  assert.match((failed.structuredOutput as { error: string }).error, /CCR_EXIT_7: gateway unavailable/);
});
