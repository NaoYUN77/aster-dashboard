import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { catalogFor, legacyCapabilitiesForRole, parseToolScope, profileForRole } from "../src/tool-catalog.js";
import type { ToolRecord } from "../src/tools.js";

const tool = (name: string) => defineTool({ name, description: `${name} description`, parameters: Type.Object({}), execute: async () => ({ output: [] }) });

test("role compatibility maps to named catalog profiles and legacy capabilities", () => {
  assert.equal(profileForRole("assistant"), "chief");
  assert.equal(profileForRole("researcher"), "research");
  assert.equal(profileForRole("programmer"), "programmer");
  assert.equal(legacyCapabilitiesForRole("assistant", { ptc: true, web: true }), "bash,files");
  assert.equal(legacyCapabilitiesForRole("researcher", { ptc: true, web: true }), "bash,files,web");
  assert.equal(legacyCapabilitiesForRole("programmer", { ptc: true, web: true }), "bash,files,ptc");
});

test("profiles filter native, PTC, web and discovered MCP definitions through one catalog", () => {
  const entries = [
    { tool: tool("bash") },
    { tool: tool("web_search") },
    { tool: tool("codemode") },
    { tool: tool("mcp__calendar__events"), record: { source: { kind: "mcp", server: "calendar" } } as ToolRecord },
  ];
  const research = catalogFor(entries, "research", { allow: [], deny: [] });
  assert.deepEqual([...research.names].sort(), ["bash", "mcp__calendar__events", "web_search"]);
  assert.ok(research.definitions.every(({ name, description, inputSchema }) => name && description && inputSchema));
  const programmer = catalogFor(entries, "programmer", { allow: [], deny: [] });
  assert.deepEqual([...programmer.names].sort(), ["bash", "codemode", "mcp__calendar__events"]);
  const narrowed = catalogFor(entries, "programmer", { allow: ["bash", "web_search"], deny: [] });
  assert.deepEqual([...narrowed.names], ["bash"]);
  assert.deepEqual(parseToolScope({ allow: ["bash", "bash"], deny: ["codemode"] }), {
    allow: ["bash"], deny: ["codemode"],
  });
  assert.throws(() => parseToolScope({ allow: ["bash"], extra: true }), /unknown fields/);
});
