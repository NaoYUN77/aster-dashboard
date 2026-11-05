import assert from "node:assert/strict";
import test from "node:test";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import {
  GITHUB_ENDPOINT, GITHUB_TOOL_NAMES, buildGithubApproval, githubCanonical, githubEffectiveTool,
  githubRegisteredName, githubValidateArguments, parseGithubPolicy, verifyGithubApproval,
} from "../src/github-policy.js";

type Json = Record<string, unknown>;
const policy = { approvalVersion: "github-read-v1", baselinePath: "/var/lib/aster/github-approval.json" };
const str = { type: "string" };
const num = { type: "number" };
const paging = { page: num, perPage: num };
const repo = { owner: str, repo: str };
const issueMethods = ["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"];
const prMethods = ["get", "get_diff", "get_status", "get_files", "get_commits", "get_review_comments", "get_reviews", "get_comments", "get_check_runs"];
const listMethods = ["list_workflows", "list_workflow_runs", "list_workflow_jobs"];
const getMethods = ["get_workflow", "get_workflow_run", "get_workflow_job"];

// Offline contract fixtures, deliberately broader than the approved operations. These are not a
// captured or approved hosted-server tools/list response and do not assert live compatibility.
function fixtures(): Json[] {
  const fields: Record<string, Json> = {
    search_repositories: { query: str, ...paging, sort: str, order: str, minimal_output: { type: "boolean" } },
    get_file_contents: { ...repo, path: str, ref: str, sha: str },
    search_code: { query: str, ...paging, sort: str, order: str },
    list_issues: { ...repo, perPage: num, after: str, state: str, labels: { type: "array", items: str }, orderBy: str, direction: str, since: str },
    search_issues: { query: str, ...paging },
    issue_read: { ...repo, ...paging, issue_number: num, method: { type: "string", enum: [...issueMethods, "update"] } },
    list_pull_requests: { ...repo, ...paging, state: str, head: str, base: str, sort: str, direction: str },
    search_pull_requests: { query: str, ...paging },
    pull_request_read: { ...repo, ...paging, after: str, pullNumber: num, method: { type: "string", enum: [...prMethods, "merge"] } },
    actions_list: { ...repo, page: num, perPage: num, resource_id: str, method: { type: "string", enum: [...listMethods, "list_artifacts"] } },
    actions_get: { ...repo, resource_id: str, method: { type: "string", enum: [...getMethods, "get_workflow_run_logs_url"] } },
    get_job_logs: { ...repo, job_id: num, run_id: num, return_content: { type: "boolean", default: false }, failed_only: { type: "boolean", default: true }, tail_lines: num },
  };
  return GITHUB_TOOL_NAMES.map(name => ({
    name, description: `Upstream ${name}, potentially unsafe options`,
    inputSchema: { type: "object", properties: fields[name], additionalProperties: false },
    outputSchema: { type: "object", properties: { result: str } },
    annotations: { readOnlyHint: false, destructiveHint: true },
    _meta: { fixture: "offline", ordered: ["a", "b"] },
  }));
}
function declaration(name: string): Json { return fixtures().find(tool => tool.name === name)!; }
function schema(raw: Json): Json { return raw.inputSchema as Json; }
function effectiveCheck(name: string, args: Json): boolean {
  return Compile(githubEffectiveTool(declaration(name)).inputSchema as TSchema).Check(args);
}
function rejects(fn: () => unknown, code?: string): void {
  assert.throws(fn, error => error instanceof Error && /^GITHUB_[A-Z_]+$/u.test(String((error as Error & { code: string }).code))
    && (!code || (error as Error & { code: string }).code === code));
}

test("strict policy parser requires bounded version and an absolute baseline path", () => {
  assert.deepEqual(parseGithubPolicy(policy), policy);
  assert.deepEqual(parseGithubPolicy({ ...policy, baselinePath: "E:/data/approved.json" }).baselinePath, "E:/data/approved.json");
  for (const value of [null, [], {}, { ...policy, other: true }, { approvalVersion: "v1" }, { ...policy, baselinePath: "relative.json" },
    { ...policy, approvalVersion: " " }, { ...policy, approvalVersion: "x".repeat(129) }, { ...policy, approvalVersion: "v1\n" },
    { ...policy, baselinePath: "C:relative.json" }, { ...policy, baselinePath: "/data/\0.json" }]) rejects(() => parseGithubPolicy(value), "GITHUB_POLICY_INVALID");
});

test("exact identities have deterministic names with no aliases or normalization", () => {
  assert.equal(GITHUB_ENDPOINT, "https://api.githubcopilot.com/mcp/");
  assert.equal(GITHUB_TOOL_NAMES.length, 12);
  for (const name of GITHUB_TOOL_NAMES) assert.equal(githubRegisteredName(name), `mcp__github__${name}`);
  for (const name of ["actions_run_trigger", "Search_Code", "search-code", "mcp__github__search_code", "search_code "]) rejects(() => githubRegisteredName(name), "GITHUB_TOOL_DENIED");
});

test("all twelve offline tools adapt with complete raw and effective declarations", () => {
  const raw = fixtures();
  const before = githubCanonical(raw);
  const approval = buildGithubApproval(policy, raw) as Json;
  assert.equal(approval.formatVersion, 1);
  assert.equal(approval.server, "github");
  assert.equal(approval.endpoint, GITHUB_ENDPOINT);
  const entries = approval.tools as Json[];
  assert.equal(entries.length, 12);
  for (const entry of entries) {
    assert.equal(entry.registeredName, `mcp__github__${entry.rawName}`);
    assert.deepEqual(entry.raw, raw.find(tool => tool.name === entry.rawName));
    assert.deepEqual((entry.effective as Json).outputSchema, (entry.raw as Json).outputSchema);
    assert.deepEqual((entry.effective as Json)._meta, (entry.raw as Json)._meta);
    assert.notEqual((entry.effective as Json).description, (entry.raw as Json).description);
    assert.equal(schema(entry.effective as Json).additionalProperties, false);
  }
  assert.equal(githubCanonical(raw), before, "input declarations must not be mutated");
  verifyGithubApproval(policy, raw, approval);
  verifyGithubApproval(policy, [...raw].reverse(), approval);
});

test("canonical comparison sorts object keys while retaining every array order", () => {
  assert.equal(githubCanonical({ z: { b: 2, a: 1 }, a: [3, 2] }), '{"a":[3,2],"z":{"a":1,"b":2}}');
  assert.notEqual(githubCanonical([1, 2]), githubCanonical([2, 1]));
  const cycle: Json = {}; cycle.self = cycle;
  for (const value of [cycle, undefined, { x: undefined }, NaN, Infinity, 1n, new Date(), new Array(2), { x: () => "value" }]) rejects(() => githubCanonical(value));
  rejects(() => githubCanonical(Object.defineProperty({}, "x", { enumerable: true, get() { throw new Error("sensitive"); } })));
});

test("approval rejects missing, extra, duplicate tools and never approves first observation", () => {
  const raw = fixtures();
  rejects(() => verifyGithubApproval(policy, raw, undefined), "GITHUB_APPROVAL_REQUIRED");
  rejects(() => buildGithubApproval(policy, raw.slice(1)), "GITHUB_TOOL_SET_INVALID");
  rejects(() => buildGithubApproval(policy, [...raw, raw[0]!]), "GITHUB_TOOL_SET_INVALID");
  rejects(() => buildGithubApproval(policy, [raw[0]!, ...raw.slice(0, -1)]), "GITHUB_TOOL_SET_INVALID");
  rejects(() => buildGithubApproval(policy, [...raw.slice(1), { ...raw[0], name: "actions_run_trigger" }]), "GITHUB_TOOL_DENIED");
});

test("any raw, effective, policy, identity, or version drift invalidates approval", () => {
  const raw = fixtures();
  const baseline = buildGithubApproval(policy, raw);
  const changes: ((copy: Json) => void)[] = [
    value => { value.approvalVersion = "v2"; },
    value => { value.endpoint = "https://example.invalid/mcp/"; },
    value => { value.extra = true; },
    value => { ((value.tools as Json[])[0]!).registeredName = "alias"; },
    value => { (((value.tools as Json[])[0]!).raw as Json).description = "changed"; },
    value => { (((value.tools as Json[])[0]!).effective as Json).description = "changed"; },
    value => { ((((value.tools as Json[])[0]!).raw as Json)._meta as Json).ordered = ["b", "a"]; },
    value => { (((value.tools as Json[])[0]!).raw as Json).outputSchema = { type: "string" }; },
    value => { (value.policy as Json).pageSize = 100; },
  ];
  for (const change of changes) {
    const copy = structuredClone(baseline) as Json; change(copy);
    rejects(() => verifyGithubApproval(policy, raw, copy), "GITHUB_APPROVAL_MISMATCH");
  }
  const changedRaw = fixtures(); changedRaw[0]!.annotations = { readOnlyHint: true };
  rejects(() => verifyGithubApproval(policy, changedRaw, baseline), "GITHUB_APPROVAL_MISMATCH");
  rejects(() => verifyGithubApproval({ ...policy, approvalVersion: "v2" }, raw, baseline), "GITHUB_APPROVAL_MISMATCH");
});

test("only explicitly allowed read methods pass both schema and execution validation", () => {
  for (const [name, methods, key] of [["issue_read", issueMethods, "issue_number"], ["pull_request_read", prMethods, "pullNumber"]] as const) {
    for (const method of methods) {
      const args = { owner: "public-owner", repo: "unlisted-public-repo", [key]: 1, method, perPage: 30 };
      githubValidateArguments(name, args);
      githubValidateArguments(githubRegisteredName(name), args);
      assert.equal(effectiveCheck(name, args), true);
    }
    for (const method of ["update", "merge", "get_new_read_method", "GET", ""]) {
      const args = { owner: "o", repo: "r", [key]: 1, method, perPage: 1 };
      rejects(() => githubValidateArguments(name, args), "GITHUB_ARGUMENTS_INVALID");
      assert.equal(effectiveCheck(name, args), false);
    }
  }
});

test("workflow/run/job resource mapping is operation-specific", () => {
  const base = { owner: "o", repo: "r", perPage: 30 };
  const validList = [
    { ...base, method: "list_workflows" }, { ...base, method: "list_workflow_runs" },
    { ...base, method: "list_workflow_runs", resource_id: "build.yml" },
    { ...base, method: "list_workflow_jobs", resource_id: "123" },
  ];
  for (const args of validList) { githubValidateArguments("actions_list", args); assert.equal(effectiveCheck("actions_list", args), true); }
  for (const args of [
    { ...base, method: "list_workflows", resource_id: "1" },
    { ...base, method: "list_workflow_jobs" }, { ...base, method: "list_workflow_jobs", resource_id: "build.yml" },
    { ...base, method: "list_artifacts" },
  ]) { rejects(() => githubValidateArguments("actions_list", args)); assert.equal(effectiveCheck("actions_list", args), false); }
  for (const method of getMethods) {
    const args = { owner: "o", repo: "r", method, resource_id: method === "get_workflow" ? "build.yml" : "123" };
    githubValidateArguments("actions_get", args); assert.equal(effectiveCheck("actions_get", args), true);
    rejects(() => githubValidateArguments("actions_get", { owner: "o", repo: "r", method }));
  }
  for (const method of ["get_workflow_run", "get_workflow_job"]) rejects(() => githubValidateArguments("actions_get", { owner: "o", repo: "r", method, resource_id: "build.yml" }));
});

test("cursor pagination and issue ordering enforce method and paired-field rules", () => {
  const pr = { owner: "o", repo: "r", pullNumber: 1, perPage: 30 };
  for (const args of [
    { ...pr, method: "get_review_comments", after: "next" },
    { ...pr, method: "get_comments", page: 2 },
  ]) {
    githubValidateArguments("pull_request_read", args);
    assert.equal(effectiveCheck("pull_request_read", args), true);
  }
  for (const args of [
    { ...pr, method: "get_review_comments", page: 2 },
    { ...pr, method: "get_comments", after: "next" },
  ]) {
    rejects(() => githubValidateArguments("pull_request_read", args));
    assert.equal(effectiveCheck("pull_request_read", args), false);
  }
  const issues = { owner: "o", repo: "r", perPage: 30 };
  githubValidateArguments("list_issues", { ...issues, orderBy: "CREATED_AT", direction: "ASC" });
  for (const args of [{ ...issues, orderBy: "CREATED_AT" }, { ...issues, direction: "ASC" }]) {
    rejects(() => githubValidateArguments("list_issues", args));
    assert.equal(effectiveCheck("list_issues", args), false);
  }
});

test("effective declarations remove disabled enums, fields, and misleading upstream prose", () => {
  for (const [name, forbidden] of [["issue_read", "update"], ["pull_request_read", "merge"], ["actions_list", "list_artifacts"]]) {
    const raw = declaration(name!);
    (schema(raw).properties as Json).token = { type: "string", description: "Pass secrets here" };
    ((schema(raw).properties as Json).method as Json).description = `Use ${forbidden}`;
    const effective = githubEffectiveTool(raw);
    const serialized = githubCanonical(effective.inputSchema);
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
    assert.equal(serialized.includes("Pass secrets here"), false);
    assert.equal(serialized.includes('"token"'), false);
  }
  assert.equal(effectiveCheck("get_file_contents", { owner: "o", repo: "r", path: "" }), true);
});

test("logs require one job and explicit bounded content mode in schema and runtime", () => {
  const args = { owner: "o", repo: "r", job_id: 1, return_content: true, failed_only: false, tail_lines: 200 };
  githubValidateArguments("get_job_logs", args);
  assert.equal(effectiveCheck("get_job_logs", args), true);
  for (const patch of [{ run_id: 1 }, { tail_lines: 0 }, { tail_lines: 201 }, { tail_lines: 1.5 }, { return_content: false }, { failed_only: true }, { job_id: 0 }]) {
    const invalid = { ...args, ...patch };
    rejects(() => githubValidateArguments("get_job_logs", invalid));
    assert.equal(effectiveCheck("get_job_logs", invalid), false);
  }
  for (const key of Object.keys(args)) {
    const copy: Json = { ...args }; delete copy[key];
    rejects(() => githubValidateArguments("get_job_logs", copy));
    assert.equal(effectiveCheck("get_job_logs", copy), false);
  }
});

test("pagination, query bytes, identifiers and unknown fields reject malformed arguments", () => {
  githubValidateArguments("search_code", { query: "x".repeat(4096), perPage: 30, page: 1 });
  githubValidateArguments("list_issues", { owner: "o", repo: "r", perPage: 1, after: "x".repeat(4096) });
  for (const args of [
    { query: "x", perPage: 31 }, { query: "x", perPage: 0 }, { query: "x", perPage: 1.5 }, { query: "x" },
    { query: "x", perPage: 1, page: 0 }, { query: "x", perPage: 1, page: 1.5 }, { query: "x", perPage: 1, page: Number.MAX_SAFE_INTEGER + 1 },
    { query: "x".repeat(4097), perPage: 1 }, { query: "界".repeat(1366), perPage: 1 },
    { query: "x", perPage: 1, endpoint: "https://example.invalid" }, { query: "x", perPage: 1, token: "offline-secret-marker" },
    { query: "x", perPage: "1" }, { query: "", perPage: 1 },
  ]) rejects(() => githubValidateArguments("search_code", args));
  rejects(() => githubValidateArguments("list_issues", { owner: "o", repo: "r", perPage: 30, after: "界".repeat(1366) }));
  rejects(() => githubValidateArguments("issue_read", { owner: "o", repo: "r", issue_number: -1, method: "get", perPage: 1 }));
  rejects(() => githubValidateArguments("actions_run_trigger", {}), "GITHUB_TOOL_DENIED");
});

test("upstream constraints are retained and unsupported schemas reject the entire set", () => {
  const raw = declaration("search_code");
  (schema(raw).properties as Json).query = { type: "string", maxLength: 10 };
  const adapted = githubEffectiveTool(raw);
  const validator = Compile(adapted.inputSchema as TSchema);
  assert.equal(validator.Check({ query: "x".repeat(10), perPage: 1 }), true);
  assert.equal(validator.Check({ query: "x".repeat(11), perPage: 1 }), false);
  const invalid: ((value: Json) => void)[] = [
    value => { schema(value).$ref = "#/$defs/schema"; },
    value => { schema(value).unevaluatedProperties = false; },
    value => { schema(value).properties = { query: { type: "string", pattern: "[" } }; },
    value => { schema(value).required = ["unknown_required_field"]; },
    value => { schema(value).allOf = [{ required: ["query"] }]; },
    value => { schema(value).type = "array"; },
    value => { delete (schema(value).properties as Json).perPage; },
    value => { schema(value).description = "x".repeat(16_384); },
    value => { schema(value).properties = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, str])); },
    value => { value.description = "x".repeat(128 * 1024); },
    value => { value.outputSchema = { type: "object", properties: { result: { $ref: "#/x" } } }; },
  ];
  for (const mutate of invalid) {
    const copy = fixtures(); mutate(copy[0]!);
    rejects(() => buildGithubApproval(policy, copy));
  }
  for (const name of ["issue_read", "pull_request_read", "actions_list", "actions_get"] as const) {
    const copy = fixtures();
    const tool = copy.find(tool => tool.name === name)!;
    ((schema(tool).properties as Json).method as Json).enum = ["get"];
    rejects(() => buildGithubApproval(policy, copy), "GITHUB_SCHEMA_UNSUPPORTED");
  }
  const logs = fixtures();
  delete (schema(logs.find(tool => tool.name === "get_job_logs")!).properties as Json).tail_lines;
  rejects(() => buildGithubApproval(policy, logs), "GITHUB_SCHEMA_UNSUPPORTED");
});

test("deep/cyclic data and unsafe diagnostics cannot expose argument or declaration values", () => {
  let deep: Json = { type: "string" };
  for (let i = 0; i < 5_000; i++) deep = { type: "object", properties: { child: deep } };
  rejects(() => githubEffectiveTool({ name: "search_code", inputSchema: deep }));
  const marker = "offline-sensitive-body-marker";
  try { githubValidateArguments("get_job_logs", { body: marker }); assert.fail("expected rejection"); }
  catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(marker), false);
    assert.equal(error.stack?.includes(marker), false);
  }
});
