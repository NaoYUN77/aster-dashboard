import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.js";
import { parseCatalogProfile, parseToolScope, serializeCatalogProfile } from "./tool-catalog.js";

/** Upgrade-only mapping. No runtime configuration or authorization depends on these old labels. */
function legacyProfile(value: unknown): string {
  if (value !== "assistant" && value !== "chief" && value !== "researcher" && value !== "research" && value !== "programmer") {
    throw new StateError("Cannot migrate bot without a valid catalog profile or legacy role");
  }
  return serializeCatalogProfile({
    core: true, shell: true, files: true, web: value === "researcher" || value === "research",
    ptc: false, memory: true, reminders: false, mcp: true,
  });
}

/** Called inside the Inbox upgrade transaction, after nullable predecessor columns are added. */
export function migrateBotCatalog(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(bots)").all();
  if (!columns.some((column) => column.name === "role")) return;

  const update = db.prepare("UPDATE bots SET profile = ?, toolScope = ? WHERE botId = ?");
  for (const row of db.prepare("SELECT botId, role, profile, toolScope FROM bots").all()) {
    if (typeof row.botId !== "string") throw new StateError("Bot id is invalid during catalog migration");
    let profile: string;
    if (row.profile === null || row.profile === "") profile = legacyProfile(row.role);
    else if (row.profile === "chief" || row.profile === "research" || row.profile === "programmer") profile = legacyProfile(row.profile);
    else if (typeof row.profile === "string") {
      parseCatalogProfile(row.profile);
      profile = row.profile;
    } else throw new StateError("Bot catalog profile is invalid during migration");
    const scope = row.toolScope === null || row.toolScope === "" ? '{"allow":[],"deny":[]}' : row.toolScope;
    if (typeof scope !== "string") throw new StateError("Bot tool scope is invalid during migration");
    parseToolScope(scope);
    update.run(profile, scope, row.botId);
  }
  // Data conversion and removal are atomic. A failed conversion leaves the old schema recoverable.
  db.exec("ALTER TABLE bots DROP COLUMN role");
}
