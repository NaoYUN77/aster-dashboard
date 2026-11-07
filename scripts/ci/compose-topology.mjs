import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../..");
const renderOnly = process.argv.includes("--render-only");
const project = `aster-ci-topology-${randomBytes(6).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), `${project}-`));
const images = { app: process.env.ASTER_IMAGE ?? "aster:ci" };
const random = (name) => `ci-${name}-${randomBytes(24).toString("hex")}`;
const credentials = {
  modelKey: random("model"),
};
const dashboardToken = random("webtoken");
const file = (name) => join(directory, name).replaceAll("\\", "/");
let step = "prepare";
let checks = 0;
let created = false;
const suppliedRehearsalImage = process.env.ASTER_DEPLOYMENT_TOOLS_IMAGE;
const rehearsalImage = suppliedRehearsalImage ?? `${project}-deploy-tools:ci`;
const rehearsalContainer = `${project}-deploy-tools`;
const restoredVolume = `${project}-restored-app`;
let rehearsalBuilt = false;
let rehearsalVolumeCreated = false;
let failureCode = "CHECK_FAILED";
const composeArgs = ["compose", "--project-name", project, "--project-directory", root,
  "--env-file", file("empty.env"), "-f", join(root, "docker-compose.yml"),
  "-f", join(root, "docker-compose.build.yml"), "-f", file("override.yml")];

function command(program, args, { input, allowFailure = false, timeout = 120_000, env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, COMPOSE_ENV_FILES: "", COMPOSE_DISABLE_ENV_FILE: "1",
        ASTER_IMAGE: images.app, ...env } });
    let output = "";
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const capture = (chunk) => {
      if (output.length + chunk.length > 4 * 1024 * 1024) { overflow = true; child.kill(); }
      else output += chunk.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", () => { clearTimeout(timer); reject(new Error(`command unavailable during ${step}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!overflow && !timedOut && (code === 0 || allowFailure)) resolvePromise({ code, output });
      else {
        failureCode = output.includes("env file") ? "COMPOSE_ENV_FILE"
          : output.includes("yaml") ? "COMPOSE_YAML" : `COMMAND_EXIT_${code ?? "SIGNAL"}`;
        reject(new Error(`command failed during ${step}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const docker = (...args) => command("docker", args);
const compose = (...args) => docker(...composeArgs, ...args);
function assertClean(text) {
  for (const secret of Object.values(credentials)) {
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")]) {
      assert.ok(!text.includes(value), "synthetic credential appeared in prohibited output");
    }
  }
}
async function check(name, fn) {
  step = name;
  await fn();
  checks++;
  console.info(`PASS ${name}`);
}

try {
  assert.ok(process.argv.slice(2).every((value) => value === "--render-only"), "unsupported option");
  await chmod(directory, 0o755);
  await writeFile(file("empty.env"), "");
  // Synthetic app environment: a real provider/model pair and deliberately no provider key.
  // The config-failure check below relies on exactly that gap.
  await writeFile(file("app.env"), [
    "MODEL_PROVIDER=deepseek",
    "MODEL_ID=deepseek-flash",
    "",
  ].join("\n"), { mode: 0o600 });
  const override = `services:
  personal-agent:
    env_file: !override
      - ${JSON.stringify(file("app.env"))}
volumes:
  personal-agent-data:
    name: ${project}-app
`;
  await writeFile(file("override.yml"), override, { mode: 0o600 });
  // The dashboard overlay reads its own env file; CI points it at a synthetic one instead of
  // requiring a developer's `dashboard/.env`.
  await writeFile(file("dashboard.env"), [
    `WEB_TOKEN=${dashboardToken}`,
    "MODEL_PROVIDER=deepseek",
    "MODEL_ID=deepseek-flash",
    `DEEPSEEK_API_KEY=${credentials.modelKey}`,
    "",
  ].join("\n"), { mode: 0o600 });
  const dashboardArgs = ["compose", "--project-name", `${project}-dashboard`,
    "--project-directory", root, "--env-file", file("dashboard.env"),
    "-f", join(root, "docker-compose.yml"),
    "-f", join(root, "dashboard/docker-compose.dashboard.yml")];
  const dashboardEnv = {
    ASTER_DASHBOARD_ENV_FILE: file("dashboard.env"),
    ASTER_EXECUTION_RUNTIME_VOLUME: `${project}-runtime`,
    ASTER_EXECUTION_WORKSPACES_VOLUME: `${project}-workspaces`,
  };
  await check("compose-single-service-and-production-boundaries", async () => {
    const result = await compose("config", "--format", "json");
    const config = JSON.parse(result.output);
    assert.deepEqual(Object.keys(config.services), ["personal-agent"]);
    const app = config.services["personal-agent"];
    assert.equal(app.image, images.app);
    assert.ok(app.build, "the build overlay must contribute the build definition");
    assert.equal(app.restart, "unless-stopped");
    assert.equal(app.init, true);
    assert.equal(app.stop_grace_period, "45s");
    assert.deepEqual(app.cap_drop, ["ALL"]);
    assert.ok(app.security_opt?.includes("no-new-privileges:true"));
    assert.ok(!app.ports?.length, "the app must not publish ports");
    assert.ok(!app.network_mode, "the app uses direct networking");
    assert.equal(app.environment.DATA_DIR, "/data");
    // The synthetic env file is the one being read: its values are inlined by rendering.
    assert.ok(!Object.keys(app.environment).some((name) => name.startsWith("TELEGRAM_")));
    assert.equal(app.environment.MODEL_PROVIDER, "deepseek");
    assert.equal(app.environment.DEEPSEEK_API_KEY, undefined);
    assert.deepEqual(Object.keys(config.volumes), ["personal-agent-data"]);
    assert.equal(config.volumes["personal-agent-data"].name, `${project}-app`);
    const mounts = (app.volumes ?? []).filter((volume) => volume.target === "/data");
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].source, "personal-agent-data");
    for (const volume of Object.values(config.volumes)) assert.ok(!volume.external);
  });
  await check("dashboard-two-services-shared-host-and-loopback-console", async () => {
    const result = await command("docker", [...dashboardArgs, "config", "--format", "json"], { env: dashboardEnv });
    const config = JSON.parse(result.output);
    assert.deepEqual(Object.keys(config.services).sort(), ["execution-host", "personal-agent"]);
    const app = config.services["personal-agent"];
    const host = config.services["execution-host"];
    // Both services use the repository's one image: there is no separate sandbox image to build.
    assert.equal(app.build.dockerfile, "Dockerfile");
    assert.equal(host.build.dockerfile, "Dockerfile");
    assert.equal(host.image, images.app);

    // The console is reachable only from the host's loopback address.
    assert.deepEqual(app.ports, [{
      mode: "ingress", target: 8787, published: "8787", protocol: "tcp", host_ip: "127.0.0.1",
    }]);
    assert.equal(String(app.mem_limit), String(2 * 1024 * 1024 * 1024));
    assert.equal(app.pids_limit, 256);
    // The overlay's env file replaced the base one; its synthetic values are the ones rendered.
    assert.equal(app.environment.WEB_TOKEN, dashboardToken);
    assert.ok(!Object.keys(app.environment).some((name) => name.startsWith("TELEGRAM_")));
    assert.equal(app.environment.CONSOLE_ENABLED, "1");
    assert.equal(app.environment.CONSOLE_HOST, "0.0.0.0");
    assert.equal(app.environment.CONSOLE_PORT, "8787");
    assert.equal(app.environment.EXECUTION_MODE, "remote");
    assert.equal(app.environment.EXECUTION_REMOTE_TRANSPORT, "rpc");
    assert.equal(app.environment.EXECUTION_REMOTE_CWD, "/workspaces");
    assert.equal(app.environment.EXECUTION_RPC_TRANSPORT, "unix");
    assert.equal(app.environment.EXECUTION_RPC_SOCKET, "/run/aster/rpc.sock");
    // Retired feature configuration must not reappear in the app environment.
    assert.ok(!Object.keys(app.environment).some((name) => /^(CODEMODE_|PTC_|REMINDERS_)/u.test(name)));
    assert.equal(app.depends_on["execution-host"].condition, "service_healthy");

    // The local stand-in runs as a dedicated non-root uid and claims no OS isolation boundary:
    // it is one shared host for every bot, not a per-bot container.
    assert.equal(host.user, "1000:1000");
    assert.ok(!host.network_mode, "a shared host must not claim a network-none isolation boundary");
    assert.ok(!host.read_only, "the shared host needs a writable workspace and socket directory");
    assert.ok(!host.cap_drop, "the shared host does not rely on capability dropping for isolation");
    assert.ok(!host.ports?.length, "the shared host must not publish ports");
    assert.deepEqual(host.entrypoint, ["node", "dist/src/execution/rpc-main.js"]);
    assert.equal(host.environment.EXECUTION_AGENT_SHARED_HOST, "1");
    assert.equal(host.environment.EXECUTION_AGENT_UNIX_SOCKET, "/run/aster/rpc.sock");
    assert.equal(host.environment.EXECUTION_AGENT_WORKSPACES, "/workspaces");
    assert.equal(host.environment.EXECUTION_AGENT_TMP_ROOT, "/tmp/aster-sessions");
    assert.equal(host.environment.EXECUTION_AGENT_SHELL, "/bin/bash");
    assert.equal(host.environment.EXECUTION_AGENT_MAX_CONCURRENT, "3");
    assert.equal(host.environment.EXECUTION_AGENT_TEST_EXECUTOR, "0");
    assert.equal(host.environment.EXECUTION_AGENT_OUTPUT_CHUNK_BYTES, "32768");
    assert.equal(host.environment.EXECUTION_AGENT_OUTPUT_BYTES_PER_SECOND, "4194304");
    assert.ok(!Object.keys(host.environment).some((name) => /^(TELEGRAM_|CODEMODE_|PTC_|REMINDERS_)/u.test(name)));

    // Only the workspaces and socket volumes are mounted; the app's /data volume is never shared.
    assert.deepEqual(host.volumes.map((volume) => volume.target).sort(), ["/run/aster", "/workspaces"]);
    const appSocket = app.volumes.find((volume) => volume.target === "/run/aster");
    const hostSocket = host.volumes.find((volume) => volume.target === "/run/aster");
    assert.ok(appSocket, "the app must mount the socket volume");
    assert.ok(hostSocket, "the execution host must mount the socket volume");
    assert.equal(appSocket.source, hostSocket.source);
    assert.equal(appSocket.read_only, true);
    const workspaces = host.volumes.find((volume) => volume.target === "/workspaces");
    assert.equal(workspaces.source, "execution-workspaces");
    // Rendered volume sources are the compose keys; the `name` override is what isolates the run.
    assert.equal(config.volumes["execution-runtime"].name, `${project}-runtime`);
    assert.equal(config.volumes["execution-workspaces"].name, `${project}-workspaces`);
    assert.equal(appSocket.source, "execution-runtime");
    // No remote execution gateway service is part of this overlay.
    assert.ok(!Object.keys(config.services).some((name) => name.includes("gateway")));
  });
  if (!renderOnly) {
    await check("final-image-present", async () => {
      await docker("image", "inspect", images.app, "--format", "{{.Id}}");
    });
    created = true;
    await check("missing-provider-key-fails-without-echoing-credentials", async () => {
      const result = await command("docker", [...composeArgs, "run", "--rm", "--no-deps", "personal-agent"],
        { allowFailure: true, timeout: 60_000 });
      assert.equal(result.code, 1);
      assert.ok(result.output.includes("DEEPSEEK_API_KEY"), "the failure must name the missing variable");
      assertClean(result.output);
    });
    await check("single-instance-volume-lock", async () => {
      const holder = `${project}-lock-holder`;
      await docker("run", "--detach", "--name", holder, "--pull", "never",
        "--mount", `type=volume,source=${project}-app,target=/data`,
        "--entrypoint", "flock", images.app, "/data/app.lock", "sleep", "60");
      try {
        const result = await command("docker", [...composeArgs, "run", "--rm", "--no-deps", "personal-agent"],
          { allowFailure: true, timeout: 30_000 });
        assert.equal(result.code, 1, "same-volume second entrypoint must fail flock");
        assertClean(result.output);
      } finally {
        await docker("rm", "--force", holder);
      }
    });
    await check("offline-volume-preflight-and-whole-volume-backup-restore", async () => {
      // Initialize the app volume with schema-shaped synthetic databases, the same shapes the
      // volume-preflight unit fixtures use; no business run is needed for a backup rehearsal.
      const init = `
        import {mkdirSync, chmodSync} from 'node:fs';
        import {DatabaseSync} from 'node:sqlite';
        mkdirSync('/data/workspace', {recursive: true});
        const agent = new DatabaseSync('/data/agent.sqlite');
        agent.exec('CREATE TABLE state(id INTEGER PRIMARY KEY)');
        agent.close();
        const inbox = new DatabaseSync('/data/inbox.sqlite');
        inbox.exec(\`CREATE TABLE checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL);
          CREATE TABLE identity(id INTEGER PRIMARY KEY CHECK(id=1), botId TEXT NOT NULL, ownerId TEXT NOT NULL);
          CREATE TABLE inbox(requestId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT NOT NULL,
            text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT, receivedAt TEXT, repliedAt TEXT);
          CREATE TABLE deliveries(requestId TEXT NOT NULL REFERENCES inbox(requestId) ON DELETE CASCADE,
            part INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            messageId TEXT, error TEXT, createdAt TEXT, updatedAt TEXT, PRIMARY KEY(requestId,part));
          CREATE TABLE failures(requestId TEXT PRIMARY KEY REFERENCES inbox(requestId), code TEXT NOT NULL);
          INSERT INTO checkpoint VALUES(1,0);\`);
        inbox.close();
        chmodSync('/data/agent.sqlite', 0o600);
        chmodSync('/data/inbox.sqlite', 0o600);
      `;
      await docker("run", "--rm", "--pull", "never", "--network", "none",
        "--mount", `type=volume,source=${project}-app,target=/data`,
        "--entrypoint", "node", images.app, "--input-type=module", "-e", init);
      const appId = (await docker("image", "inspect", images.app, "--format", "{{.Id}}")).output.trim();
      if (suppliedRehearsalImage) {
        await docker("image", "inspect", rehearsalImage);
      } else {
        await docker("build", "--file", join(source, "deployment-tools.Dockerfile"),
          "--build-arg", `APP_IMAGE=${images.app}`, "--tag", rehearsalImage, root);
        rehearsalBuilt = true;
      }
      rehearsalVolumeCreated = true;
      await docker("volume", "create", restoredVolume);
      // Only the disposable operator gets the socket; the application container never does.
      const result = await command("docker", ["run", "--rm", "--name", rehearsalContainer, "--pull", "never",
        "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--tmpfs", "/backups:mode=700,size=256m",
        "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
        rehearsalImage, "/ci/deployment-rehearsal.sh", appId, `${project}-app`, restoredVolume],
      { timeout: 180_000 });
      assertClean(result.output);
      assert.ok(result.output.includes("deployment-backup-rehearsal-ok"));
    });
    await check("container-logs-do-not-contain-synthetic-credentials", async () => {
      const logs = await compose("logs", "--no-color");
      assertClean(logs.output);
    });
    console.info(`Topology acceptance passed: ${checks} checks; final image; isolated synthetic resources.`);
    console.info("NOT COVERED: live dashboard/model business flow (needs real credentials and target-environment acceptance); release/prod admission.");
  } else {
    console.info("Compose render checks passed; runtime topology was not executed.");
  }
} catch (error) {
  const line = error?.stack?.match(/compose-topology\.mjs:(\d+):/u)?.[1];
  console.error(`Topology acceptance FAILED: ${step} (${failureCode}${line ? `; check-line ${line}` : ""})`);
  process.exitCode = 1;
} finally {
  if (rehearsalVolumeCreated) {
    try {
      await command("docker", ["rm", "--force", rehearsalContainer, `${project}-app-backup-writer`], { allowFailure: true });
      await docker("volume", "rm", restoredVolume);
    } catch { console.error("Deployment rehearsal cleanup FAILED"); process.exitCode = 1; }
  }
  if (rehearsalBuilt) {
    try { await docker("image", "rm", rehearsalImage); }
    catch { console.error("Deployment operator image cleanup FAILED"); process.exitCode = 1; }
  }
  if (created) {
    try {
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "20");
    } catch { console.error(`Topology cleanup FAILED for isolated project ${project}`); process.exitCode = 1; }
  }
  await rm(directory, { recursive: true, force: true });
}
