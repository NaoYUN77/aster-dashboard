// A host-network RPC gateway for the app container.
//
// The app container only joins the internal MITM network; ADR-0021 keeps it from routing to the
// execution VPS directly. This gateway runs in its own container on the host network namespace,
// speaks mTLS to the execution agent with the `aster-gateway` client certificate, and exposes a
// Unix socket that the app container mounts from the host. Frames are relayed byte for byte: the
// gateway is a transport boundary, not an RPC endpoint, so it cannot observe, replay or authorize
// individual calls. Authentication is the TLS client certificate; the Unix socket is mode 0600 and
// lives in a directory only uid 1000 can traverse.

import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export type RpcGatewayLogEvent = Readonly<Record<string, string | number | boolean | null>>;

export type RpcGatewayOptions = {
  /** Host-side Unix socket the app container mounts; it must be an absolute path on a local fs. */
  readonly socketPath: string;
  /** Bounds concurrent tunnels so a dead app connection cannot accumulate forever. */
  readonly maxConnections: number;
  /** Resolves only after the upstream is authenticated and ready; rejects to refuse the client. */
  readonly connectUpstream: () => Promise<Duplex>;
  readonly log?: (event: RpcGatewayLogEvent) => void;
};

export type RpcGateway = {
  readonly socketPath: string;
  close(): Promise<void>;
};

type Tunnel = {
  readonly client: Socket;
  upstream: Duplex | undefined;
};

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

/**
 * Refuse to replace anything but a stale Unix socket. Removing a regular file here would be a
 * destructive side effect of a misconfigured path, so it fails closed instead.
 */
async function prepareSocketPath(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw new Error(`refusing to replace a non-socket at ${socketPath}`);
    await unlink(socketPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function startRpcGateway(options: RpcGatewayOptions): Promise<RpcGateway> {
  const log = options.log ?? (() => undefined);
  const tunnels = new Set<Tunnel>();

  const server: Server = createServer((client) => {
    if (tunnels.size >= options.maxConnections) {
      log({ event: "rpc-gateway-rejected", reason: "max-connections" });
      client.destroy();
      return;
    }
    client.setNoDelay(true);
    const tunnel: Tunnel = { client, upstream: undefined };
    tunnels.add(tunnel);
    client.once("close", () => {
      tunnel.upstream?.destroy();
      tunnels.delete(tunnel);
    });
    client.once("error", () => {
      tunnel.upstream?.destroy();
      client.destroy();
    });
    options.connectUpstream().then(
      (upstream) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        tunnel.upstream = upstream;
        upstream.once("error", (error) => {
          log({ event: "rpc-gateway-upstream-error", code: errorCode(error) });
          client.destroy();
        });
        upstream.once("close", () => client.destroy());
        // `pipe` propagates end-of-stream in both directions; errors are handled above.
        client.pipe(upstream);
        upstream.pipe(client);
      },
      (error: unknown) => {
        log({ event: "rpc-gateway-upstream-failed", code: errorCode(error) });
        client.destroy();
      },
    );
  });

  await prepareSocketPath(options.socketPath);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });
  // The app runs as uid 1000; anyone else on the host must not be able to talk to the agent
  // through this socket. The containing directory stays 0700.
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(options.socketPath).catch(() => undefined);
    throw error;
  }
  log({ event: "rpc-gateway-ready", socketPath: options.socketPath, maxConnections: options.maxConnections });

  let closing: Promise<void> | undefined;
  return {
    socketPath: options.socketPath,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const tunnel of tunnels) {
          tunnel.upstream?.destroy();
          tunnel.client.destroy();
        }
        tunnels.clear();
        await closed;
        await unlink(options.socketPath).catch(() => undefined);
        log({ event: "rpc-gateway-closed" });
      })();
      return closing;
    },
  };
}
