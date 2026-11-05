import type { Context } from "@earendil-works/chord/context";
import type {
  AgentState, ConversationId, Cursor, DocumentAddress, DocumentCreate, DocumentId, JsonObject,
  Storage, StorageWrite, StoredDocument,
} from "@earendil-works/pi-durable";
import type { ToolRecord, ToolRegistry } from "./tools.js";

const CATALOG_KIND = "personal.tools.catalog";
const LEDGER_KIND = "personal.tools.loads";
const VERSION = 1;

export type ToolLoad = {
  readonly name: string;
  readonly loadSequence: number;
  readonly epoch: number;
  /** Registration as observed when loaded; null means it was absent during legacy migration. */
  readonly registration: ToolRecord | null;
};
type Ledger = {
  sequence: number;
  epoch: number;
  /** Startup resident MCP selection; absent in TOOL-01/02 records, meaning no pins. */
  resident?: string[];
  /** Metadata for the most recent load of each name; membership remains owned by pi.agent. */
  loads: Record<string, ToolLoad>;
};

const catalogAddress: DocumentAddress = { kind: CATALOG_KIND, scope: { kind: "session" } };
const ledgerAddress = (conversationId: ConversationId): DocumentAddress => ({
  kind: LEDGER_KIND, scope: { kind: "conversation", conversationId },
});

async function find(storage: Storage, address: DocumentAddress, context: Context): Promise<StoredDocument | undefined> {
  const record = await storage.findDocument(address, "current", context);
  return record === undefined ? undefined : storage.document(record.id, "current", context);
}

function value<T>(document: StoredDocument): T {
  if (document.version !== VERSION) throw new Error(`Unsupported ${document.record.kind} version: ${document.version}`);
  return document.value as unknown as T;
}

/** Stored selections, including tools temporarily absent from the registry. No resolved-agent filtering. */
function loadedNames(agent: AgentState): string[] {
  const selection = agent.modelTools;
  return [...new Set(Array.isArray(selection) ? selection : selection?.add ?? [])];
}

function append(ledger: Ledger, names: readonly string[], registry: Pick<ToolRegistry, "lookup">): void {
  if (names.length === 0) return;
  ledger.epoch++;
  for (const name of names) {
    Object.defineProperty(ledger.loads, name, {
      value: { name, loadSequence: ++ledger.sequence, epoch: ledger.epoch, registration: registry.lookup(name) ?? null },
      enumerable: true, configurable: true, writable: true,
    });
  }
}

function baseline(agent: AgentState, registry: Pick<ToolRegistry, "lookup">): Ledger {
  const ledger: Ledger = { sequence: 0, epoch: 0, loads: {} };
  // Legacy records know ordering, but not the historical append batches. One baseline epoch.
  append(ledger, loadedNames(agent), registry);
  return ledger;
}

async function ledgerWrite(
  storage: Storage, conversationId: ConversationId, ledger: Ledger, existing: StoredDocument | undefined, context: Context,
): Promise<StorageWrite> {
  const content = { version: VERSION, kind: "base" as const, value: ledger as unknown as JsonObject };
  return existing === undefined
    ? {
        type: "document.create",
        record: {
          id: await storage.mintId<DocumentId>(), ...ledgerAddress(conversationId),
          history: "rewindable", fork: "asOf",
        } as DocumentCreate,
        content,
      }
    : { type: "document.change", id: existing.record.id, content };
}

/** Settled resident selection; a restart with live work must preserve it. */
export async function readResidentTools(storage: Storage, conversationId: ConversationId, context: Context): Promise<readonly string[]> {
  const document = await find(storage, ledgerAddress(conversationId), context);
  return document === undefined ? [] : value<Ledger>(document).resident ?? [];
}

/** Storage-owned diagnostics: use these readers, never Session doc/snapshot/watch APIs. */
export async function readToolCatalog(storage: Storage, context: Context): Promise<readonly ToolRecord[]> {
  const document = await find(storage, catalogAddress, context);
  return document === undefined ? [] : value<{ records: ToolRecord[] }>(document).records;
}

export async function readToolLedger(storage: Storage, conversationId: ConversationId, context: Context) {
  const agent = await find(storage, { kind: "pi.agent", scope: { kind: "conversation", conversationId } }, context);
  const document = await find(storage, ledgerAddress(conversationId), context);
  if (document === undefined) return undefined;
  const ledger = value<Ledger>(document);
  const names = loadedNames((agent?.value ?? {}) as AgentState);
  return {
    sequence: ledger.sequence,
    epoch: ledger.epoch,
    loads: names.map((name) => {
      const load = Object.hasOwn(ledger.loads, name) ? ledger.loads[name] : undefined;
      if (load === undefined) throw new Error(`Missing tool load metadata: ${name}`);
      return load;
    }),
  };
}

const isGithub = (record: ToolRecord | null | undefined): boolean =>
  record?.source.kind === "mcp" && record.source.server === "github";

function sameGithubApproval(before: ToolRecord | null | undefined, after: ToolRecord | undefined): boolean {
  return isGithub(before) && isGithub(after) && typeof before?.githubApproval === "string"
    && before.githubApproval.length > 0 && before.githubApproval === after?.githubApproval;
}

/** Read before startup catalog synchronization. This is evidence, never an approval source. */
export async function inspectGithubToolRecovery(storage: Storage, registry: ToolRegistry, context: Context) {
  const catalog = await readToolCatalog(storage, context);
  const prior = new Map(catalog.map((record) => [record.name, record]));
  const current = registry.records().filter(isGithub);
  const old = catalog.filter(isGithub);
  const catalogChanged = old.length !== current.length
    || old.some((record) => !sameGithubApproval(record, registry.lookup(record.name)));
  const conversations: { id: ConversationId; remove: string[] }[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, cursor, context);
    for (const conversation of page.items) {
      const agent = await find(storage, { kind: "pi.agent", scope: { kind: "conversation", conversationId: conversation.id } }, context);
      const document = await find(storage, ledgerAddress(conversation.id), context);
      const ledger = document === undefined ? undefined : value<Ledger>(document);
      const names = loadedNames((agent?.value ?? {}) as AgentState);
      const githubNames = names.filter((name) => isGithub(ledger?.loads[name]?.registration)
        || isGithub(prior.get(name)) || isGithub(registry.lookup(name)));
      const oldGithubPins = ledger?.resident?.some((name) => isGithub(prior.get(name))) ?? false;
      const changed = oldGithubPins || githubNames.some((name) => !sameGithubApproval(
        ledger === undefined ? prior.get(name) : ledger.loads[name]?.registration, registry.lookup(name),
      ));
      if (changed || (catalogChanged && (githubNames.length > 0 || ledger?.resident?.some((name) => isGithub(prior.get(name)))))) {
        conversations.push({ id: conversation.id, remove: githubNames.filter((name) => {
          const record = registry.lookup(name);
          return !isGithub(record) || !record?.githubApproval || record.state !== "available";
        }) });
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { changed: catalogChanged || conversations.length > 0, conversations };
}

export type ToolLedgerOptions = {
  /** Hold the old catalog until the host has checked paused recovery and settled idle boundaries. */
  readonly catalogSync?: () => boolean;
};

/**
 * Native 1.3.0 checkpoints pi.agent as a base. Add metadata to that same atomic Storage commit,
 * without changing agent state or search/control semantics. These sidecars are intentionally
 * storage-owned: Session cannot adopt writes it did not plan, so it must never cache them.
 */
export async function withToolLedger(storage: Storage, registry: ToolRegistry, context: Context, options: ToolLedgerOptions = {}): Promise<Storage> {
  let revision = 0;
  let persistedRevision = -1;
  const unsubscribe = registry.subscribe(() => { revision++; });
  // Bound record classification memory; a miss costs one raw storage read, never a Session call.
  const records = new Map<DocumentId, { kind: string; scope: DocumentAddress["scope"] }>();
  const remember = (id: DocumentId, record: { kind: string; scope: DocumentAddress["scope"] }) => {
    records.set(id, record);
    if (records.size > 256) records.delete(records.keys().next().value!);
  };

  async function catalogWrites(context: Context): Promise<StorageWrite[]> {
    const existing = await find(storage, catalogAddress, context);
    const entries = registry.records();
    if (existing !== undefined && JSON.stringify(value<{ records: ToolRecord[] }>(existing).records) === JSON.stringify(entries)) return [];
    const content = { version: VERSION, kind: "base" as const, value: { records: entries } as unknown as JsonObject };
    return [existing === undefined
      ? { type: "document.create", record: { id: await storage.mintId<DocumentId>(), ...catalogAddress } as DocumentCreate, content }
      : { type: "document.change", id: existing.record.id, content }];
  }

  async function commit(writes: readonly StorageWrite[], context: Context) {
    const atRevision = revision;
    const result = [...writes];
    const syncCatalog = options.catalogSync?.() ?? true;
    if (syncCatalog && persistedRevision !== atRevision) result.push(...await catalogWrites(context));
    const changes = new Map<ConversationId, { ledger: Ledger; existing: StoredDocument | undefined }>();
    const copiedLedgers = new Map<ConversationId, Extract<StorageWrite, { type: "document.copy" }>>();
    for (const write of writes) {
      if (write.type === "document.copy" && write.record.kind === LEDGER_KIND && write.record.scope.kind === "conversation") {
        copiedLedgers.set(write.record.scope.conversationId, write);
      }
    }
    for (const write of writes) {
      if (write.type !== "document.create" && write.type !== "document.copy" && write.type !== "document.change") continue;
      const record = write.type === "document.change"
        ? records.get(write.id) ?? (await storage.document(write.id, "current", context))?.record
        : write.record;
      if (record === undefined) continue; // Let the backend report an invalid native write.
      remember(write.type === "document.change" ? write.id : write.record.id, record);
      if (record.kind !== "pi.agent" || record.scope.kind !== "conversation") continue;
      let next: AgentState;
      if (write.type === "document.copy") {
        const source = await storage.document(write.source.id, write.source.at, context);
        if (source === undefined) throw new Error("Missing agent copy source");
        next = source.value as AgentState;
      } else {
        if (write.content.kind !== "base" || write.content.version !== 1) throw new Error("Unsupported pi.agent storage format");
        next = write.content.value as AgentState;
      }
      const conversationId = record.scope.conversationId;
      const previous = write.type === "document.change" ? await storage.document(write.id, "current", context) : undefined;
      const copied = copiedLedgers.get(conversationId);
      const existing = copied === undefined
        ? await find(storage, ledgerAddress(conversationId), context)
        : await storage.document(copied.source.id, copied.source.at, context);
      const created = writes.find((candidate) => candidate.type === "conversation" && candidate.value.id === conversationId);
      const parent = created?.type === "conversation" ? created.value.parent : undefined;
      let forkAgent: StoredDocument | undefined;
      if (parent !== undefined) {
        const entry = await storage.entry(parent.conversationId, parent.at, context);
        if (entry === undefined) throw new Error("Missing tool ledger fork entry");
        const source = await storage.findDocument({
          kind: "pi.agent", scope: { kind: "conversation", conversationId: entry.entry.conversationId },
        }, entry.commitSeq, context);
        if (source !== undefined) forkAgent = await storage.document(source.id, entry.commitSeq, context);
      }
      const before = (previous?.value ?? forkAgent?.value ?? {}) as AgentState;
      const ledger = existing === undefined ? baseline(before, registry) : value<Ledger>(existing);
      const oldNames = new Set(loadedNames(before));
      const additions = loadedNames(next).filter((name) => !oldNames.has(name));
      // A native fork already copies both documents at the same historical point.
      if (copied !== undefined && write.type === "document.copy") continue;
      append(ledger, additions, registry);
      if (existing !== undefined && additions.length === 0) continue;
      changes.set(conversationId, { ledger, existing });
    }
    // Pin changes settle with an explicit context head, never with an ordinary model/tool commit.
    const boundaries = new Set(writes.flatMap((write) =>
      write.type === "entry" && write.value.kind === "pi.reset" ? [write.value.conversationId] : []
    ));
    const resident = registry.records().filter((record) => record.source.kind === "mcp" && record.tier === 1)
      .map(({ name }) => name).sort();
    for (const conversationId of boundaries) {
      const copied = copiedLedgers.get(conversationId);
      const existing = changes.get(conversationId)?.existing ?? (copied === undefined
        ? await find(storage, ledgerAddress(conversationId), context)
        : await storage.document(copied.source.id, copied.source.at, context));
      const ledger = changes.get(conversationId)?.ledger ?? (existing === undefined
        ? { sequence: 0, epoch: 0, loads: {} } : value<Ledger>(existing));
      const agentWrite = writes.findLast((write) => {
        if (write.type !== "document.change" && write.type !== "document.create") return false;
        const record = write.type === "document.change" ? records.get(write.id) : write.record;
        return record?.kind === "pi.agent" && record.scope.kind === "conversation" && record.scope.conversationId === conversationId;
      });
      const agent = await find(storage, { kind: "pi.agent", scope: { kind: "conversation", conversationId } }, context);
      const state = agentWrite !== undefined && (agentWrite.type === "document.change" || agentWrite.type === "document.create")
        && agentWrite.content.kind === "base" ? agentWrite.content.value as AgentState : (agent?.value ?? {}) as AgentState;
      const refresh = loadedNames(state).filter((name) => {
        const registration = registry.lookup(name);
        return isGithub(registration) && registration?.githubApproval && registration.state === "available"
          && !sameGithubApproval(ledger.loads[name]?.registration, registration);
      });
      const nextNames = new Set(loadedNames(state));
      const removedGithub = loadedNames((agent?.value ?? {}) as AgentState)
        .some((name) => !nextNames.has(name) && isGithub(ledger.loads[name]?.registration));
      if (JSON.stringify(ledger.resident ?? []) === JSON.stringify(resident) && refresh.length === 0 && !removedGithub) continue;
      ledger.resident = resident;
      ledger.epoch++;
      for (const name of refresh) {
        const load = ledger.loads[name];
        // A declaration refresh is a new epoch, never a new load or a rewrite of history.
        if (load === undefined) throw new Error(`Missing tool load metadata: ${name}`);
        ledger.loads[name] = { ...load, epoch: ledger.epoch, registration: registry.lookup(name)! };
      }
      changes.set(conversationId, { ledger, existing });
    }
    for (const [conversationId, { ledger, existing }] of changes) {
      const copied = copiedLedgers.get(conversationId);
      if (copied === undefined) {
        result.push(await ledgerWrite(storage, conversationId, ledger, existing, context));
      } else {
        // Preserve the historical high water mark and identity staged by the native fork.
        result.splice(result.indexOf(copied), 1, {
          type: "document.create", record: copied.record,
          content: { version: VERSION, kind: "base", value: ledger as unknown as JsonObject },
        });
      }
    }
    const seq = await storage.commit(result, context);
    if (syncCatalog) persistedRevision = atRevision;
    return seq;
  }

  try {
    // Migrate every existing conversation before Session opens; no task is started by migration.
    const initial: StorageWrite[] = [];
    const priorCatalog = new Map((await readToolCatalog(storage, context)).map((record) => [record.name, record]));
    const migrationRegistry = { lookup(name: string) {
      const current = registry.lookup(name);
      const prior = priorCatalog.get(name);
      // Never stamp a legacy loaded GitHub declaration with the newly observed approval.
      return isGithub(current) || isGithub(prior) ? prior : current;
    } };
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanConversations({}, 100, cursor, context);
      for (const conversation of page.items) {
        const existing = await find(storage, ledgerAddress(conversation.id), context);
        if (existing !== undefined) { value<Ledger>(existing); continue; }
        const agent = await find(storage, { kind: "pi.agent", scope: { kind: "conversation", conversationId: conversation.id } }, context);
        if (agent !== undefined) initial.push(await ledgerWrite(storage, conversation.id, baseline(agent.value as AgentState, migrationRegistry), undefined, context));
      }
      cursor = page.next;
      // Keep migration writes bounded on a host with a long conversation history.
      if (initial.length > 0) await storage.commit(initial.splice(0), context);
    } while (cursor !== undefined);
    if (options.catalogSync?.() ?? true) {
      const atRevision = revision;
      const catalog = await catalogWrites(context);
      if (catalog.length > 0) await storage.commit(catalog, context);
      persistedRevision = atRevision;
    }
  } catch (error) {
    unsubscribe();
    await storage.close(context).catch(() => {});
    throw error;
  }
  return new Proxy(storage, {
    get(target, property) {
      if (property === "commit") return commit;
      if (property === "close") return async (context: Context) => {
        unsubscribe();
        await storage.close(context);
      };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
