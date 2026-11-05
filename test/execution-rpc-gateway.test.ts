import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { test } from "node:test";
import { startRpcGateway } from "../src/execution/rpc-gateway.js";

// The gateway socket is a filesystem Unix socket, exactly as in production; Windows named pipes
// have different lifecycle rules, so those cases run on POSIX CI only.
const posix = process.platform !== "win32";

async function temporarySocket(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aster-rpc-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "gateway.sock");
}

async function startEchoUpstream(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

function stopServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function upstreamConnector(port: number): () => Promise<Duplex> {
  return () => new Promise<Duplex>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function openClient(socketPath: string): Promise<Socket> {
  const client = connect(socketPath);
  client.on("error", () => undefined);
  await once(client, "connect");
  return client;
}

/** Wait for the peer to close; a socket that is already gone must not hang the wait. */
async function waitForClose(socket: Socket): Promise<void> {
  if (!socket.destroyed) await once(socket, "close");
}

test("the gateway relays bytes between the app socket and the upstream", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const { port, server } = await startEchoUpstream();
  const gateway = await startRpcGateway({ socketPath, maxConnections: 4, connectUpstream: upstreamConnector(port) });
  const client = await openClient(socketPath);
  try {
    client.write("ping");
    const [data] = await once(client, "data") as [Buffer];
    assert.equal(data.toString(), "ping");
    client.write("pong");
    const [second] = await once(client, "data") as [Buffer];
    assert.equal(second.toString(), "pong");
  } finally {
    client.destroy();
    await gateway.close();
    await stopServer(server);
  }
});

test("a connection beyond the limit is closed without reaching the upstream", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const { port, server } = await startEchoUpstream();
  const gateway = await startRpcGateway({ socketPath, maxConnections: 1, connectUpstream: upstreamConnector(port) });
  const first = await openClient(socketPath);
  try {
    first.write("first");
    const [echo] = await once(first, "data") as [Buffer];
    assert.equal(echo.toString(), "first");

    // The gateway refuses this connection at accept time, so it may already be gone by now.
    const second = await openClient(socketPath);
    await waitForClose(second);

    // The rejected connection must not have displaced the first tunnel.
    first.write("still-here");
    const [again] = await once(first, "data") as [Buffer];
    assert.equal(again.toString(), "still-here");
  } finally {
    first.destroy();
    await gateway.close();
    await stopServer(server);
  }
});

test("an upstream failure closes the app connection", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const gateway = await startRpcGateway({
    socketPath,
    maxConnections: 2,
    connectUpstream: async () => Promise.reject(new Error("upstream refused")),
  });
  const client = await openClient(socketPath);
  try {
    await waitForClose(client);
  } finally {
    client.destroy();
    await gateway.close();
  }
});

test("close removes the socket and a second start can reuse the path", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  const first = await startRpcGateway({
    socketPath,
    maxConnections: 1,
    connectUpstream: async () => new PassThrough() as Duplex,
  });
  await first.close();
  await assert.rejects(access(socketPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const second = await startRpcGateway({
    socketPath,
    maxConnections: 1,
    connectUpstream: async () => new PassThrough() as Duplex,
  });
  try {
    await access(socketPath);
  } finally {
    await second.close();
  }
});

test("a regular file at the socket path is never deleted", { skip: !posix }, async (t) => {
  const socketPath = await temporarySocket(t);
  await writeFile(socketPath, "do not delete");
  await assert.rejects(
    startRpcGateway({ socketPath, maxConnections: 1, connectUpstream: async () => Promise.reject(new Error("unused")) }),
    /refusing to replace a non-socket/,
  );
  assert.equal(await readFile(socketPath, "utf8"), "do not delete");
});
