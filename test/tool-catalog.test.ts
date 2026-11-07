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
  assert.equal(legacyCapabilitiesForProfile(all, { web: true }), "bash,files,web");
  assert.equal(legacyCapabilitiesForProfile(all, { web: false }), "bash,files");
  assert.equal(legacyCapabilitiesForProfile({ ...all, shell: false, files: false }, { web: true }), "web");
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
  // The deprecated ptc/reminders switches select no tools: retired codemode/reminder_* tools have
  // no catalog group and stay closed by default.
  const groups = {
    core: ["current_time", "tool_search"], shell: ["bash"], files: ["read", "write", "edit"],
    web: ["web_search", "web_fetch"], memory: ["memory_search", "working_read"],
    mcp: ["mcp__calendar__events"],
  };
  const entries = Object.entries(groups).flatMap(([group, names]) => names.map((name) => ({
    tool: tool(name), ...(group === "mcp" ? { record: { source: { kind: "mcp", server: "calendar" } } as ToolRecord } : {}),
  })));
  entries.push({ tool: tool("unknown_host_tool") }, { tool: tool("codemode") }, { tool: tool("reminder_list") });
  for (const disabled of Object.keys(groups)) {
    const profile = { ...all, [disabled]: false };
    const expected = Object.entries(groups).filter(([group]) => group !== disabled).flatMap(([, names]) => names).sort();
    const catalog = catalogFor(entries, profile, emptyScope);
    assert.deepEqual([...catalog.names].sort(), expected);
    assert.deepEqual(catalog.definitions.map(({ name }) => name).sort(), expected);
    const attempt = catalogFor(entries, profile, { allow: groups[disabled as keyof typeof groups], deny: [] });
    assert.equal(attempt.names.size, 0, "allow cannot reopen a disabled group");
    assert.deepEqual(attempt.definitions, []);
  }
  // A retired group flip never surfaces a retired tool, nor an unassigned host tool.
  for (const retired of ["ptc", "reminders"] as const) {
    const catalog = catalogFor(entries, { ...all, [retired]: true }, emptyScope);
    assert.equal(catalog.names.has("codemode"), false);
    assert.equal(catalog.names.has("reminder_list"), false);
    assert.equal(catalog.names.has("unknown_host_tool"), false);
  }
  const combined = catalogFor(entries, { ...all, shell: false, files: false },
    { allow: ["bash", "read", "web_search", "web_fetch", "memory_search"], deny: ["web_search", "memory_search"] });
  assert.deepEqual([...combined.names], ["web_fetch"]);
  assert.deepEqual(combined.definitions.map(({ name }) => name), ["web_fetch"]);
  assert.ok(combined.definitions.every(({ description, inputSchema }) => description && inputSchema));
  const mcpWithBuiltinName = { tool: tool("read"), record: { source: { kind: "mcp", server: "calendar" } } as ToolRecord };
  assert.equal(catalogFor([mcpWithBuiltinName], { ...all, mcp: false }, emptyScope).names.size, 0);
  assert.equal(catalogFor([mcpWithBuiltinName], { ...all, files: false }, emptyScope).names.size, 1);
  assert.deepEqual(parseToolScope({ allow: ["bash", "bash"], deny: ["read"] }), { allow: ["bash"], deny: ["read"] });
  assert.throws(() => parseToolScope({ allow: ["bash"], extra: true }), /unknown fields/);
});
