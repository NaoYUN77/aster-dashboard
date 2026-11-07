import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RpcClientError } from "../src/execution/rpc-client.js";
import { RemoteFileSystem } from "../src/execution/remote-files.js";
import {
  FILE_MAX_READ_CHUNK_BYTES,
  FILE_MAX_READ_TEXT_BYTES,
  FILE_MAX_WRITE_BYTES,
  type RpcBashExecutePayload,
  type RpcFileMethod,
} from "../src/execution/rpc-protocol.js";
import { FileServiceError, PtcFileService } from "../src/execution/ptc-fs.js";
import { RemoteRpcExecutionEnv } from "../src/execution/remote-rpc-env.js";

const context = BACKGROUND_CONTEXT;

async function service(t: { after(fn: () => Promise<void>): void }) {
  const base = await mkdtemp(join(tmpdir(), "aster-files-"));
  const workspace = join(base, "workspace");
  const shared = join(base, "shared");
  const scratch = join(base, "tmp");
  await Promise.all([mkdir(workspace), mkdir(shared), mkdir(scratch)]);
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const files = new PtcFileService({
    roots: [
      { virtual: "/workspace", host: workspace, writable: true },
      { virtual: "/shared", host: shared, writable: false },
      { virtual: "/tmp", host: scratch, writable: true },
    ],
  });
  return { base, workspace, shared, scratch, files };
}

async function expectCode(promise: Promise<unknown>, code: FileServiceError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FileServiceError, `expected FileServiceError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("file primitives stay inside their roots and round-trip through atomic writes", async (t) => {
  const { workspace, files } = await service(t);
  const written = await files.write("/workspace/src/a.txt", Buffer.from("hola").toString("base64"));
  assert.equal(written.info.path, "/workspace/src/a.txt");
  assert.equal(written.info.kind, "file");
  assert.equal(written.info.size, 4);
  assert.equal((await files.readText("/workspace/src/a.txt")).data, Buffer.from("hola").toString("base64"));
  assert.equal(await files.exists("/workspace/src/a.txt"), true);
  assert.equal(await files.exists("/workspace/src/missing.txt"), false);
  const info = await files.info("/workspace/src/a.txt");
  assert.equal(info.info.name, "a.txt");
  assert.equal(await files.canonical("/workspace/src/a.txt"), "/workspace/src/a.txt");
  // A successful write leaves nothing but its target: the temporary file was renamed, not copied.
  assert.deepEqual((await readdir(join(workspace, "src"))).sort(), ["a.txt"]);

  await files.write("/tmp/scratch.txt", Buffer.from("tmp").toString("base64"));
  assert.equal((await files.readText("/tmp/scratch.txt")).data, Buffer.from("tmp").toString("base64"));

  // `/shared` is read-only until the host enables writes.
  await expectCode(files.write("/shared/a.txt", Buffer.from("no").toString("base64")), "permission_denied");

  // Paths never leave their virtual root, however they are spelled.
  await expectCode(files.readText("/workspace/../etc/passwd"), "permission_denied");
  await expectCode(files.readText("/etc/passwd"), "permission_denied");
  await expectCode(files.write("/workspace/../../escape.txt", Buffer.from("x").toString("base64")), "permission_denied");
  await expectCode(files.readText("/workspace/a\0.txt"), "invalid_request");
  await expectCode(files.readText("workspace/a.txt"), "invalid_request");
  await expectCode(files.readText("/workspace\\a.txt"), "invalid_request");
  await expectCode(files.write("/workspace", Buffer.from("x").toString("base64")), "is_directory");
  await expectCode(files.readText("/workspace/src"), "is_directory");
  await expectCode(files.write("/workspace/a.txt", "not base64!"), "invalid_request");

  const oversized = Buffer.alloc(FILE_MAX_WRITE_BYTES + 1).toString("base64");
  await expectCode(files.write("/workspace/big.txt", oversized), "too_large");
  await writeFile(join(workspace, "huge.txt"), Buffer.alloc(FILE_MAX_READ_TEXT_BYTES + 1));
  await expectCode(files.readText("/workspace/huge.txt"), "too_large");

  // A failed write leaves no temporary file behind.
  await writeFile(join(workspace, "block"), "file");
  await assert.rejects(files.write("/workspace/block/child.txt", Buffer.from("x").toString("base64")));
  assert.deepEqual((await readdir(workspace)).sort(), ["block", "huge.txt", "src"]);
});

test("reads are chunked, report the next offset, and never cross a handle's session", async (t) => {
  const { workspace, files } = await service(t);
  const bytes = Buffer.alloc(FILE_MAX_READ_CHUNK_BYTES * 2 + 97);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await writeFile(join(workspace, "blob.bin"), bytes);

  const opened = await files.open("session-a", "/workspace/blob.bin");
  assert.equal(opened.info.size, bytes.length);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await files.read("session-a", opened.handle, offset, FILE_MAX_READ_CHUNK_BYTES);
    assert.equal(chunk.bytesRead, Math.min(FILE_MAX_READ_CHUNK_BYTES, bytes.length - offset));
    assert.equal(chunk.nextOffset, offset + chunk.bytesRead);
    chunks.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.nextOffset;
    if (chunk.eof) break;
  }
  assert.ok(chunks.length >= 3, "a large file crosses in more than one chunk");
  assert.deepEqual(Buffer.concat(chunks), bytes);

  const atEnd = await files.read("session-a", opened.handle, bytes.length, 16);
  assert.deepEqual(atEnd, { data: "", bytesRead: 0, nextOffset: bytes.length, eof: true });
  await expectCode(files.read("session-a", opened.handle, 0, 0), "invalid_request");
  await expectCode(files.read("session-b", opened.handle, 0, 16), "not_found");

  await files.close("session-a", opened.handle);
  await expectCode(files.read("session-a", opened.handle, 0, 16), "not_found");

  const text = await files.open("session-a", "/workspace/lines.txt").catch(() => undefined);
  assert.equal(text, undefined, "a missing file never yields a handle");
  await writeFile(join(workspace, "lines.txt"), "a\nb\nc\n");
  const lines = await files.open("session-a", "/workspace/lines.txt");
  const scan = await files.scanLines("session-a", lines.handle, 0, 2);
  assert.equal(scan.scan.start, 0);
  assert.equal(scan.scan.newlines, 3, "the count covers the whole file");
  assert.equal(scan.scan.end, 3, "endLine is exclusive, so lines 0..1 end before the second newline");
  await files.closeSession("session-a");
  await expectCode(files.read("session-a", lines.handle, 0, 16), "not_found");
});

test("symbolic links cannot reach outside a root", { skip: process.platform === "win32" }, async (t) => {
  const { base, workspace, files } = await service(t);
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(workspace, "escape"));
  await symlink(join(outside, "secret.txt"), join(workspace, "secret-link"));
  await symlink(join(workspace, "missing.txt"), join(workspace, "dangling"));

  await expectCode(files.info("/workspace/escape/secret.txt"), "permission_denied");
  await expectCode(files.canonical("/workspace/escape/secret.txt"), "permission_denied");
  await expectCode(files.readText("/workspace/escape/secret.txt"), "permission_denied");
  await expectCode(files.readText("/workspace/secret-link"), "permission_denied");
  await expectCode(files.write("/workspace/escape/new.txt", Buffer.from("x").toString("base64")), "permission_denied");
  await expectCode(files.write("/workspace/secret-link", Buffer.from("x").toString("base64")), "permission_denied");
  await expectCode(files.write("/workspace/dangling", Buffer.from("x").toString("base64")), "not_found");
  await expectCode(files.open("session-a", "/workspace/secret-link", { noFollow: true }), "invalid_request");
  await expectCode(files.open("session-a", "/workspace/escape/secret.txt", { noFollow: true }), "permission_denied");

  // A link whose target stays inside the root is followed, and writing keeps the link itself.
  await writeFile(join(workspace, "target.txt"), "old");
  await symlink(join(workspace, "target.txt"), join(workspace, "inside-link"));
  await expectCode(files.open("session-a", "/workspace/inside-link", { noFollow: true }), "invalid_request");
  assert.equal(await files.canonical("/workspace/inside-link"), "/workspace/target.txt");
  const written = await files.write("/workspace/inside-link", Buffer.from("new").toString("base64"));
  assert.equal(written.info.path, "/workspace/target.txt", "the real target is reported");
  assert.equal((await files.readText("/workspace/inside-link")).data, Buffer.from("new").toString("base64"));
  assert.equal(await files.info("/workspace/inside-link").then(({ info }) => info.kind), "symlink");

  // A sandbox link usually names a virtual path. That target must resolve inside this root rather
  // than being looked up as a host path, which would report a present file as missing.
  await symlink("/workspace/target.txt", join(workspace, "virtual-link"));
  assert.equal(await files.canonical("/workspace/virtual-link"), "/workspace/target.txt");
  assert.equal((await files.readText("/workspace/virtual-link")).data, Buffer.from("new").toString("base64"));
  const viaVirtual = await files.write("/workspace/virtual-link", Buffer.from("virtual").toString("base64"));
  assert.equal(viaVirtual.info.path, "/workspace/target.txt");
  await mkdir(join(workspace, "dir"));
  await writeFile(join(workspace, "dir", "f.txt"), "nested");
  await symlink("/workspace/dir", join(workspace, "dir-link"));
  assert.equal(await files.canonical("/workspace/dir-link/f.txt"), "/workspace/dir/f.txt");
  assert.equal((await files.readText("/workspace/dir-link/f.txt")).data, Buffer.from("nested").toString("base64"));
  await symlink("/workspace/void.txt", join(workspace, "virtual-dangling"));
  await expectCode(files.write("/workspace/virtual-dangling", Buffer.from("x").toString("base64")), "not_found");
  // Crossing roots through a virtual link would let a writable root reach a read-only one.
  await symlink("/shared/secret.txt", join(workspace, "cross-root"));
  await expectCode(files.readText("/workspace/cross-root"), "permission_denied");
});

test("the remote file system splits large reads and rejects oversized writes locally", async () => {
  const calls: Array<{ method: RpcFileMethod; payload: Record<string, unknown> }> = [];
  const size = FILE_MAX_READ_CHUNK_BYTES * 2 + 5;
  const data = Buffer.alloc(size, 7);
  const files = new RemoteFileSystem({
    namespace: "test",
    cwd: "/workspace",
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "file.open") {
        return { handle: "f01", info: { name: "blob", path: "/workspace/blob", kind: "file", size, mtimeMs: 1 } };
      }
      if (method === "file.read") {
        const offset = payload.offset as number;
        const length = payload.length as number;
        const chunk = data.subarray(offset, Math.min(offset + length, size));
        return {
          data: chunk.toString("base64"),
          bytesRead: chunk.length,
          nextOffset: offset + chunk.length,
          eof: offset + chunk.length >= size,
        };
      }
      if (method === "file.close") return {};
      throw new RpcClientError("not_implemented", "unexpected method");
    },
  });

  const opened = await files.openBinaryReader("/workspace/blob", undefined, context);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const read = await opened.value.read(0, size, context);
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(Buffer.from(read.value), data);
  const reads = calls.filter(({ method }) => method === "file.read");
  assert.ok(reads.length >= 3, "one read is split into wire-sized chunks");
  assert.ok(reads.every(({ payload }) => (payload.length as number) <= FILE_MAX_READ_CHUNK_BYTES));

  const oversized = await files.writeFile("/workspace/big", Buffer.alloc(FILE_MAX_WRITE_BYTES + 1), context);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "invalid");
  assert.equal(calls.filter(({ method }) => method === "file.write").length, 0, "the bound is enforced before sending");
});

type ExecCall = { readonly payload: RpcBashExecutePayload; readonly deadlineMs: number | undefined };

function directEnv(result?: {
  exec?: (payload: RpcBashExecutePayload) => Promise<{ exitCode: number; durationMs: number }>;
  file?: (method: RpcFileMethod, payload: Record<string, unknown>) => Promise<unknown>;
  direct?: boolean;
}) {
  const opened: string[] = [];
  const closed: string[] = [];
  const execs: ExecCall[] = [];
  const client = {
    openSession: async (sessionId: string) => {
      opened.push(sessionId);
      return {
        sessionId,
        executionId: "0123456789abcdef",
        ...(result?.direct === false ? {} : { direct: { sharedMode: "rw" as const, workspace: "/shared", tmp: "/tmp" } }),
        limits: { maxSessions: 16, maxConcurrent: 4, sessionTtlMs: 270_000 },
      };
    },
    closeSession: async (sessionId: string) => { closed.push(sessionId); },
    startBashExecute: (sessionId: string, payload: RpcBashExecutePayload, options: { deadlineMs?: number }) => {
      void sessionId;
      execs.push({ payload, deadlineMs: options.deadlineMs });
      const promise = result?.exec === undefined
        ? Promise.resolve({ exitCode: 0, durationMs: 1 })
        : result.exec(payload);
      return { id: "exec-1", result: promise, cancel: async () => undefined };
    },
    fileRequest: async (sessionId: string, method: RpcFileMethod, payload: Record<string, unknown>) => {
      void sessionId;
      if (result?.file === undefined) throw new RpcClientError("not_implemented", "no file host");
      return result.file(method, payload);
    },
  };
  const env = new RemoteRpcExecutionEnv({
    client,
    sessionId: "0123456789abcdef",
    cwd: "/shared/project",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60,
  });
  return { env, opened, closed, execs };
}

test("the direct environment opens one session and runs each command through RPC bash", async () => {
  const { env, opened, closed, execs } = directEnv({ exec: async () => ({ exitCode: 7, durationMs: 2 }) });
  const result = await env.exec("printf hi", {
    env: { A: "1" },
    inheritEnv: false,
    timeout: 1.4,
    window: { maxBytes: 1_024, maxLines: 10, minIntervalMs: 0, bytesPerSecond: 0 },
  }, context);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.exitCode, 7);
  assert.deepEqual(opened, ["0123456789abcdef"], "the session opens on first use, once");
  assert.equal(execs.length, 1);
  assert.equal(execs[0]?.payload.executor, "bash");
  assert.equal(execs[0]?.payload.cwd, "/shared/project");
  assert.deepEqual(execs[0]?.payload.env, { A: "1" });
  assert.equal(execs[0]?.payload.timeoutMs, 2_000, "a sub-second timeout rounds up");
  assert.equal(execs[0]?.deadlineMs, 62_000);

  const wrongCwd = await env.exec("id", { cwd: "/etc" }, context);
  assert.equal(wrongCwd.ok, false);
  if (!wrongCwd.ok) assert.match(wrongCwd.error.message, /only inside \/shared/);

  const tooLong = await env.exec("id", { timeout: 86_400 }, context);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.code, "timeout");

  await env.close();
  assert.deepEqual(closed, ["0123456789abcdef"]);
  const afterClose = await env.exec("id", undefined, context);
  assert.equal(afterClose.ok, false);
  assert.equal(execs.length, 1, "a closed environment runs nothing");
});

test("the direct environment repairs an idle-swept session once, without replaying a real result", async () => {
  let attempt = 0;
  const { env, opened } = directEnv({
    exec: async () => {
      attempt++;
      if (attempt === 1) {
        throw new RpcClientError("not_found", "session is not open", { outcome: "not_started" });
      }
      return { exitCode: 0, durationMs: 1 };
    },
    file: async (method) => {
      if (method === "file.exists") return { exists: true };
      throw new RpcClientError("not_found", "missing", { outcome: "failed" });
    },
  });
  const result = await env.exec("true", undefined, context);
  assert.equal(result.ok, true);
  assert.equal(attempt, 2, "the refused request is retried once");
  assert.deepEqual(opened, ["0123456789abcdef", "0123456789abcdef"], "the session is re-established");

  // A file-level `not_found` is a real answer: it never triggers a session repair.
  const read = await env.readTextFile("/shared/missing.txt", context);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error.code, "not_found");
  assert.equal(opened.length, 2);
});

test("the direct environment reports an agent without direct sessions instead of falling back", async () => {
  const { env, execs } = directEnv({ direct: false });
  const result = await env.exec("id", undefined, context);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unknown");
    assert.match(result.error.message, /does not support direct sessions/);
  }
  assert.equal(execs.length, 0);
  await env.close();
});
