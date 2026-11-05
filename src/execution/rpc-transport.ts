import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import {
  connect as connectTls,
  createServer as createTlsServer,
  type TLSSocket,
} from "node:tls";
import { ConfigurationError } from "../errors.js";
import {
  RPC_MAX_FRAME_BYTES,
  RpcFrameDecoder,
  encodeRpcFrame,
  type RpcFrame,
} from "./rpc-protocol.js";

export type RpcPeerInfo = {
  readonly transport: "unix" | "tls";
  readonly peer?: string;
  readonly authorized: boolean;
};

export type RpcConnection = {
  readonly closed: boolean;
  send(frame: RpcFrame): void;
  close(): void;
  onFrame(handler: (frame: RpcFrame) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
};

export type RpcServer = {
  address(): { readonly host: string; readonly port: number } | { readonly path: string };
  onConnection(handler: (connection: RpcConnection, peer: RpcPeerInfo) => void): void;
  close(): Promise<void>;
};

export type RpcClientTransport = {
  connect(): Promise<RpcConnection>;
};

export type UnixClientTransportOptions = {
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly connectTimeoutMs?: number;
};

export type TlsClientConfig = {
  readonly host: string;
  readonly port: number;
  readonly servername?: string;
  readonly ca: string | Buffer;
  /** Omit only in tests that prove the server rejects a client without a certificate. */
  readonly cert?: string | Buffer;
  readonly key?: string | Buffer;
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly connectTimeoutMs?: number;
};

export type TlsServerConfig = {
  readonly host: string;
  readonly port: number;
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
  readonly ca: string | Buffer;
  readonly requireClientCert?: boolean;
  /** Common Names accepted as the gateway identity. Required when client certificates are on. */
  readonly allowedClientNames?: readonly string[];
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

class SocketRpcConnection implements RpcConnection {
  private readonly decoder: RpcFrameDecoder;
  private readonly frameHandlers = new Set<(frame: RpcFrame) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private isClosed = false;
  private closeError: Error | undefined;

  constructor(
    private readonly socket: Socket | TLSSocket,
    maxFrameBytes: number,
    private readonly maxBufferedBytes: number,
  ) {
    this.decoder = new RpcFrameDecoder(maxFrameBytes);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      let frames: RpcFrame[];
      try {
        frames = this.decoder.push(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("invalid RPC frame"));
        return;
      }
      for (const frame of frames) {
        for (const handler of this.frameHandlers) {
          try {
            handler(frame);
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error("RPC frame handler failed"));
            return;
          }
        }
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.finish());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(frame: RpcFrame): void {
    if (this.isClosed || !this.socket.writable) return;
    const encoded = encodeRpcFrame(frame);
    // High-water mark, not a hard per-frame limit: one frame may exceed it, but no further frame
    // is queued while the socket is already backed up.
    if (this.socket.writableLength > this.maxBufferedBytes) {
      this.fail(new Error("RPC send buffer exceeded its high-water mark"));
      return;
    }
    this.socket.write(encoded);
  }

  close(): void {
    if (this.isClosed) return;
    this.socket.end();
  }

  onFrame(handler: (frame: RpcFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    if (this.isClosed) {
      handler(this.closeError);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private fail(error: Error): void {
    if (this.closeError === undefined) this.closeError = error;
    this.socket.destroy();
  }

  private finish(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const handler of this.closeHandlers) handler(this.closeError);
    this.closeHandlers.clear();
    this.frameHandlers.clear();
  }
}

function closeServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket()) {
    throw new ConfigurationError("RPC Unix socket path exists and is not a socket; refusing to replace it");
  }
  await unlink(socketPath);
}

function peerCommonName(socket: TLSSocket): string | undefined {
  const certificate = socket.getPeerCertificate();
  const name = certificate.subject?.CN;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function listenWithHandler(
  server: NetServer,
  sockets: Set<Socket>,
  address: RpcServer["address"],
  maxFrameBytes: number,
  maxBufferedBytes: number,
  peerFor: (socket: Socket) => RpcPeerInfo,
): RpcServer {
  let handler: ((connection: RpcConnection, peer: RpcPeerInfo) => void) | undefined;
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (handler === undefined) {
      socket.destroy();
      return;
    }
    handler(new SocketRpcConnection(socket, maxFrameBytes, maxBufferedBytes), peerFor(socket));
  });
  return {
    address,
    onConnection(next) {
      handler = next;
    },
    close() {
      return closeServer(server, sockets);
    },
  };
}

/** Local tests and same-host deployments. The socket is owned by the caller's private directory. */
export async function listenUnixRpc(
  socketPath: string,
  options: { readonly maxFrameBytes?: number; readonly maxBufferedBytes?: number } = {},
): Promise<RpcServer> {
  await removeStaleSocket(socketPath);
  const sockets = new Set<Socket>();
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
  const result = listenWithHandler(
    server,
    sockets,
    () => ({ path: socketPath }),
    options.maxFrameBytes ?? RPC_MAX_FRAME_BYTES,
    options.maxBufferedBytes ?? 1024 * 1024,
    () => ({ transport: "unix", authorized: true }),
  );
  const close = result.close;
  return {
    ...result,
    async close() {
      await close();
      if (process.platform !== "win32") await unlink(socketPath).catch(() => {});
    },
  };
}

/**
 * Cross-VPS listener. Binds only the caller-supplied address; configuration validation rejects
 * wildcard bind addresses before this function is called. Client certificates are mandatory by
 * default, so an unauthenticated TCP peer cannot reach the dispatcher.
 */
export async function listenTlsRpc(config: TlsServerConfig): Promise<RpcServer> {
  const requireClientCert = config.requireClientCert !== false;
  if (requireClientCert && (config.allowedClientNames === undefined || config.allowedClientNames.length === 0)) {
    throw new ConfigurationError("TLS RPC listener requires at least one allowed client certificate CN");
  }
  const allowedClientNames = new Set(config.allowedClientNames ?? []);
  const sockets = new Set<Socket>();
  let handler: ((connection: RpcConnection, peer: RpcPeerInfo) => void) | undefined;
  const server = createTlsServer({
    cert: config.cert,
    key: config.key,
    ca: config.ca,
    requestCert: requireClientCert,
    rejectUnauthorized: requireClientCert,
    minVersion: "TLSv1.2",
  }, (socket: TLSSocket) => {
    const commonName = requireClientCert ? peerCommonName(socket) : undefined;
    if (requireClientCert && (!socket.authorized || commonName === undefined
      || !allowedClientNames.has(commonName))) {
      socket.destroy();
      return;
    }
    if (handler === undefined) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // The TLS server's "connection" event fires before the handshake; this callback is the
    // authenticated secure connection, so construct the protocol connection here.
    handler(new SocketRpcConnection(
      socket,
      config.maxFrameBytes ?? RPC_MAX_FRAME_BYTES,
      config.maxBufferedBytes ?? 1024 * 1024,
    ), {
      transport: "tls",
      authorized: socket.authorized,
      ...(commonName === undefined ? {} : { peer: commonName }),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const actual = server.address();
  if (actual === null || typeof actual === "string") {
    throw new ConfigurationError("RPC TLS listener did not expose a TCP address");
  }
  return {
    address: () => ({ host: actual.address, port: actual.port }),
    onConnection(next) {
      handler = next;
    },
    close() {
      return closeServer(server, sockets);
    },
  };
}

export function unixRpcTransport(
  socketPath: string,
  options: UnixClientTransportOptions = {},
): RpcClientTransport {
  return {
    async connect() {
      const socket = await connectSocket(
        (): Socket => connect({ path: socketPath }),
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      return new SocketRpcConnection(
        socket,
        options.maxFrameBytes ?? RPC_MAX_FRAME_BYTES,
        options.maxBufferedBytes ?? 1024 * 1024,
      );
    },
  };
}

export function tlsRpcTransport(config: TlsClientConfig): RpcClientTransport {
  return {
    async connect() {
      const socket = await connectTlsSocket(config);
      return new SocketRpcConnection(
        socket,
        config.maxFrameBytes ?? RPC_MAX_FRAME_BYTES,
        config.maxBufferedBytes ?? 1024 * 1024,
      );
    },
  };
}

function connectSocket(factory: () => Socket, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = factory();
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("RPC connection timed out"));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/** Shared by the RPC client and the host-network gateway; resolves after the handshake. */
export function connectTlsSocket(config: TlsClientConfig): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connectTls({
      host: config.host,
      port: config.port,
      ca: config.ca,
      ...(config.cert === undefined ? {} : { cert: config.cert }),
      ...(config.key === undefined ? {} : { key: config.key }),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(config.servername === undefined ? {} : { servername: config.servername }),
    });
    const timeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("RPC TLS connection timed out"));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("secureConnect", onConnect);
      socket.removeListener("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    socket.once("secureConnect", onConnect);
    socket.once("error", onError);
  });
}
