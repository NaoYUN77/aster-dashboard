import assert from "node:assert/strict";
import test from "node:test";
import { OutputWindow } from "../src/execution/broker.js";
import {
  parseBrokerFrame,
  parseBrokerRequest,
  type ExecRequest,
} from "../src/execution/protocol.js";

const exec = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  type: "exec",
  id: "call-1",
  command: "echo hello",
  cwd: "/srv/work",
  env: { LANG: "C" },
  inheritEnv: true,
  timeoutSeconds: 30,
  ...overrides,
});

test("protocol accepts a well-formed exec request and normalizes nothing", () => {
  const parsed = parseBrokerRequest(JSON.stringify(exec()));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.type, "exec");
  assert.deepEqual(parsed.value, {
    v: 1,
    type: "exec",
    id: "call-1",
    command: "echo hello",
    cwd: "/srv/work",
    env: { LANG: "C" },
    inheritEnv: true,
    timeoutSeconds: 30,
  });
});

test("protocol accepts argv commands and bounded windows", () => {
  const parsed = parseBrokerRequest(JSON.stringify(exec({
    command: ["printf", "%s", "a b"],
    window: { maxBytes: 1024, maxLines: 20, minIntervalMs: 0, bytesPerSecond: 1000 },
  })));
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.type !== "exec") return;
  assert.deepEqual(parsed.value.command, ["printf", "%s", "a b"]);
  assert.deepEqual(parsed.value.window, { maxBytes: 1024, maxLines: 20, minIntervalMs: 0, bytesPerSecond: 1000 });
});

test("protocol rejects unknown fields, versions and malformed values", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["unknown top-level field", exec({ unexpected: true })],
    ["unknown nested window field", exec({ window: { maxBytes: 1024, maxLines: 20, minIntervalMs: 0, bytesPerSecond: 1000, extra: 1 } })],
    ["wrong version", { ...exec(), v: 2 }],
    ["unknown type", { ...exec(), type: "run" }],
    ["invalid id", exec({ id: "../x" })],
    ["relative cwd", exec({ cwd: "work" })],
    ["cwd with newline", exec({ cwd: "/srv/work\nrm -rf /" })],
    ["cwd with NUL", exec({ cwd: "/srv/work\0x" })],
    ["empty argv", exec({ command: [] })],
    ["argv with non-string", exec({ command: ["echo", 1] })],
    ["command with NUL", exec({ command: "echo \0" })],
    ["env not an object", exec({ env: "LANG=C" })],
    ["invalid env key", exec({ env: { "BAD-KEY": "1" } })],
    ["non-string env value", exec({ env: { LANG: 1 } })],
    ["non-boolean inheritEnv", exec({ inheritEnv: "yes" })],
    ["zero timeout", exec({ timeoutSeconds: 0 })],
    ["fractional timeout", exec({ timeoutSeconds: 1.5 })],
    ["oversized command", exec({ command: "x".repeat(64 * 1024 + 1) })],
    ["bad window bytes", exec({ window: { maxBytes: 1, maxLines: 20, minIntervalMs: 0, bytesPerSecond: 1000 } })],
    ["bad window lines", exec({ window: { maxBytes: 1024, maxLines: 0, minIntervalMs: 0, bytesPerSecond: 1000 } })],
  ];
  for (const [name, value] of cases) {
    const parsed = parseBrokerRequest(JSON.stringify(value));
    assert.equal(parsed.ok, false, name);
  }
  assert.equal(parseBrokerRequest("not json").ok, false);
  assert.equal(parseBrokerRequest(JSON.stringify({ v: 1, type: "ping", extra: 1 })).ok, false);
  assert.equal(parseBrokerRequest(JSON.stringify({ v: 1, type: "ping" })).ok, true);
});

test("protocol parses frames strictly and keeps skipped metadata", () => {
  const output = parseBrokerFrame(JSON.stringify({
    v: 1, type: "output", id: "call-1", stream: "stdout", text: "tail\n",
    skipped: { bytes: 4096, newlines: 10, endsWithNewline: true },
  }));
  assert.equal(output.ok, true);
  if (output.ok) {
    assert.equal(output.value.type, "output");
    assert.deepEqual(output.value.type === "output" ? output.value.skipped : undefined,
      { bytes: 4096, newlines: 10, endsWithNewline: true });
  }
  assert.equal(parseBrokerFrame(JSON.stringify({ v: 1, type: "exit", id: "call-1", exitCode: 7 })).ok, true);
  assert.equal(parseBrokerFrame(JSON.stringify({ v: 1, type: "error", id: null, code: "busy", message: "busy" })).ok, true);
  assert.equal(parseBrokerFrame(JSON.stringify({ v: 1, type: "pong", protocol: 1, executionId: "0000000000000001" })).ok, true);
  for (const frame of [
    { v: 1, type: "output", id: "call-1", stream: "stdout", text: "x", extra: 1 },
    { v: 1, type: "output", id: "call-1", stream: "stdout", text: "x", skipped: { bytes: -1, newlines: 0, endsWithNewline: false } },
    { v: 1, type: "exit", id: "call-1", exitCode: 256 },
    { v: 1, type: "error", id: "call-1", code: "surprise", message: "x" },
    { v: 1, type: "pong", protocol: 2, executionId: "0000000000000001" },
    { v: 1, type: "pong", protocol: 1, executionId: "000000000000001Z" },
    { v: 1, type: "unknown" },
  ]) {
    assert.equal(parseBrokerFrame(JSON.stringify(frame)).ok, false, JSON.stringify(frame));
  }
});

test("output window keeps the tail and reports omitted bytes and lines", () => {
  const lines = new OutputWindow(1000, 2);
  lines.push("a\nb\nc\nd\n");
  assert.deepEqual(lines.take(), {
    text: "c\nd\n",
    skipped: { bytes: 4, newlines: 2, endsWithNewline: true },
  });
  assert.equal(lines.take(), undefined);

  const bytes = new OutputWindow(6, 1000);
  bytes.push("abcdefghij");
  assert.deepEqual(bytes.take(), {
    text: "efghij",
    skipped: { bytes: 4, newlines: 0, endsWithNewline: false },
  });

  const split = new OutputWindow(5, 1000);
  split.push("😀😀😀");
  const taken = split.take();
  assert.ok(taken);
  assert.equal(taken.text, "😀");
  assert.equal(taken.skipped?.bytes, 8);
  assert.equal(taken.text.isWellFormed(), true);
});

test("output window drops earlier retained chunks as later pushes arrive", () => {
  const window = new OutputWindow(4, 1000);
  window.push("abcdefgh");
  window.push("ij");
  assert.deepEqual(window.take(), {
    text: "ij",
    skipped: { bytes: 8, newlines: 0, endsWithNewline: false },
  });
});

test("exec request type is assignable to the wire request used by the broker", () => {
  const request: ExecRequest = exec() as ExecRequest;
  assert.equal(request.type, "exec");
});
