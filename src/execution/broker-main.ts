import { createHash } from "node:crypto";
import { ConfigurationError } from "../errors.js";
import { describeBrokerConfig, readBrokerConfig } from "./broker-config.js";
import { startBrokerServer } from "./broker.js";
import { createSshRunner } from "./ssh.js";

const USAGE = `Usage: node dist/src/execution/broker-main.js [--check]

Reads EXECUTION_BROKER_SOCKET and EXECUTION_SSH_* from the environment. --check validates the
configuration and prints the resolved target without opening the socket or running SSH.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = readBrokerConfig();
  if (process.argv.includes("--check")) {
    process.stdout.write(`${JSON.stringify(describeBrokerConfig(config), null, 2)}\n`);
    return;
  }
  const executionId = createHash("sha256")
    .update(`${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`)
    .digest("hex")
    .slice(0, 16);
  const server = await startBrokerServer({
    socketPath: config.socketPath,
    executionId,
    runner: createSshRunner(config),
    maxConcurrent: config.maxConcurrent,
    maxOutputBytes: config.maxOutputBytes,
    maxOutputLines: config.maxOutputLines,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  console.info(`Execution broker listening on its private socket; SSH target ${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await main();
} catch (error) {
  // Broker messages are operator-facing and this application writes them; SDK errors could carry
  // paths or credentials, so anything else is reported as a fixed code only.
  console.error("Execution broker stopped:",
    error instanceof ConfigurationError ? error.message : "BROKER_FAILED");
  process.exitCode = 1;
}
