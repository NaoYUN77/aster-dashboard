// The container sandbox's one path rule: a session may only be rooted at a directory below the
// mounted workspace root. Everything the model can reach is expressed through it, so these are the
// cases that decide whether one bot can be handed another bot's directory.

import assert from "node:assert/strict";
import test from "node:test";
import { containerWorkspacePath } from "../src/execution/container-executor.js";
import { PtcHostError } from "../src/execution/ptc-host.js";

test("a session root is the workspace root or a clean directory below it", () => {
  assert.equal(containerWorkspacePath("/workspaces", "/workspaces/researcher"), "/workspaces/researcher");
  assert.equal(containerWorkspacePath("/workspaces", "/workspaces/researcher/"), "/workspaces/researcher");
  assert.equal(containerWorkspacePath("/workspaces", "/workspaces"), "/workspaces");
  // The app always names a directory; the root itself is the legacy bootstrap bot's workspace.
  assert.equal(containerWorkspacePath("/workspaces", undefined), "/workspaces");
});

test("a path outside the workspace root is refused before anything is created", () => {
  for (const requested of [
    "/workspaces-other/researcher",
    "/workspaces/../etc",
    "/workspaces/researcher/..",
    "/workspaces/./researcher",
    "/data/workspaces",
    "/",
    "workspaces/researcher",
    "/workspaces/re\\searcher",
    "/workspaces/re\0searcher",
  ]) {
    assert.throws(
      () => containerWorkspacePath("/workspaces", requested),
      (error: unknown) => error instanceof PtcHostError && error.code === "invalid_request",
      `expected ${JSON.stringify(requested)} to be refused`,
    );
  }
});
