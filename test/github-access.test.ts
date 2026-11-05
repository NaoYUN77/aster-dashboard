import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { McpAbortError } from "@earendil-works/pi-mcp";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { GITHUB_ENDPOINT, GITHUB_TOOL_NAMES, buildGithubApproval } from "../src/github-policy.js";
import { openGithubGate } from "../src/github-gate.js";
import { assertGithubProxy, githubFetch } from "../src/github-transport.js";
import { validateMcpConfig } from "../src/mcp-config.js";
import { connectMcp, listToolsBounded, type McpConnection, type McpToolInfo } from "../src/mcp.js";
import { createToolRegistry } from "../src/tools.js";

function declarations(): McpToolInfo[] {
  const str = { type: "string" }; const num = { type: "integer" }; const repo = { owner: str, repo: str }; const paging = { perPage: num, page: num };
  const fields: Record<string, object> = {
    search_repositories: { query: str, ...paging }, get_file_contents: { ...repo, path: str }, search_code: { query: str, ...paging },
    list_issues: { ...repo, perPage: num, after: str }, search_issues: { query: str, ...paging }, issue_read: { ...repo, ...paging, issue_number: num, method: str },
    list_pull_requests: { ...repo, ...paging }, search_pull_requests: { query: str, ...paging }, pull_request_read: { ...repo, ...paging, pullNumber: num, method: str },
    actions_list: { ...repo, method: str, resource_id: str, perPage: num, page: num }, actions_get: { ...repo, method: str, resource_id: str },
    get_job_logs: { ...repo, job_id: num, run_id: num, return_content: { type: "boolean" }, failed_only: { type: "boolean" }, tail_lines: num },
  };
  return GITHUB_TOOL_NAMES.map(name => ({ name, description: name, inputSchema: { type: "object", properties: fields[name], additionalProperties: false }, annotations: { readOnlyHint: true } }));
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aster-github-"));
  const policy = { approvalVersion: "fixture-v1", baselinePath: join(directory, "approved.json") };
  let current = declarations(); let calls = 0; let lists = 0;
  let changed: (() => void) | undefined;
  const connection: McpConnection = {
    serverName: "github", async listTools() { lists++; return current; },
    async callTool() { calls++; return { content: [{ type: "text", text: "ok" }] }; }, async close() {},
    subscribeAvailability(listener) { listener("available"); return () => {}; },
    subscribeDeclarationChanges(listener) { changed = listener; return () => {}; },
  };
  const server = { name: "github", transport: "http" as const, url: GITHUB_ENDPOINT, headers: { Authorization: "Bearer __vault_GITHUB_MCP_TOKEN__", "X-MCP-Readonly": "true", "X-MCP-Tools": GITHUB_TOOL_NAMES.join(",") }, githubPolicy: policy, timeoutMs: 60_000, connectTimeoutMs: 10_000 };
  return { directory, policy, server, connection, get calls() { return calls; }, get lists() { return lists; }, setTools(tools: McpToolInfo[]) { current = tools; }, changed: () => changed?.(),
    approve: () => writeFile(policy.baselinePath, JSON.stringify(buildGithubApproval(policy, current))), close: () => rm(directory, { recursive: true, force: true }) };
}

test("GitHub config requires placeholder, exact headers, policy, endpoint and no pin/OAuth", async () => {
  const f = await fixture();
  try {
    assert.equal(validateMcpConfig({ servers: [f.server] }).config?.servers.length, 1);
    for (const override of [{ githubPolicy: undefined }, { url: "https://example.invalid/mcp/" }, { auth: { type: "oauth" } }, { timeoutMs: 60_001 }, { headers: { ...f.server.headers, "X-MCP-Toolsets": "all" } }, { headers: { ...f.server.headers, Authorization: "Bearer invalid-fixture" } }]) {
      assert.equal(validateMcpConfig({ servers: [{ ...f.server, ...override }] }).config?.servers.length, 0);
    }
    assert.equal(validateMcpConfig({ servers: [f.server], tools: { mcp__github__search_code: { pin: true } } }).config?.servers.length, 0);
  } finally { await f.close(); }
});

test("first discovery produces a candidate but never authorizes calls", async () => {
  const f = await fixture();
  try {
    const host = await connectMcp({ servers: [f.server] }, { dataDir: f.directory, reserved: new Set(), connect: async () => f.connection, log() {} });
    assert.equal(host.extensions.length, 0); assert.equal(f.calls, 0);
    const candidate = JSON.parse(await readFile(join(f.directory, "github-policy/candidate.json"), "utf8"));
    assert.equal(candidate.tools.length, 12);
    await host.close();
  } finally { await f.close(); }
});

test("loaded owner calls reconcile each time and declaration drift disables all subsequent calls", async () => {
  const f = await fixture();
  try {
    await f.approve();
    const host = await connectMcp({ servers: [f.server] }, { dataDir: f.directory, reserved: new Set(), connect: async () => f.connection, log() {} });
    const registry = createToolRegistry(host.extensions, { log() {} });
    const stop = host.subscribeAvailability((server, state) => registry.setMcpAvailability(server, state));
    const selected = registry.snapshot().tools().find(({ tool }) => tool.name === "mcp__github__search_code")!.tool;
    const api = { conversationId: "fixture", taskId: "task", callId: "call" } as unknown as ToolExecutionApi;
    assert.equal((await selected.execute({ query: "public", perPage: 30 }, api, BACKGROUND_CONTEXT)).isError, false);
    assert.equal(f.calls, 1); assert.equal(f.lists, 2);
    f.setTools(declarations().map(tool => tool.name === "search_code" ? { ...tool, description: "changed without schema change" } : tool));
    assert.equal((await selected.execute({ query: "public", perPage: 30 }, api, BACKGROUND_CONTEXT)).isError, true);
    assert.equal(f.calls, 1); assert.equal(registry.lookup(selected.name)?.state, "unavailable");
    f.setTools(declarations());
    assert.equal((await selected.execute({ query: "public", perPage: 30 }, api, BACKGROUND_CONTEXT)).isError, true);
    assert.equal(f.calls, 1);
    stop(); await host.close();
    await assert.rejects(openGithubGate(f.connection, f.policy, declarations(), f.directory), /GITHUB_APPROVAL_DISABLED/);
  } finally { await f.close(); }
});

test("forbidden actions and log modes never send a business call; busy entry has no queue", async () => {
  const f = await fixture();
  try {
    await f.approve(); const gate = await openGithubGate(f.connection, f.policy, declarations(), f.directory);
    for (const [name, args] of [["actions_run_trigger", {}], ["issue_read", { owner: "o", repo: "r", issue_number: 1, method: "update", perPage: 1 }], ["get_job_logs", { owner: "o", repo: "r", job_id: 1, run_id: 2, return_content: true, failed_only: false, tail_lines: 10 }]] as const) await assert.rejects(gate.call(name, args));
    assert.equal(f.calls, 0); assert.equal(f.lists, 0);
    let release!: () => void;
    const blocked = { ...f.connection, listTools: async () => { await new Promise<void>(resolve => { release = resolve; }); return declarations(); } };
    const serial = await openGithubGate(blocked, f.policy, declarations(), f.directory);
    const first = serial.call("search_code", { query: "public", perPage: 1 });
    await assert.rejects(serial.call("search_code", { query: "public", perPage: 1 }), /GITHUB_BUSY/);
    release(); await first; assert.equal(f.calls, 1);
  } finally { await f.close(); }
});

test("caller cancellation is not treated as declaration drift", async () => {
  const f = await fixture();
  try {
    await f.approve();
    let calls = 0;
    const cancelling: McpConnection = {
      ...f.connection,
      async callTool() { calls++; if (calls === 1) throw new McpAbortError(); return { content: [{ type: "text", text: "ok" }] }; },
    };
    const gate = await openGithubGate(cancelling, f.policy, declarations(), f.directory);
    await assert.rejects(gate.call("search_code", { query: "public", perPage: 1 }));
    assert.deepEqual(await gate.call("search_code", { query: "public", perPage: 1 }), { content: [{ type: "text", text: "ok" }] });
    await assert.rejects(readFile(join(f.directory, "github-policy/disabled.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("strict discovery preserves all declaration fields and rejects malformed or truncated lists", async () => {
  const tools = declarations();
  const client = { request: async () => ({ tools }) };
  assert.deepEqual(await listToolsBounded(client as never, 1000, undefined, undefined, true), tools);
  await assert.rejects(listToolsBounded({ request: async () => ({ tools: [null] }) } as never, 1000, undefined, undefined, true));
  await assert.rejects(listToolsBounded({ request: async () => ({ tools, nextCursor: "next" }) } as never, 1000, undefined, undefined, true));
});

test("GitHub fetch refuses redirects, forwards cancellation, and cumulatively bounds SSE", async () => {
  const controller = new AbortController(); const scope = { signal: controller.signal, received: 0 };
  let observed: RequestInit | undefined; let cancelled = false;
  const fake = async (_input: unknown, init?: RequestInit) => {
    observed = init;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  };
  const request = githubFetch(() => scope, fake as typeof fetch);
  const response = await request(GITHUB_ENDPOINT, { method: "POST" });
  assert.equal(observed?.redirect, "error"); controller.abort(); assert.equal(observed?.signal?.aborted, true);
  await assert.rejects(response.arrayBuffer(), /exceeds 1 MiB/); assert.equal(cancelled, true);
  await assert.rejects(request("https://example.invalid/", {}));
});

test("GitHub requires proxy and CA without wildcard or suffix bypass", () => {
  const env = { HTTPS_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: "/ca.pem" };
  assertGithubProxy(env);
  for (const NO_PROXY of ["*", "githubcopilot.com", ".githubcopilot.com", "api.githubcopilot.com:443"]) assert.throws(() => assertGithubProxy({ ...env, NO_PROXY }));
  assert.throws(() => assertGithubProxy({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
});
