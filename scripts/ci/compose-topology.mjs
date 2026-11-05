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
  telegramToken: `900001:${randomBytes(24).toString("hex")}`,
  modelKey: random("model"),
};
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

function command(program, args, { input, allowFailure = false, timeout = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, COMPOSE_ENV_FILES: "", COMPOSE_DISABLE_ENV_FILE: "1",
        ASTER_IMAGE: images.app } });
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
  // Synthetic app environment: a well-formed token and owner, a real provider/model pair, and
  // deliberately no provider key. The config-failure check below relies on exactly that gap.
  await writeFile(file("app.env"), [
    `TELEGRAM_BOT_TOKEN=${credentials.telegramToken}`,
    "TELEGRAM_OWNER_ID=424242",
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
    assert.equal(app.environment.TELEGRAM_BOT_TOKEN, credentials.telegramToken);
    assert.equal(app.environment.MODEL_PROVIDER, "deepseek");
    assert.equal(app.environment.DEEPSEEK_API_KEY, undefined);
    assert.deepEqual(Object.keys(config.volumes), ["personal-agent-data"]);
    assert.equal(config.volumes["personal-agent-data"].name, `${project}-app`);
    const mounts = (app.volumes ?? []).filter((volume) => volume.target === "/data");
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].source, "personal-agent-data");
    for (const volume of Object.values(config.volumes)) assert.ok(!volume.external);
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
    console.info("NOT COVERED: live Telegram/model business flow (needs real credentials; covered by unit tests and the production deployment); release/prod admission.");
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
