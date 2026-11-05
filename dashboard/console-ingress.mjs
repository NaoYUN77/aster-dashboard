// Loopback ingress for the console when the app is attached only to an internal Docker network.
//
// Docker does not publish host ports for containers whose networks are all `internal: true`
// (the port binding is silently dropped), and the MITM overlay requires exactly that: the app
// must have no route to the internet. This proxy runs in the host network namespace, accepts
// connections on the host loopback port, and forwards them to the app's fixed address on the
// internal network. It adds no writable state and no outbound connections of its own.
import net from "node:net";

function parseAddress(value, name) {
  const match = /^(.+):(\d+)$/.exec(value ?? "");
  if (!match) throw new Error(`${name} must be HOST:PORT, got ${JSON.stringify(value)}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} port out of range: ${match[2]}`);
  }
  return { host: match[1], port };
}

const listen = parseAddress(process.env.CONSOLE_INGRESS_LISTEN ?? "127.0.0.1:8787", "CONSOLE_INGRESS_LISTEN");
const target = parseAddress(process.env.CONSOLE_INGRESS_TARGET, "CONSOLE_INGRESS_TARGET");

const server = net.createServer((client) => {
  const upstream = net.connect(target);
  // Either side failing closes the pair; a half-open tunnel would leak file descriptors.
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream).pipe(client);
});

server.on("error", (error) => {
  console.error(`console ingress failed: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

server.listen(listen.port, listen.host, () => {
  console.log(`console ingress listening on ${listen.host}:${listen.port} -> ${target.host}:${target.port}`);
});
