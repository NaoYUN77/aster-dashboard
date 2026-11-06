// The shared execution host's one path rule: a session may only be rooted at a directory below the
// workspace root. It is a correctness bound for each bot's default working directory, not an
// OS-level isolation claim: all bots share the same files and installed software by design.

import assert from "node:assert/strict";
import test from "node:test";
import { sessionWorkspacePath } from "../src/execution/shared-host.js";
import { PtcHostError } from "../src/execution/ptc-host.js";

test("a session root is the workspace root or a clean directory below it", () => {
  assert.equal(sessionWorkspacePath("/workspaces", "/workspaces/researcher"), "/workspaces/researcher");
  assert.equal(sessionWorkspacePath("/workspaces", "/workspaces/researcher/"), "/workspaces/researcher");
  assert.equal(sessionWorkspacePath("/workspaces", "/workspaces"), "/workspaces");
  // The app always names a directory; the root itself is the legacy bootstrap bot's workspace.
  assert.equal(sessionWorkspacePath("/workspaces", undefined), "/workspaces");
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
      () => sessionWorkspacePath("/workspaces", requested),
      (error: unknown) => error instanceof PtcHostError && error.code === "invalid_request",
      `expected ${JSON.stringify(requested)} to be refused`,
    );
  }
});
