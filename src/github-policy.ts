import { isAbsolute, win32 } from "node:path";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

export const GITHUB_ENDPOINT = "https://api.githubcopilot.com/mcp/";
export const GITHUB_TOOL_NAMES = Object.freeze([
  "search_repositories", "get_file_contents", "search_code", "list_issues", "search_issues", "issue_read",
  "list_pull_requests", "search_pull_requests", "pull_request_read", "actions_list", "actions_get", "get_job_logs",
] as const);
export type GithubPolicyConfig = { approvalVersion: string; baselinePath: string };
type ToolName = typeof GITHUB_TOOL_NAMES[number];
type Schema = Record<string, unknown>;

const ISSUE_METHODS = ["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"];
const PR_METHODS = ["get", "get_diff", "get_status", "get_files", "get_commits", "get_review_comments", "get_reviews", "get_comments", "get_check_runs"];
const LIST_METHODS = ["list_workflows", "list_workflow_runs", "list_workflow_jobs"];
const GET_METHODS = ["get_workflow", "get_workflow_run", "get_workflow_job"];
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_DECLARATION_BYTES = 128 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const identifier = { type: "string", minLength: 1, maxLength: 256 };
const text = { type: "string", minLength: 1, maxLength: 4096 };
const positive = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const pagination = { page: positive, perPage: { type: "integer", minimum: 1, maximum: 30 } };
const cursor = { after: text, perPage: pagination.perPage };
const repo = { owner: identifier, repo: identifier };
const strings = { type: "array", maxItems: 30, items: identifier };
const enumeration = (...values: string[]): Schema => ({ type: "string", enum: values });

// Only these model-controlled fields are supported. Optional upstream additions are removed;
// required additions reject adaptation. No credentials, endpoint, or execution context are arguments.
const CONTRACTS: Record<ToolName, { fields: Schema; required: string[]; methods?: string[]; description: string }> = {
  search_repositories: { fields: { query: text, ...pagination, sort: enumeration("stars", "forks", "help-wanted-issues", "updated"), order: enumeration("asc", "desc"), minimal_output: { type: "boolean" } }, required: ["query"], description: "Search GitHub repositories, including public repositories; one page of at most 30 results." },
  get_file_contents: { fields: { ...repo, path: { type: "string", maxLength: 4096 }, ref: text, sha: identifier }, required: ["owner", "repo"], description: "Read a GitHub repository directory or file at an optional ref or commit SHA. Returned links are not downloaded automatically." },
  search_code: { fields: { query: text, ...pagination, sort: enumeration("indexed"), order: enumeration("asc", "desc") }, required: ["query"], description: "Search GitHub code; one page of at most 30 results. Returned links are not downloaded automatically." },
  list_issues: { fields: { ...repo, ...cursor, state: enumeration("OPEN", "CLOSED"), labels: strings, orderBy: enumeration("CREATED_AT", "UPDATED_AT", "COMMENTS"), direction: enumeration("ASC", "DESC"), since: text }, required: ["owner", "repo"], description: "List GitHub issues; one explicit page of at most 30 results, with an optional continuation cursor. orderBy and direction must be provided together." },
  search_issues: { fields: { query: text, ...pagination, owner: identifier, repo: identifier, sort: enumeration("comments", "reactions", "reactions-+1", "reactions--1", "reactions-smile", "reactions-thinking_face", "reactions-heart", "reactions-tada", "interactions", "created", "updated"), order: enumeration("asc", "desc") }, required: ["query"], description: "Search GitHub issues; one page of at most 30 results." },
  issue_read: { fields: { ...repo, ...pagination, method: enumeration(...ISSUE_METHODS), issue_number: positive }, required: ["owner", "repo", "method", "issue_number"], methods: ISSUE_METHODS, description: `Read a GitHub issue using only: ${ISSUE_METHODS.join(", ")}. At most 30 results per explicit page.` },
  list_pull_requests: { fields: { ...repo, ...pagination, state: enumeration("open", "closed", "all"), head: identifier, base: identifier, sort: enumeration("created", "updated", "popularity", "long-running"), direction: enumeration("asc", "desc") }, required: ["owner", "repo"], description: "List GitHub pull requests; one page of at most 30 results." },
  search_pull_requests: { fields: { query: text, ...pagination, owner: identifier, repo: identifier, sort: enumeration("comments", "reactions", "reactions-+1", "reactions--1", "reactions-smile", "reactions-thinking_face", "reactions-heart", "reactions-tada", "interactions", "created", "updated"), order: enumeration("asc", "desc") }, required: ["query"], description: "Search GitHub pull requests; one page of at most 30 results." },
  pull_request_read: { fields: { ...repo, ...pagination, after: text, method: enumeration(...PR_METHODS), pullNumber: positive }, required: ["owner", "repo", "method", "pullNumber"], methods: PR_METHODS, description: `Read a GitHub pull request using only: ${PR_METHODS.join(", ")}. At most 30 results per explicit page. Only get_review_comments accepts after and forbids page; other methods forbid after.` },
  actions_list: { fields: { ...repo, method: enumeration(...LIST_METHODS), resource_id: identifier, ...pagination }, required: ["owner", "repo", "method"], methods: LIST_METHODS, description: "List GitHub Actions workflows, workflow runs, or jobs. resource_id is forbidden for list_workflows, optional (workflow ID or filename) for list_workflow_runs, and required (run ID) for list_workflow_jobs. One page of at most 30 results; no artifacts." },
  actions_get: { fields: { ...repo, method: enumeration(...GET_METHODS), resource_id: identifier }, required: ["owner", "repo", "method", "resource_id"], methods: GET_METHODS, description: "Get one GitHub Actions workflow, workflow run, or workflow job. resource_id identifies respectively a workflow ID or filename, run ID, or job ID. No usage, artifacts, or log URLs." },
  get_job_logs: { fields: { ...repo, job_id: positive, return_content: { type: "boolean", const: true }, failed_only: { type: "boolean", const: false }, tail_lines: { type: "integer", minimum: 1, maximum: 200 } }, required: ["owner", "repo", "job_id", "return_content", "failed_only", "tail_lines"], description: "Read the tail of exactly one GitHub Actions job: job_id required, return_content=true, failed_only=false, explicit tail_lines from 1 to 200. No run_id, bulk logs, archives, artifacts, or downloads." },
};

function fail(code: string): never {
  throw Object.assign(new Error(`GitHub policy rejected the operation (${code}).`), { code });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function toolName(value: unknown): ToolName {
  if (typeof value !== "string" || !(GITHUB_TOOL_NAMES as readonly string[]).includes(value)) fail("GITHUB_TOOL_DENIED");
  return value as ToolName;
}

export function parseGithubPolicy(value: unknown): GithubPolicyConfig {
  if (!record(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "approvalVersion") || !Object.hasOwn(value, "baselinePath")) fail("GITHUB_POLICY_INVALID");
  const { approvalVersion, baselinePath } = value;
  if (typeof approvalVersion !== "string" || !approvalVersion.trim() || approvalVersion !== approvalVersion.trim()
    || Buffer.byteLength(approvalVersion) > 128 || /[\u0000-\u001f\u007f]/u.test(approvalVersion)) fail("GITHUB_POLICY_INVALID");
  if (typeof baselinePath !== "string" || !baselinePath.trim() || Buffer.byteLength(baselinePath) > 4096
    || /[\u0000-\u001f\u007f]/u.test(baselinePath) || !(isAbsolute(baselinePath) || win32.isAbsolute(baselinePath))) fail("GITHUB_POLICY_INVALID");
  return { approvalVersion, baselinePath };
}

export function githubRegisteredName(raw: string): string {
  return `mcp__github__${toolName(raw)}`;
}

/** Canonical JSON, with bounded traversal before serialization; arrays retain their order. */
export function githubCanonical(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 32) fail("GITHUB_DECLARATION_INVALID");
    let result: string;
    if (entry === null || typeof entry === "boolean") result = JSON.stringify(entry);
    else if (typeof entry === "string") {
      if (Buffer.byteLength(entry) > MAX_JSON_BYTES) fail("GITHUB_DECLARATION_INVALID");
      result = JSON.stringify(entry);
    } else if (typeof entry === "number" && Number.isFinite(entry)) result = JSON.stringify(entry);
    else if (Array.isArray(entry) || record(entry)) {
      if (ancestors.has(entry)) fail("GITHUB_DECLARATION_INVALID");
      ancestors.add(entry);
      const keys = Object.keys(entry);
      if (Object.getOwnPropertySymbols(entry).length || keys.some(key => !Object.getOwnPropertyDescriptor(entry, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(entry, key)!, "value"))) fail("GITHUB_DECLARATION_INVALID");
      if (Array.isArray(entry)) {
        if (entry.length > 100_000 || keys.length !== entry.length || keys.some((key, i) => key !== String(i))) fail("GITHUB_DECLARATION_INVALID");
        result = `[${entry.map(item => visit(item, depth + 1)).join(",")}]`;
      } else result = `{${keys.sort().map(key => `${JSON.stringify(key)}:${visit(entry[key], depth + 1)}`).join(",")}}`;
      ancestors.delete(entry);
    } else fail("GITHUB_DECLARATION_INVALID");
    bytes += Buffer.byteLength(result);
    // Nested strings are counted repeatedly, conservatively bounding allocation as well as output.
    if (bytes > MAX_JSON_BYTES * 8 || Buffer.byteLength(result) > MAX_JSON_BYTES) fail("GITHUB_DECLARATION_INVALID");
    return result;
  };
  return visit(value, 0);
}

const SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "oneOf", "not", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "description", "title", "default", "examples", "$schema"]);
function checkSchema(schema: unknown): asserts schema is Schema {
  if (!record(schema)) fail("GITHUB_SCHEMA_UNSUPPORTED");
  let properties = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12) fail("GITHUB_SCHEMA_UNSUPPORTED");
    if (Array.isArray(value)) { for (const entry of value) walk(entry, depth + 1); return; }
    if (!record(value)) return;
    if (Object.hasOwn(value, "$ref")) fail("GITHUB_SCHEMA_UNSUPPORTED");
    for (const [key, entry] of Object.entries(value)) {
      if (key === "properties" && record(entry)) {
        properties += Object.keys(entry).length;
        if (properties > 256) fail("GITHUB_SCHEMA_UNSUPPORTED");
      }
      walk(entry, depth + 1);
    }
  };
  walk(schema, 0);
  if (Buffer.byteLength(githubCanonical(schema)) > MAX_SCHEMA_BYTES) fail("GITHUB_SCHEMA_UNSUPPORTED");
  const keywords = (node: unknown): void => {
    if (typeof node === "boolean") return;
    if (!record(node) || Object.keys(node).some(key => !SCHEMA_KEYS.has(key))) fail("GITHUB_SCHEMA_UNSUPPORTED");
    if (node.type !== undefined && !(typeof node.type === "string" && ["object", "array", "string", "integer", "number", "boolean", "null"].includes(node.type))) fail("GITHUB_SCHEMA_UNSUPPORTED");
    if (node.properties !== undefined) {
      if (!record(node.properties)) fail("GITHUB_SCHEMA_UNSUPPORTED");
      for (const child of Object.values(node.properties)) keywords(child);
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(key => typeof key !== "string") || new Set(node.required).size !== node.required.length)) fail("GITHUB_SCHEMA_UNSUPPORTED");
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") fail("GITHUB_SCHEMA_UNSUPPORTED");
    if (node.items !== undefined) keywords(node.items);
    for (const key of ["anyOf", "allOf", "oneOf"]) if (node[key] !== undefined) {
      if (!Array.isArray(node[key]) || node[key].length === 0) fail("GITHUB_SCHEMA_UNSUPPORTED");
      for (const child of node[key]) keywords(child);
    }
    if (node.not !== undefined) keywords(node.not);
  };
  keywords(schema);
  try { Compile(schema as TSchema); } catch { fail("GITHUB_SCHEMA_UNSUPPORTED"); }
}

function conditions(name: ToolName): Schema[] {
  const result: Schema[] = [];
  if (name === "actions_list") {
    result.push({ anyOf: [
      { properties: { method: { const: "list_workflows" } }, not: { required: ["resource_id"] } },
      { properties: { method: { const: "list_workflow_runs" } } },
      { properties: { method: { const: "list_workflow_jobs" }, resource_id: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 15 } }, required: ["resource_id"] },
    ] });
  }
  if (name === "list_issues") result.push({ anyOf: [
    { required: ["orderBy", "direction"] },
    { not: { anyOf: [{ required: ["orderBy"] }, { required: ["direction"] }] } },
  ] });
  if (name === "pull_request_read") result.push({ anyOf: [
    { properties: { method: { const: "get_review_comments" } }, not: { required: ["page"] } },
    { properties: { method: { not: { const: "get_review_comments" } } }, not: { required: ["after"] } },
  ] });
  if (name === "actions_get") result.push({ anyOf: [
    { properties: { method: { const: "get_workflow" } } },
    { properties: { method: { enum: ["get_workflow_run", "get_workflow_job"] }, resource_id: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 15 } } },
  ] });
  return result;
}
function hostSchema(name: ToolName, fields = CONTRACTS[name].fields): Schema {
  const required = [...CONTRACTS[name].required];
  // Explicit sizes avoid reliance on an upstream omitted-argument default.
  for (const key of ["perPage", "per_page"]) if (Object.hasOwn(fields, key)) required.push(key);
  return { type: "object", properties: fields, required, additionalProperties: false, ... (conditions(name).length ? { allOf: conditions(name) } : {}) };
}

export function githubEffectiveTool(raw: Record<string, unknown>): Record<string, unknown> {
  const serialized = githubCanonical(raw);
  if (Buffer.byteLength(serialized) > MAX_DECLARATION_BYTES) fail("GITHUB_DECLARATION_INVALID");
  const snapshot = JSON.parse(serialized) as Schema;
  const name = toolName(snapshot.name);
  checkSchema(snapshot.inputSchema);
  if (snapshot.outputSchema !== undefined) checkSchema(snapshot.outputSchema);
  const source = snapshot.inputSchema;
  // Root compositions can conditionally require removed fields or couple operations in ways this
  // adapter cannot establish as complete. Reject rather than silently advertise partial coverage.
  if (source.type !== "object" || !record(source.properties) || ["anyOf", "allOf", "oneOf", "not"].some(key => Object.hasOwn(source, key))) fail("GITHUB_SCHEMA_UNSUPPORTED");
  const sourceProperties = source.properties as Schema;
  const contract = CONTRACTS[name];
  const sourceRequired = (source.required ?? []) as string[];
  const allowedFields: Schema = {};
  for (const [key, field] of Object.entries(contract.fields)) if (Object.hasOwn(source.properties, key)) allowedFields[key] = field;
  for (const key of [...contract.required, ...sourceRequired]) if (!Object.hasOwn(allowedFields, key)) fail("GITHUB_SCHEMA_UNSUPPORTED");
  if (name === "actions_list" && !Object.hasOwn(allowedFields, "resource_id")) fail("GITHUB_SCHEMA_UNSUPPORTED");
  for (const key of ["perPage", "per_page"]) if (Object.hasOwn(contract.fields, key) && !Object.hasOwn(allowedFields, key)) fail("GITHUB_SCHEMA_UNSUPPORTED");
  const narrowed = hostSchema(name, allowedFields);
  const properties = Object.fromEntries(Object.entries(allowedFields).map(([key, field]) => {
    const upstream = effectiveField(sourceProperties[key], field);
    return [key, { allOf: [upstream, field] }];
  }));
  const required = [...new Set([...(narrowed.required as string[]), ...sourceRequired])];
  const sourceConstraints = Object.fromEntries(Object.entries(source).filter(([key]) => !["properties", "required", "description", "title", "default", "examples"].includes(key)));
  const effectiveSchema: Schema = { ...sourceConstraints, ...narrowed, properties, required };
  checkSchema(effectiveSchema);
  // Prove the required operation set and bounded log mode have a witness. Unfamiliar upstream
  // constraints conservatively reject this capability; raw declarations remain approval evidence.
  const compiled = Compile(effectiveSchema as TSchema);
  const sample: Schema = {};
  for (const key of required) {
    const field = allowedFields[key] as Schema;
    sample[key] = field.const ?? (Array.isArray(field.enum) ? field.enum[0] : field.type === "integer" ? 1 : field.type === "boolean" ? false : "example");
  }
  for (const method of contract.methods ?? [undefined]) {
    const args: Schema = { ...sample, ...(method === undefined ? {} : { method }) };
    if (name === "actions_list" && method === "list_workflow_jobs") args.resource_id = resourceSample(source.properties.resource_id);
    if (name === "actions_get") args.resource_id = resourceSample(source.properties.resource_id);
    if (!compiled.Check(args)) fail("GITHUB_SCHEMA_UNSUPPORTED");
  }
  return { ...snapshot, description: contract.description, inputSchema: effectiveSchema };
}
function effectiveField(upstream: unknown, allowed: unknown): unknown {
  const check = Compile(allowed as TSchema);
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (!record(value)) return value;
    const result: Schema = {};
    for (const [key, entry] of Object.entries(value)) {
      if (["description", "title", "default", "examples"].includes(key)) continue;
      if (key === "enum" && Array.isArray(entry)) {
        const narrowed = entry.filter(item => check.Check(item));
        if (!narrowed.length) fail("GITHUB_SCHEMA_UNSUPPORTED");
        result[key] = narrowed;
      } else if (key === "const") {
        if (!check.Check(entry)) fail("GITHUB_SCHEMA_UNSUPPORTED");
        result[key] = entry;
      } else result[key] = clean(entry);
    }
    return result;
  };
  return clean(upstream);
}
function resourceSample(schema: unknown): string | number {
  return record(schema) && (schema.type === "number" || schema.type === "integer") ? 1 : "1";
}

const validators = new Map(GITHUB_TOOL_NAMES.map(name => [name, Compile(hostSchema(name) as TSchema)]));
export function githubValidateArguments(name: string, args: Record<string, unknown>): void {
  const rawName = toolName(name.startsWith("mcp__github__") ? name.slice("mcp__github__".length) : name);
  if (!record(args)) fail("GITHUB_ARGUMENTS_INVALID");
  // Validate JSON and bound its size without exposing values in diagnostics.
  if (Buffer.byteLength(githubCanonical(args)) > MAX_SCHEMA_BYTES || !validators.get(rawName)!.Check(args)) fail("GITHUB_ARGUMENTS_INVALID");
  const checkBytes = (value: unknown): void => {
    if (typeof value === "string" && Buffer.byteLength(value) > 4096) fail("GITHUB_ARGUMENTS_INVALID");
    if (Array.isArray(value)) for (const entry of value) checkBytes(entry);
  };
  for (const value of Object.values(args)) checkBytes(value);
  if ((rawName === "actions_get" && args.method !== "get_workflow") || (rawName === "actions_list" && args.method === "list_workflow_jobs")) {
    if (typeof args.resource_id === "string" && (!/^[1-9][0-9]*$/u.test(args.resource_id) || !Number.isSafeInteger(Number(args.resource_id)))) fail("GITHUB_ARGUMENTS_INVALID");
  }
}

/** Builds a candidate only. Persisting/approving it is an explicit host/operator responsibility. */
export function buildGithubApproval(policy: GithubPolicyConfig, tools: readonly Record<string, unknown>[]): object {
  const parsed = parseGithubPolicy(policy);
  if (!Array.isArray(tools) || tools.length !== GITHUB_TOOL_NAMES.length) fail("GITHUB_TOOL_SET_INVALID");
  const found = new Map<ToolName, Schema>();
  for (const raw of tools) {
    if (!record(raw)) fail("GITHUB_TOOL_SET_INVALID");
    const name = toolName(raw.name);
    if (found.has(name)) fail("GITHUB_TOOL_SET_INVALID");
    found.set(name, raw);
  }
  const entries = GITHUB_TOOL_NAMES.map(name => {
    const raw = found.get(name);
    if (!raw) fail("GITHUB_TOOL_SET_INVALID");
    const effective = githubEffectiveTool(raw);
    return { rawName: name, registeredName: githubRegisteredName(name), raw: JSON.parse(githubCanonical(raw)) as Schema, effective };
  });
  return {
    formatVersion: 1, approvalVersion: parsed.approvalVersion, server: "github", endpoint: GITHUB_ENDPOINT,
    policy: {
      contractVersion: 1, host: "github.com", readOnly: true, publicRepositories: true,
      pageSize: 30, pagesPerCall: 1, queryAndCursorBytes: 4096, logTailLines: 200,
      schemaDepth: 12, schemaProperties: 256, schemaBytes: MAX_SCHEMA_BYTES, declarationBytes: MAX_DECLARATION_BYTES,
      tools: Object.fromEntries(GITHUB_TOOL_NAMES.map(name => [name, hostSchema(name)])),
    },
    tools: entries,
  };
}

export function verifyGithubApproval(policy: GithubPolicyConfig, tools: readonly Record<string, unknown>[], baseline: unknown): void {
  if (!record(baseline)) fail("GITHUB_APPROVAL_REQUIRED");
  const expected = buildGithubApproval(policy, tools);
  if (githubCanonical(baseline) !== githubCanonical(expected)) fail("GITHUB_APPROVAL_MISMATCH");
}
