// Retrieval tools (MEM-07): the native `memory_search` / `memory_read` over Daily Memory.
//
// The host binds the store (its root directory) and the budget when it constructs these tools; no
// parameter can select another root, another conversation, or a larger budget. Results enter C
// through the ordinary tool-result path, like every other tool. A search with no hits is a
// successful result that says what was scanned — it is never an error — while a failed read or a
// damaged file is an error result carrying the mapped application code, so the two are never
// confused. Only `MemoryError`s become error results; anything else (a storage or Session
// failure) is thrown, so a broken base is never disguised as a memory business error.
//
// Budgets (design §10): one result is capped at `budget.searchResultTokens`, and the results of
// one user request together at `budget.requestSearchTokens`. The cumulative spend is recomputed
// from durable records on every call — the tool results already in C after the current request's
// own user entry — so a restart mid-request recounts exactly what the context already holds
// instead of trusting an in-memory counter. The host runs tools sequentially within a request,
// so two calls of one request cannot race this accounting.

import { Type } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import {
  DAILY_MAX_PAGES,
  MemoryError,
  type MemoryBudget,
} from "./contracts.js";
import {
  DAILY_LIMITS,
  readSegment,
  searchDaily,
  type DailySearch,
  type DailyStore,
  type SearchCursor,
  type StoredRecord,
} from "./daily.js";

export type MemoryToolsOptions = {
  readonly store: DailyStore;
  readonly budget: MemoryBudget;
};

const RETRIEVAL_TOOLS = new Set(["memory_search", "memory_read"]);
/** Pages of history one budget recount scans before it stops at the current request's input. */
const SPEND_SCAN_PAGES = 10;
const SPEND_PAGE_ENTRIES = 100;

const KindEnum = Type.Union([
  Type.Literal("goal"),
  Type.Literal("decision"),
  Type.Literal("result"),
  Type.Literal("problem"),
  Type.Literal("user-requirement"),
  Type.Literal("open-item"),
]);

const searchOutputSchema = Type.Object(
  {
    hits: Type.Array(
      Type.Object(
        {
          id: Type.String({ maxLength: 64 }),
          date: Type.String({ maxLength: 16 }),
          page: Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES }),
          kind: KindEnum,
          status: Type.String({ maxLength: 16 }),
          file: Type.String({ maxLength: 32 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: DAILY_LIMITS.hits },
    ),
    scannedFiles: Type.Integer({ minimum: 0 }),
    scannedSegments: Type.Integer({ minimum: 0 }),
    available: Type.Integer({ minimum: 0 }),
    unread: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    nextCursor: Type.Union([Type.String({ maxLength: 8_192 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const readOutputSchema = Type.Object(
  {
    found: Type.Boolean(),
    reason: Type.Union([Type.Literal("missing-file"), Type.Literal("missing-segment"), Type.Null()]),
    id: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    date: Type.Union([Type.String({ maxLength: 16 }), Type.Null()]),
    page: Type.Union([Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES }), Type.Null()]),
    kind: Type.Union([KindEnum, Type.Null()]),
    status: Type.Union([Type.String({ maxLength: 16 }), Type.Null()]),
    supersededBy: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** One hit as the model reads it: stable identity, provenance, then the fact itself. */
function renderHit(record: StoredRecord): string {
  const segment = record.segment;
  const replaced = segment.supersededBy === null ? "" : `\nsuperseded by: ${segment.supersededBy}`;
  const replaces = segment.supersedes.length === 0 ? "" : `\nsupersedes: ${segment.supersedes.join(", ")}`;
  return `[${segment.id}] date ${segment.date}, page ${segment.page}, file ${record.file}, ${segment.kind}/${segment.status}`
    + `\nsources: conversation ${segment.sources.conversationId}, entries (${segment.sources.after ?? 0}, ${segment.sources.through}]`
    + `${replaces}${replaced}\n${segment.text}`;
}

function searchFooter(search: DailySearch, returned: number, total: number): string {
  const unread = search.unread.length === 0 ? "none" : `${search.unread.length} file(s): ${search.unread.slice(0, 10).join(", ")}`;
  return `scanned: ${search.scanned.files} file(s), ${search.scanned.segments} segment(s) (range files available: ${search.available}); `
    + `not scanned: ${unread}; superseded records excluded: ${search.historyExcluded}; returned ${returned} of ${total} hit(s) in this page`;
}

type ErrorResult = {
  readonly isError: true;
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly diagnostics: { readonly severity: "error"; readonly code: string; readonly message: string }[];
};

function errorResult(error: MemoryError): ErrorResult {
  return {
    isError: true,
    output: [{ type: "text", text: `${error.appCode} (${error.code}): ${error.message}` }],
    diagnostics: [{ severity: "error", code: error.appCode, message: error.message }],
  };
}

function budgetResult(budget: MemoryBudget, spent: number) {
  const error = new MemoryError("budget-exceeded", "This request's memory retrieval budget is exhausted", {
    detail: { limit: budget.requestSearchTokens, spent },
  });
  return errorResult(error);
}

/**
 * Tokens this request already spent on retrieval, recounted from durable tool results in C after
 * the newest user entry. The current call's own result does not exist yet, so it is never counted
 * against itself. A scan that cannot find the request boundary within its bound reports what it
 * found; it never invents a smaller spend.
 */
async function spentInCurrentRequest(api: ToolExecutionApi, context: Context): Promise<number> {
  return api.commit(async (tx) => {
    let spent = 0;
    let cursor: Parameters<typeof tx.scanEntries>[2];
    for (let page = 0; page < SPEND_SCAN_PAGES; page += 1) {
      const scan = await tx.scanEntries(
        { conversationId: api.conversationId, order: "descending" },
        SPEND_PAGE_ENTRIES,
        cursor,
      );
      let boundary = false;
      for (const entry of scan.items) {
        if (entry.kind === "pi.user") {
          boundary = true;
          break;
        }
        if (entry.kind !== "pi.tool-result") continue;
        for (const message of entry.model ?? []) {
          if (message.role !== "toolResult" || !RETRIEVAL_TOOLS.has(message.toolName)) continue;
          const text = typeof message.content === "string"
            ? message.content
            : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          spent += estimateTextTokens(text);
        }
      }
      if (boundary || scan.next === undefined) return spent;
      cursor = scan.next;
    }
    return spent;
  }, context);
}

/** Opaque, versioned paging token: the Daily cursor, byte-preserved for the next call. */
function encodeCursor(cursor: SearchCursor): string {
  return `mc1.${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeCursor(value: string): SearchCursor {
  const fail = () => new MemoryError("invalid-input", "The search cursor is not one this tool issued");
  if (!value.startsWith("mc1.")) throw fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8"));
  } catch {
    throw fail();
  }
  const cursor = parsed as SearchCursor | null;
  if (
    cursor === null || typeof cursor !== "object"
    || typeof cursor.file !== "string" || !Number.isInteger(cursor.index) || cursor.index < 0
    || !(cursor.fileDigest === null || typeof cursor.fileDigest === "string")
    || !Array.isArray(cursor.covered)
    || cursor.covered.some((file) => typeof file?.file !== "string" || typeof file?.size !== "number" || typeof file?.mtimeMs !== "number")
  ) throw fail();
  return cursor;
}

/** Retrieval tools bound to one host store and budget; no parameter widens either. */
export function memoryTools(options: MemoryToolsOptions): ToolRegistration[] {
  const { store, budget } = options;

  const search = defineTool({
    name: "memory_search",
    description:
      "Search long-term daily memory for dated facts. Returns bounded hits with their segment id, date, file and source entries, says which files were scanned and which were not, and returns a cursor when more hits remain. An empty result means the scanned range held no match; it is not an error. Follow up with memory_read for one full record.",
    parameters: Type.Object(
      {
        text: Type.Optional(Type.String({ maxLength: 200, description: "Case-insensitive substring of the fact text." })),
        from: Type.Optional(Type.String({ pattern: "^(\\d{4}-\\d{2}-\\d{2}|unknown)$", description: "Earliest event date, inclusive." })),
        through: Type.Optional(Type.String({ pattern: "^(\\d{4}-\\d{2}-\\d{2}|unknown)$", description: "Latest event date, inclusive." })),
        kinds: Type.Optional(Type.Array(KindEnum, { maxItems: 6 })),
        includeHistory: Type.Optional(Type.Boolean({ description: "Also return records a later record superseded. Default false." })),
        cursor: Type.Optional(Type.String({ maxLength: 8_192, description: "The nextCursor of a previous memory_search in this chain." })),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: searchOutputSchema,
    replay: "safe",
    execute: async (args, api, context) => {
      try {
        const spent = await spentInCurrentRequest(api, context);
        const remaining = budget.requestSearchTokens - spent;
        if (remaining <= 0) return budgetResult(budget, spent);
        const cap = Math.min(budget.searchResultTokens, remaining);
        const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);
        const query = {
          ...(args.text === undefined ? {} : { text: args.text }),
          ...(args.from === undefined ? {} : { from: args.from }),
          ...(args.through === undefined ? {} : { through: args.through }),
          ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
          ...(args.includeHistory === undefined ? {} : { includeHistory: args.includeHistory }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: DAILY_LIMITS.hits,
        };
        const page = await searchDaily(store, query);

        // Render whole hits while they fit the cap. A hit that does not fit is never silently
        // dropped: the resume cursor is re-derived at exactly the first unreturned hit.
        const rendered: string[] = [];
        const shown: StoredRecord[] = [];
        let used = 0;
        let truncated = false;
        for (const hit of page.hits) {
          const text = renderHit(hit);
          const tokens = estimateTextTokens(text);
          if (used + tokens > cap) {
            truncated = true;
            if (shown.length === 0) {
              // Even the first hit exceeds the cap: show its head, marked, and keep the cursor at
              // the same hit; the full record is reachable unchanged through memory_read.
              rendered.push(`${text.slice(0, Math.max(64, cap * 2))}\n[truncated by the retrieval budget; read the full record with memory_read]`);
              shown.push(hit);
            }
            break;
          }
          rendered.push(text);
          shown.push(hit);
          used += tokens;
        }
        let next: SearchCursor | null = page.next;
        if (truncated && shown.length < page.hits.length) {
          // Re-run the same page bounded at the hits actually shown: Daily positions the returned
          // cursor before the first hit that did not fit, so nothing is skipped or repeated.
          const bounded = await searchDaily(store, { ...query, limit: Math.max(1, shown.length) });
          next = bounded.next ?? cursor ?? null;
        }
        const footer = searchFooter(page, shown.length, page.hits.length);
        const cursorLine = next === null ? "" : `\nnext cursor: ${encodeCursor(next)}`;
        const body = rendered.length === 0
          ? `no matches\n${footer}${cursorLine}`
          : `${rendered.join("\n\n")}\n${footer}${truncated ? "\nresult budget reached; continue with the cursor for the remaining hits" : ""}${cursorLine}`;
        return {
          output: [{ type: "text", text: body }],
          structuredOutput: {
            hits: shown.map((record) => ({
              id: record.segment.id,
              date: record.segment.date,
              page: record.segment.page,
              kind: record.segment.kind,
              status: record.segment.status,
              file: record.file,
            })),
            scannedFiles: page.scanned.files,
            scannedSegments: page.scanned.segments,
            available: page.available,
            unread: page.unread.length,
            truncated,
            nextCursor: next === null ? null : encodeCursor(next),
          },
          details: { scannedFiles: page.scanned.files, available: page.available },
        };
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error;
        return errorResult(error);
      }
    },
  });

  const read = defineTool({
    name: "memory_read",
    description:
      "Read one daily memory record by the id, date and page a memory_search hit reported. A missing file or missing record is a normal not-found result, distinct from a read failure. The record keeps its source range and supersession state.",
    parameters: Type.Object(
      {
        id: Type.String({ pattern: "^[A-Za-z0-9._:#-]{1,64}$" }),
        date: Type.String({ pattern: "^(\\d{4}-\\d{2}-\\d{2}|unknown)$" }),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES })),
      },
      { additionalProperties: false },
    ),
    structuredOutputSchema: readOutputSchema,
    replay: "safe",
    execute: async (args, api, context) => {
      try {
        const spent = await spentInCurrentRequest(api, context);
        const remaining = budget.requestSearchTokens - spent;
        if (remaining <= 0) return budgetResult(budget, spent);
        const lookup = await readSegment(store, { id: args.id, date: args.date, ...(args.page === undefined ? {} : { page: args.page }) });
        if (!lookup.found) {
          const text = lookup.reason === "missing-file"
            ? `not found: no daily memory file for ${args.date} page ${args.page ?? 1}`
            : `not found: no record ${args.id} in the daily memory file for ${args.date} page ${args.page ?? 1}`;
          return {
            output: [{ type: "text", text }],
            structuredOutput: {
              found: false, reason: lookup.reason, id: null, date: null, page: null, kind: null, status: null, supersededBy: null,
            },
          };
        }
        const cap = Math.min(budget.searchResultTokens, remaining);
        let text = renderHit(lookup.record);
        if (estimateTextTokens(text) > cap) {
          text = `${text.slice(0, Math.max(64, cap * 2))}\n[truncated by the retrieval budget]`;
        }
        const segment = lookup.record.segment;
        return {
          output: [{ type: "text", text }],
          structuredOutput: {
            found: true,
            reason: null,
            id: segment.id,
            date: segment.date,
            page: segment.page,
            kind: segment.kind,
            status: segment.status,
            supersededBy: segment.supersededBy,
          },
        };
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error;
        return errorResult(error);
      }
    },
  });

  return [search, read];
}

/** The extension the composition root registers alongside the working tools. */
export function memoryToolsExtension(options: MemoryToolsOptions) {
  return defineExtension({ name: "memory-retrieval", tools: memoryTools(options) });
}
