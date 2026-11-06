import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { CATALOG_GROUPS, catalogFor, legacyCapabilitiesForProfile, parseCatalogProfile, parseToolScope, serializeCatalogProfile } from "../src/tool-catalog.js";
import type { ToolRecord } from "../src/tools.js";

const tool = (name: string) => defineTool({ name, description: `${name} description`, parameters: Type.Object({}), execute: async () => ({ output: [] }) });
const all = parseCatalogProfile(Object.fromEntries(CATALOG_GROUPS.map((group) => [group, true])));
const emptyScope = { allow: [], deny: [] };

test("capability strings are a deployment-limited projection of explicit switches", () => {
  assert.equal(legacyCapabilitiesForProfile(all, { ptc: true, web: true }), "bash,files,ptc,web");
  assert.equal(legacyCapabilitiesForProfile(all, { ptc: false, web: false }), "bash,files");
  assert.equal(legacyCapabilitiesForProfile({ ...all, shell: false, files: false }, { ptc: true, web: true }), "ptc,web");
});

test("profiles require all boolean switches and round-trip canonical JSON", () => {
  assert.deepEqual(parseCatalogProfile(serializeCatalogProfile(all)), all);
  assert.ok(Object.isFrozen(parseCatalogProfile(all)));
  for (const invalid of [undefined, null, [], "chief", '"research"', "{", {}, { ...all, shell: 1 }, { ...all, role: "programmer" }]) {
    assert.throws(() => parseCatalogProfile(invalid), /catalog profile/);
  }
  for (const group of CATALOG_GROUPS) {
    const missing: Record<string, boolean> = { ...all };
    delete missing[group];
    assert.throws(() => parseCatalogProfile(missing), /must be a boolean/);
  }
});

test("independent group switches and narrowing scope govern the same catalog definitions and names", () => {
  const groups = {
    core: ["current_time", "tool_search"], shell: ["bash"], files: ["read", "write", "edit"],
    web: ["web_search", "web_fetch"], ptc: ["codemode"], memory: ["memory_search", "working_read"],
    reminders: ["reminder_list"], mcp: ["mcp__calendar__events"],
  };
  const entries = Object.entries(groups).flatMap(([group, names]) => names.map((name) => ({
    tool: tool(name), ...(group === "mcp" ? { record: { source: { kind: "mcp", server: "calendar" } } as ToolRecord } : {}),
  })));
  entries.push({ tool: tool("unknown_host_tool") });
  for (const disabled of CATALOG_GROUPS) {
    const profile = { ...all, [disabled]: false };
    const expected = Object.entries(groups).filter(([group]) => group !== disabled).flatMap(([, names]) => names).sort();
    const catalog = catalogFor(entries, profile, emptyScope);
    assert.deepEqual([...catalog.names].sort(), expected);
    assert.deepEqual(catalog.definitions.map(({ name }) => name).sort(), expected);
    const attempt = catalogFor(entries, profile, { allow: groups[disabled], deny: [] });
    assert.equal(attempt.names.size, 0, "allow cannot reopen a disabled group");
    assert.deepEqual(attempt.definitions, []);
  }
  const combined = catalogFor(entries, { ...all, shell: false, files: false }, { allow: ["bash", "read", "codemode", "web_search"], deny: ["web_search"] });
  assert.deepEqual([...combined.names], ["codemode"]);
  assert.deepEqual(combined.definitions.map(({ name }) => name), ["codemode"]);
  assert.ok(combined.definitions.every(({ description, inputSchema }) => description && inputSchema));
  const mcpWithBuiltinName = { tool: tool("read"), record: { source: { kind: "mcp", server: "calendar" } } as ToolRecord };
  assert.equal(catalogFor([mcpWithBuiltinName], { ...all, mcp: false }, emptyScope).names.size, 0);
  assert.equal(catalogFor([mcpWithBuiltinName], { ...all, files: false }, emptyScope).names.size, 1);
  assert.deepEqual(parseToolScope({ allow: ["bash", "bash"], deny: ["codemode"] }), { allow: ["bash"], deny: ["codemode"] });
  assert.throws(() => parseToolScope({ allow: ["bash"], extra: true }), /unknown fields/);
});
