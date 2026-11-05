import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_DIAGNOSTIC_ROWS = 100_000;
const codes = [
  "ARGUMENTS_INVALID", "VOLUME_METADATA_OK", "VOLUME_UNREADABLE", "VOLUME_NOT_DIRECTORY",
  "VOLUME_OWNER_MISMATCH", "VOLUME_MODE_UNSAFE", "STATE_UNREADABLE", "STATE_NOT_REGULAR_FILE",
  "STATE_TOO_LARGE", "STATE_OWNER_MISMATCH", "STATE_MODE_UNSAFE", "SYMLINK_NOT_ALLOWED",
  "SQLITE_UNREADABLE", "SQLITE_NOT_INITIALIZED", "SQLITE_OFFLINE_STATE_REQUIRED",
  "APP_SCHEMA_UNKNOWN", "APP_DIAGNOSTICS_LIMIT",
  "INTERNAL_ERROR",
] as const;
type Code = typeof codes[number];

export class DeploymentVolumePreflightError extends Error {
  constructor(readonly code: Code) {
    super(code);
    this.name = "DeploymentVolumePreflightError";
  }
}
function fail(code: Code): never {
  throw new DeploymentVolumePreflightError(code);
}

export interface DeploymentVolumePreflightOptions {
  appVolume: string;
  inboxDiagnostics?: boolean;
}
export interface InboxCounts {
  requests: number;
  deliveryParts: number;
  sending: number;
  uncertain: number;
  failed: number;
}

async function metadata(path: string, optional = false): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED");
    return stat;
  } catch (error) {
    if (error instanceof DeploymentVolumePreflightError) throw error;
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail("STATE_UNREADABLE");
  }
}

function permissions(stat: Stats, uid: number, directory: boolean, confidential: boolean): void {
  const subject = directory ? "VOLUME" : "STATE";
  if (stat.uid !== uid) fail(`${subject}_OWNER_MISMATCH`);
  // Check service-owner access, not the privileged operator's ability to bypass permissions.
  const required = directory ? 0o700 : 0o600;
  const forbidden = (confidential ? 0o077 : 0o022) | 0o7000 | (directory ? 0 : 0o111);
  if ((stat.mode & required) !== required || (stat.mode & forbidden) !== 0) fail(`${subject}_MODE_UNSAFE`);
}

async function directory(path: string, uid: number, confidential = false): Promise<void> {
  let stat: Stats | undefined;
  try {
    stat = await metadata(path);
  } catch (error) {
    if (error instanceof DeploymentVolumePreflightError && error.code === "STATE_UNREADABLE") fail("VOLUME_UNREADABLE");
    throw error;
  }
  if (!stat?.isDirectory()) fail("VOLUME_NOT_DIRECTORY");
  permissions(stat, uid, true, confidential);
}

async function regularFile(path: string, uid: number, confidential: boolean, optional = false): Promise<Stats | undefined> {
  const stat = await metadata(path, optional);
  if (!stat) return undefined;
  if (!stat.isFile()) fail("STATE_NOT_REGULAR_FILE");
  permissions(stat, uid, false, confidential);
  if (stat.size > MAX_DATABASE_BYTES) fail("STATE_TOO_LARGE");
  try {
    // A FIFO cannot block this open even if the offline input was replaced between checks.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) fail("STATE_NOT_REGULAR_FILE");
      if (opened.size > MAX_DATABASE_BYTES) fail("STATE_TOO_LARGE");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof DeploymentVolumePreflightError) throw error;
    fail("STATE_UNREADABLE");
  }
  return stat;
}

/** Only a read-only filesystem mount makes SQLite WAL reads unable to modify/create SHM. */
async function readOnlyMount(path: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const file = await open("/proc/self/mountinfo", constants.O_RDONLY | constants.O_NONBLOCK);
    let text: string;
    try {
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length === bytes.length) return false;
      text = bytes.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
    let match: { length: number; readOnly: boolean } | undefined;
    for (const line of text.split("\n")) {
      const fields = line.split(" ");
      if (fields.length < 7) continue;
      const mount = fields[4]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (path !== mount && !path.startsWith(mount === "/" ? "/" : `${mount}/`)) continue;
      if (!match || mount.length > match.length) match = { length: mount.length, readOnly: fields[5]!.split(",").includes("ro") };
    }
    return match?.readOnly ?? false;
  } catch {
    return false;
  }
}

async function inspectDatabase<T>(path: string, uid: number, confidential: boolean, inspect: (db: DatabaseSync) => T): Promise<T> {
  const stat = await regularFile(path, uid, confidential);
  if (!stat || stat.size === 0) fail("SQLITE_NOT_INITIALIZED");
  const wal = await regularFile(`${path}-wal`, uid, confidential, true);
  await regularFile(`${path}-shm`, uid, confidential, true);
  const journal = await regularFile(`${path}-journal`, uid, confidential, true);
  // A hot rollback journal requires recovery writes. Never recover it during a preflight.
  if (journal && journal.size > 0) fail("SQLITE_OFFLINE_STATE_REQUIRED");
  const hasWal = wal !== undefined && wal.size > 0;
  if (hasWal && !await readOnlyMount(path)) fail("SQLITE_OFFLINE_STATE_REQUIRED");
  const uri = pathToFileURL(path);
  // immutable skips WAL, so use it only when there is no WAL to ignore. On a read-only
  // mount normal mode can read committed WAL, or fail closed if SQLite needs recovery.
  if (!hasWal) uri.searchParams.set("immutable", "1");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(uri.href, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0; BEGIN");
    return inspect(db);
  } catch (error) {
    if (error instanceof DeploymentVolumePreflightError) throw error;
    return fail("SQLITE_UNREADABLE");
  } finally {
    db?.close();
  }
}

function isTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? AND rootpage > 0").get(name) !== undefined;
}

function inspectInbox(db: DatabaseSync, diagnostics: boolean): InboxCounts | undefined {
  if (!["checkpoint", "identity", "inbox", "deliveries", "failures"].every((name) => isTable(db, name))) fail("APP_SCHEMA_UNKNOWN");
  if (!diagnostics) return undefined;
  const counts: InboxCounts = { requests: 0, deliveryParts: 0, sending: 0, uncertain: 0, failed: 0 };
  for (const [table, target] of [["inbox", "requests"], ["deliveries", "deliveryParts"]] as const) {
    // Bound both work and returned data; never select user text, identifiers or failure messages.
    const row = db.prepare(`SELECT count(*) AS total,
      coalesce(sum(status = 'sending'), 0) AS sending,
      coalesce(sum(status = 'uncertain'), 0) AS uncertain,
      coalesce(sum(status = 'failed'), 0) AS failed,
      coalesce(sum(status IS NULL OR status NOT IN ('pending','ready','sending','sent','failed','uncertain')), 0) AS invalid
      FROM (SELECT status FROM ${table} LIMIT ${MAX_DIAGNOSTIC_ROWS + 1})`).get()!;
    if (Number(row.total) > MAX_DIAGNOSTIC_ROWS) fail("APP_DIAGNOSTICS_LIMIT");
    if (row.invalid !== 0) fail("APP_SCHEMA_UNKNOWN");
    counts[target] = Number(row.total);
    // sending/uncertain/failed count delivery parts, including pre-recovery 'sending'.
    if (table === "deliveries") {
      counts.sending = Number(row.sending);
      counts.uncertain = Number(row.uncertain);
      counts.failed = Number(row.failed);
    }
  }
  return counts;
}

/** Offline metadata only. The caller must stop all writers and mount the volume read-only.
 * No password verification, decryption, migrations, recovery, ACL audit or full-volume integrity claim.
 */
export async function preflightDeploymentVolumes(options: DeploymentVolumePreflightOptions): Promise<{
  status: "offline-volume-metadata-ok";
  code: "VOLUME_METADATA_OK";
  productionAdmission: "not-evaluated";
  inbox?: InboxCounts;
}> {
  if (!(typeof options.appVolume === "string" && isAbsolute(options.appVolume) && !options.appVolume.includes("\0"))
    || (options.inboxDiagnostics !== undefined && typeof options.inboxDiagnostics !== "boolean")) fail("ARGUMENTS_INVALID");
  const app = resolve(options.appVolume);
  // Check each component below the explicit volume root; never walk arbitrary volume contents.
  await directory(app, 1000);
  await inspectDatabase(join(app, "agent.sqlite"), 1000, false, (db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND rootpage > 0 LIMIT 1").get()) fail("SQLITE_NOT_INITIALIZED");
  });
  const inbox = await inspectDatabase(join(app, "inbox.sqlite"), 1000, false, (db) => inspectInbox(db, options.inboxDiagnostics === true));
  return { status: "offline-volume-metadata-ok", code: "VOLUME_METADATA_OK", productionAdmission: "not-evaluated", ...(inbox ? { inbox } : {}) };
}

const help = `Usage: node dist/src/deployment-volume-preflight.js \\
  --app-volume /app-data [--inbox-diagnostics]
Run in the application image with the initialized volume mounted read-only and all writers stopped.
Checks selected file ownership/mode and the app databases' shape; never verifies a password or decrypts data.
Optional inbox counts report sending/uncertain/failed delivery parts without blocking backup or changing them.
Nonempty WAL requires a verified Linux read-only mount; recovery-dependent databases fail closed.
Exit 0 is offline metadata success only; productionAdmission is always not-evaluated.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, tokens } = parseArgs({
      options: { "app-volume": { type: "string" }, "inbox-diagnostics": { type: "boolean" }, help: { type: "boolean" } },
      strict: true, allowPositionals: false, tokens: true,
    });
    if (new Set(tokens.map((token) => token.kind === "option" ? token.name : "")).size !== tokens.length) fail("ARGUMENTS_INVALID");
    if (values.help === true && tokens.length === 1) console.log(help);
    else {
      if (values.help || !values["app-volume"]) fail("ARGUMENTS_INVALID");
      console.log(JSON.stringify(await preflightDeploymentVolumes({
        appVolume: values["app-volume"], inboxDiagnostics: values["inbox-diagnostics"],
      })));
    }
  } catch (error) {
    console.error(JSON.stringify({
      status: "offline-volume-metadata-failed",
      code: error instanceof DeploymentVolumePreflightError ? error.code : error instanceof TypeError ? "ARGUMENTS_INVALID" : "INTERNAL_ERROR",
      productionAdmission: "not-evaluated",
    }));
    process.exitCode = 1;
  }
}
