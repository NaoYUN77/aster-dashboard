// The codemode declaration is rendered into the system message. A nested bash call resolves to
// this structured output, so the declaration names the spill path as a string; the full OutputRef
// contract stays host-side and is validated again before persistence.

import assert from "node:assert/strict";
import test from "node:test";
import { schemaToType } from "@earendil-works/pi-codemode";
import { Value } from "typebox/value";
import { PTC_BASH_STRUCTURED_OUTPUT_SCHEMA } from "../src/ptc-gateway.js";

const HASH = "a".repeat(64);
const PATH = `/workspace/.ptc/outputs/${HASH}`;

function bashResult(outputRef: unknown): unknown {
  return {
    output: "tail",
    truncated: true,
    exitCode: 1,
    ...(outputRef === undefined ? {} : { outputRef }),
    spillTruncated: false,
  };
}

test("the PTC bash declaration exposes a typed spill path", () => {
  const rendered = schemaToType(
    // TypeBox adds symbol-keyed metadata that the exported JSON-schema parameter type omits.
    PTC_BASH_STRUCTURED_OUTPUT_SCHEMA as unknown as Parameters<typeof schemaToType>[0],
  );
  assert.match(rendered, /outputRef\?: \{/);
  assert.match(rendered, /path: string;/);
  assert.match(rendered, /\[key: string\]: unknown;/);
});

test("the PTC bash schema requires a spill path when outputRef is present", () => {
  assert.equal(Value.Check(PTC_BASH_STRUCTURED_OUTPUT_SCHEMA, bashResult(undefined)), true);
  assert.equal(Value.Check(PTC_BASH_STRUCTURED_OUTPUT_SCHEMA, bashResult({ path: PATH })), true);
  assert.equal(Value.Check(PTC_BASH_STRUCTURED_OUTPUT_SCHEMA, bashResult({})), false);
  assert.equal(Value.Check(PTC_BASH_STRUCTURED_OUTPUT_SCHEMA, bashResult(PATH)), false);
});

test("a complete durable output reference still satisfies the bash schema", () => {
  const ref = {
    blobId: HASH,
    jobId: `ptc-${"b".repeat(32)}`,
    sessionId: "c".repeat(16),
    callId: 1,
    path: PATH,
    size: 123,
    sha256: HASH,
    createdAt: 1,
    expiresAt: 2,
    state: "available" as const,
  };
  assert.equal(Value.Check(PTC_BASH_STRUCTURED_OUTPUT_SCHEMA, bashResult(ref)), true);
});
