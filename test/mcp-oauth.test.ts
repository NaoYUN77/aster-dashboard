import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOAuthProvider } from "../src/mcp.js";
import type { McpHttpServerConfig } from "../src/mcp-config.js";
import { FileOAuthStateStore } from "../src/mcp-oauth-store.js";

function state(serverUrl: string, token: string) {
  return { serverUrl, tokens: { access_token: token, token_type: "Bearer" } };
}

test("an absent OAuth state file means the server is not authorized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-oauth-"));
  try {
    const store = new FileOAuthStateStore(join(directory, "missing.json"));
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth state round-trips with owner-only permissions and concurrent writes serialize", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-oauth-"));
  try {
    const path = join(directory, "nested", "server.json");
    const store = new FileOAuthStateStore(path);
    await Promise.all([
      store.save(state("https://mcp.example.com/mcp", "first")),
      store.save(state("https://mcp.example.com/mcp", "second")),
    ]);
    assert.deepEqual(await store.load(), state("https://mcp.example.com/mcp", "second"), "the last write wins");
    const text = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse(text), state("https://mcp.example.com/mcp", "second"));
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed write does not poison later writes or reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-oauth-"));
  try {
    // A regular file where the directory should be makes the first write fail.
    const obstructed = join(directory, "blocked");
    await writeFile(obstructed, "", "utf8");
    const store = new FileOAuthStateStore(join(obstructed, "server.json"));
    await assert.rejects(store.save(state("https://mcp.example.com/mcp", "first")));

    // Remove the obstruction; the same store must work again.
    await rm(obstructed);
    await store.save(state("https://mcp.example.com/mcp", "second"));
    assert.deepEqual(await store.load(), state("https://mcp.example.com/mcp", "second"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt OAuth state file is an error rather than silent reauthorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-mcp-oauth-"));
  try {
    const path = join(directory, "server.json");
    await writeFile(path, "not json", "utf8");
    await assert.rejects(new FileOAuthStateStore(path).load());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("each server gets its own state file and redirect URL", () => {
  const server: McpHttpServerConfig = {
    name: "calendar",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: {},
    auth: { type: "oauth", redirectPort: 9_123 },
    timeoutMs: 60_000,
    connectTimeoutMs: 10_000,
  };
  const provider = createOAuthProvider(server, "/data", () => {});
  assert.equal(provider.redirectUrl, "http://127.0.0.1:9123/callback");
});
