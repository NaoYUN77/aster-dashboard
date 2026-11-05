// Daily Memory Module (MEM-04): publish dated facts to Markdown and read them back bounded.
//
// Interface
//   openDaily(root)                     -> a store rooted at a host-controlled directory
//   publishSegments(store, segments)    -> `PublishReceipt[]`, one per segment
//   readSegment(store, ref)             -> `SegmentLookup`; absence is a value, not an error
//   searchDaily(store, query)           -> `DailySearch`: hits, what was scanned, what was not
//
// Inputs are already-validated `MemorySegment`s and a root directory the host owns. This module
// starts no Harness and calls no model; it reads and writes files under `root/memory/daily` only.
//
// File format: one Markdown file per event date, named by `dailyFileName(date, page)`. A header line
// is followed by one block per segment:
//
//   <!-- memory-segment:begin
//   {"digest":"…","segment":{…}}
//   -->
//   <the segment's text, verbatim>
//   <!-- memory-segment:end -->
//
// The meta line is canonical JSON (sorted keys), so re-rendering an unchanged file is byte-identical.
// The digest covers the segment's own canonical JSON, which includes the text: any edit to a record
// is a `corrupt-state`, never a silently different fact. A file is replaced by writing a temp file in
// the same directory, syncing it, then renaming over the target, so a reader sees the whole old file
// or the whole new one.
//
// Reading is strict: a date file may hold a header, blank lines and well-formed blocks, and nothing
// else. Content this module did not write is `corrupt-state` rather than skipped, because a damaged
// marker would otherwise make the record invisible and the next publish would rewrite the file
// without it. Line endings are normalized to LF at the boundary, so one fact has one stored form.
//
// Ordering: records append in the order given. Ids are unique per date file. Publishing the same id
// with the same content is a `duplicate` receipt and appends nothing; the same id with different
// content is `revision-conflict`. Identity is the published content, not the record's later state:
// superseding a record does not make replaying its original publish a conflict.
//
// Supersession is written on the old record (`supersededBy`) before the replacement is appended, and
// that holds across files too: every file carrying a mark is written first, on its own, and only then
// are files that receive new records written. A crash in between can lose the new record but never
// leave the old one reading as current.
//
// Bounds: `DAILY_LIMITS` bounds segments per file, file bytes, files scanned and hits returned per
// call. A publish that would exceed a file bound is refused with `budget-exceeded` — the caller moves
// to the next page — never split silently. A read stops one byte past the byte bound instead of
// buffering the whole file. A search reports the range it scanned and the files it did not, so "no
// hits" is never mistaken for "no history".

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertSchema,
  canonicalJson,
  DAILY_DIRECTORY,
  dailyFileName,
  MemoryError,
  MemorySegmentSchema,
  UNKNOWN_DATE,
  type MemorySegment,
} from "./contracts.js";

/** Bounds on one file and one call; part of this module's interface, not stored data. */
export const DAILY_LIMITS = {
  segmentsPerFile: 500,
  fileBytes: 1024 * 1024,
  scanFiles: 20,
  scanFilesMax: 200,
  scanSegments: 5_000,
  hits: 20,
  hitsMax: 100,
} as const;

const BEGIN = "<!-- memory-segment:begin";
const META_END = "-->";
const END = "<!-- memory-segment:end -->";
/** A well-formed file name, used only to inspect the directories above it. */
const DAILY_PROBE = "0000-01-01.md";

export type DailyStore = { readonly root: string };

/** A record as stored: the segment, the digest of its exact content, and the file holding it. */
export type StoredRecord = {
  readonly segment: MemorySegment;
  readonly digest: string;
  readonly file: string;
};

/** Stable reference to one record; `page` defaults to the first page. */
export type SegmentRef = { readonly id: string; readonly date: string; readonly page?: number };

/** Absence is a value: a missing file and a missing record inside one are different facts. */
export type SegmentLookup =
  | { readonly found: true; readonly record: StoredRecord }
  | { readonly found: false; readonly reason: "missing-file" | "missing-segment" };

export type PublishReceipt = {
  readonly id: string;
  readonly date: string;
  readonly page: number;
  readonly digest: string;
  readonly file: string;
  /** `duplicate` means this id and content were already stored; nothing was appended. */
  readonly status: "published" | "duplicate";
};

export type SegmentKind = MemorySegment["kind"];

export type DailyQuery = {
  /** Inclusive date bounds, `YYYY-MM-DD` or `unknown`. Omitted means unbounded. */
  readonly from?: string;
  readonly through?: string;
  readonly kinds?: readonly SegmentKind[];
  /** Case-insensitive substring over the segment text. */
  readonly text?: string;
  /** Include records a later record supersedes. Default `false`: only current facts. */
  readonly includeHistory?: boolean;
  readonly limit?: number;
  readonly maxFiles?: number;
  readonly cursor?: SearchCursor;
};

/**
 * Where to resume: a file, an index in it, and the state of the files already consumed. `fileDigest`
 * pins the content of the file being resumed, captured when it was read. `covered` records the files
 * that were fully scanned before it, with the size and modification time observed immediately before
 * each read — not the state at the moment the cursor was issued. That distinction is the whole point:
 * a record appended to an already-consumed file after it was read must be detected, not folded into
 * the cursor's own fingerprint.
 * A backfill before a cursor with a pinned position makes the cursor stale: a single-position cursor
 * cannot track both the backfill and the unfinished file across pages.
 */
export type SearchCursor = {
  readonly file: string;
  readonly index: number;
  readonly fileDigest: string | null;
  readonly covered: readonly CoveredFile[];
};

/** A file as it was when this scan read it; only files that were actually read are listed. */
export type CoveredFile = {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
};

export type DailySearch = {
  readonly hits: readonly StoredRecord[];
  /** The files this call actually read; `null` when it read none. */
  readonly scanned: {
    readonly files: number;
    readonly segments: number;
    readonly from: string | null;
    readonly through: string | null;
  };
  /** Files in range this call did not scan, because a bound was reached. */
  readonly unread: readonly string[];
  /** Files in range, scanned or not: zero here is the only "no history at all" answer. */
  readonly available: number;
  /** Records skipped because a later record supersedes them. */
  readonly historyExcluded: number;
  readonly next: SearchCursor | null;
};

/** A store rooted at an absolute directory the host controls. */
export function openDaily(root: string): DailyStore {
  if (!isAbsolute(root)) throw new MemoryError("invalid-input", "The daily memory root must be an absolute path");
  return { root: resolve(root) };
}

/** Stable identity of a segment's exact stored content, text and supersession state included. */
export function digestOfSegment(segment: MemorySegment): string {
  return createHash("sha256").update(canonicalJson(segment)).digest("hex").slice(0, 16);
}

/**
 * Identity of what was *published*, which is what a retry has to match. `supersededBy` is excluded:
 * it changes when a later record replaces this one, and that must not turn replaying the original
 * publish into a conflict. The stored digest keeps it, because the file must still detect edits.
 */
export function identityOfSegment(segment: MemorySegment): string {
  return digestOfSegment({ ...segment, supersededBy: null });
}

/** Publish segments, one receipt per input. Calls on one root are serialized in process. */
export async function publishSegments(
  store: DailyStore,
  segments: readonly MemorySegment[],
): Promise<readonly PublishReceipt[]> {
  if (segments.length === 0) return [];
  if (segments.length > DAILY_LIMITS.segmentsPerFile) {
    throw new MemoryError("budget-exceeded", "One publish call exceeds the segments-per-file bound", {
      detail: { limit: DAILY_LIMITS.segmentsPerFile, count: segments.length },
    });
  }
  // Validate before taking the lock: a bad input must not hold up other writers.
  const incoming = segments.map((value) => {
    const validated = assertSchema<MemorySegment>(MemorySegmentSchema, value, "invalid-input");
    // Line endings are normalized here, before the digest: the file stores LF, so a CRLF body would
    // otherwise be published under a digest the reader can never reproduce.
    const segment: MemorySegment = { ...validated, text: normalizeNewlines(validated.text) };
    assertTextIsMarkable(segment.text);
    return { segment, identity: identityOfSegment(segment), file: dailyFileName(segment.date, segment.page) };
  });
  return withLock(store.root, () => write(store, incoming));
}

/** Read one record by its stable reference. A missing file or record is reported, not thrown. */
export async function readSegment(store: DailyStore, ref: SegmentRef): Promise<SegmentLookup> {
  const file = dailyFileName(ref.date, ref.page ?? 1);
  const content = await readDailyFile(store, file);
  if (content === undefined) return { found: false, reason: "missing-file" };
  const record = parseFile(file, content).find((entry) => entry.segment.id === ref.id);
  return record === undefined ? { found: false, reason: "missing-segment" } : { found: true, record };
}

/**
 * Search dated records. The result always says what was read and what was left, so empty `hits` is
 * distinguishable from "there is nothing there". `scanned.from`/`through` name files, not dates: a
 * range can end in the middle of a date's pages, and both are `null` when nothing was read.
 */
export async function searchDaily(store: DailyStore, query: DailyQuery = {}): Promise<DailySearch> {
  const limit = bounded(query.limit, DAILY_LIMITS.hits, DAILY_LIMITS.hitsMax, "limit");
  const maxFiles = bounded(query.maxFiles, DAILY_LIMITS.scanFiles, DAILY_LIMITS.scanFilesMax, "maxFiles");
  const inRange = (await listFiles(store)).filter((file) => inDateRange(file, query.from, query.through));
  const start = resumeAt(inRange, query.cursor);
  // Every file recorded in `covered` was fully scanned by the call that issued the cursor. If one of
  // them grew since — a record was appended behind the cursor — resuming would skip it silently.
  // The size and mtime are re-observed now and compared with what the scan saw, so a change that
  // happened after the cursor was built is caught rather than absorbed into the cursor itself. A file
  // that is *gone* is not a skipped record: there is nothing left in it to skip, so the scan goes on.
  if (query.cursor !== undefined) {
    for (const covered of query.cursor.covered) {
      const now = await observe(store, covered.file);
      if (now !== null && (now.size !== covered.size || now.mtimeMs !== covered.mtimeMs)) {
        throw new MemoryError("stale", "A date file changed since the cursor was issued", {
          detail: { file: covered.file, expected: covered, found: now },
        });
      }
    }
  }

  const hits: StoredRecord[] = [];
  const unread: string[] = [];
  const covered: CoveredFile[] = [...(query.cursor?.covered ?? [])];
  const consumed = new Set(covered.map((entry) => entry.file));
  let files = 0;
  let scannedSegments = 0;
  let historyExcluded = 0;
  let next: SearchCursor | null = null;
  let scannedFrom: string | null = null;
  let scannedThrough: string | null = null;

  /** A cursor at the start of the file after `index`, or `null` when nothing is left. */
  const after = (index: number): SearchCursor | null => {
    const following = inRange[index + 1];
    if (following === undefined) return null;
    return { file: following, index: 0, fileDigest: null, covered: [...covered] };
  };

  outer: for (let fileIndex = start.begin; fileIndex < inRange.length; fileIndex += 1) {
    const file = inRange[fileIndex];
    if (file === undefined) break;
    // Already fully scanned by an earlier page and just verified unchanged.
    if (consumed.has(file)) continue;
    if (files >= maxFiles || scannedSegments >= DAILY_LIMITS.scanSegments) {
      next = { file, index: 0, fileDigest: null, covered: [...covered] };
      unread.push(...inRange.slice(fileIndex));
      break;
    }
    // Observed immediately before the read: this is the state the scan is about to consume, so a
    // later comparison against it detects changes made after this point.
    const before = await observe(store, file);
    const content = await readDailyFile(store, file);
    if (content === undefined || before === null) {
      // A listed file that is gone by the time it is read is reported as unread, not as an empty
      // scan: the caller must be able to tell "examined and empty" from "not examined". It is not
      // added to `covered` — it does not exist, so there is nothing to protect, and recording it
      // would make the next call stale against a file that will never come back.
      unread.push(file);
      next = after(fileIndex);
      continue;
    }
    scannedFrom ??= file;
    const fileDigest = digestOfFile(content);
    const records = parseFile(file, content);
    const from = file === query.cursor?.file ? query.cursor.index : 0;
    if (query.cursor !== undefined && file === query.cursor.file) {
      if (query.cursor.fileDigest !== null && query.cursor.fileDigest !== fileDigest) {
        throw new MemoryError("stale", "The date file changed since the cursor was issued", {
          detail: { file, expected: query.cursor.fileDigest, found: fileDigest },
        });
      }
      if (from > records.length) {
        throw new MemoryError("stale", "The cursor points past the end of the date file", {
          detail: { file, index: from, segments: records.length },
        });
      }
    }
    files += 1;
    scannedThrough = file;

    for (let position = from; position < records.length; position += 1) {
      const record = records[position];
      if (record === undefined) continue;
      const current = record.segment.supersededBy === null || query.includeHistory === true;
      const hit = admits(record.segment, query);
      if (hit && current) {
        if (hits.length >= limit) {
          // The position is taken before the hit that did not fit, so resuming returns it first.
          next = { file, index: position, fileDigest, covered: [...covered] };
          unread.push(...inRange.slice(fileIndex + 1));
          break outer;
        }
        hits.push(record);
      }
      if (hit && !current) historyExcluded += 1;
      scannedSegments += 1;
      if (scannedSegments >= DAILY_LIMITS.scanSegments) {
        next = { file, index: position + 1, fileDigest, covered: [...covered] };
        unread.push(...inRange.slice(fileIndex + 1));
        break outer;
      }
    }
    // The whole file was scanned, so it joins `covered` with the state observed before the read.
    covered.push({ file, size: before.size, mtimeMs: before.mtimeMs });
    // The last file in range ends the scan; otherwise the next call starts at the following file.
    next = after(fileIndex);
  }

  return {
    hits,
    scanned: { files, segments: scannedSegments, from: scannedFrom, through: scannedThrough },
    unread,
    available: inRange.length,
    historyExcluded,
    next,
  };
}

/** One input, with its published identity kept apart from the record's later supersession state. */
type Incoming = { readonly segment: MemorySegment; readonly identity: string; readonly file: string };

async function write(store: DailyStore, incoming: readonly Incoming[]): Promise<readonly PublishReceipt[]> {
  await ensureDirectory(store);
  const cache = new Map<string, StoredRecord[]>();
  const load = async (file: string): Promise<StoredRecord[]> => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const content = await readDailyFile(store, file);
    const records = content === undefined ? [] : parseFile(file, content);
    cache.set(file, records);
    return records;
  };

  // Nothing is written unless every input is publishable and every touched file stays in bounds.
  const seen = new Map<string, string>();
  for (const item of incoming) {
    const key = `${item.file}\u0000${item.segment.id}`;
    const same = seen.get(key);
    if (same !== undefined && same !== item.identity) {
      throw new MemoryError("revision-conflict", "Two segments in one call share an id but differ", {
        detail: { id: item.segment.id, file: item.file, stored: same, incoming: item.identity },
      });
    }
    seen.set(key, item.identity);
    const stored = (await load(item.file)).find((record) => record.segment.id === item.segment.id);
    // Compared by published identity, not stored digest: a record that a later publish has since
    // superseded still accepts the replay of its own original publish as a duplicate.
    if (stored !== undefined && identityOfSegment(stored.segment) !== item.identity) {
      throw new MemoryError("revision-conflict", "A published segment has different content", {
        detail: { id: item.segment.id, file: item.file, stored: identityOfSegment(stored.segment), incoming: item.identity },
      });
    }
  }
  // One target may be replaced by exactly one record. Two records in one call claiming the same old
  // fact would both read as current afterwards while the old record points at only one of them.
  const targets = new Map<string, { file: string; index: number; by: string }>();
  for (const item of incoming) {
    for (const id of item.segment.supersedes) {
      const claimed = targets.get(id);
      if (claimed !== undefined) {
        if (claimed.by === item.segment.id) continue;
        throw new MemoryError("revision-conflict", "Two segments in one call supersede the same record", {
          detail: { id, stored: claimed.by, incoming: item.segment.id },
        });
      }
      const found = await locate(store, id);
      const current = found.record.segment.supersededBy;
      if (current === item.segment.id) continue;
      if (current !== null) {
        throw new MemoryError("revision-conflict", "A segment is already superseded by another record", {
          detail: { id, stored: current, incoming: item.segment.id },
        });
      }
      targets.set(id, { file: found.record.file, index: found.index, by: item.segment.id });
    }
  }
  const marked = new Set<string>();
  for (const [id, at] of targets) {
    const records = await load(at.file);
    const record = records[at.index];
    if (record === undefined || record.segment.id !== id) {
      throw new MemoryError("corrupt-state", "A located segment moved inside its file");
    }
    const segment: MemorySegment = { ...record.segment, supersededBy: at.by };
    records[at.index] = { segment, digest: digestOfSegment(segment), file: at.file };
    marked.add(at.file);
  }
  // The marks are the state after retiring old facts and before any new one appears. Writing this
  // version first is what makes the ordering hold across files, not only within one.
  const marksOnly = new Map<string, string>();
  for (const file of marked) {
    const records = cache.get(file);
    if (records !== undefined) marksOnly.set(file, renderFile(records));
  }

  const appended = new Set<Incoming>();
  const receiving = new Set<string>();
  for (const item of incoming) {
    const records = await load(item.file);
    if (records.some((record) => record.segment.id === item.segment.id)) continue;
    records.push({ segment: item.segment, digest: digestOfSegment(item.segment), file: item.file });
    appended.add(item);
    receiving.add(item.file);
  }
  for (const [file, records] of cache) assertFileBounds(file, records);

  // Old facts are retired first, across every file. Only once no file still presents a replaced fact
  // as current are the replacements appended, so a crash between the two phases can lose the new
  // fact but never leave two current answers. A file holding both is written twice for that reason.
  for (const file of marked) {
    const text = marksOnly.get(file);
    if (text !== undefined) await replaceFile(store, file, text);
  }
  for (const file of receiving) {
    const records = cache.get(file);
    if (records !== undefined) await replaceFile(store, file, renderFile(records));
  }

  return incoming.map((item) => ({
    id: item.segment.id,
    date: item.segment.date,
    page: item.segment.page,
    digest: item.identity,
    file: item.file,
    status: appended.has(item) ? "published" : "duplicate",
  }));
}

function assertFileBounds(file: string, records: readonly StoredRecord[]): void {
  if (records.length > DAILY_LIMITS.segmentsPerFile) {
    throw new MemoryError("budget-exceeded", "A date file would exceed its segment bound; use the next page", {
      detail: { file, limit: DAILY_LIMITS.segmentsPerFile, count: records.length },
    });
  }
  const bytes = Buffer.byteLength(renderFile(records));
  if (bytes > DAILY_LIMITS.fileBytes) {
    throw new MemoryError("budget-exceeded", "A date file would exceed its byte bound; use the next page", {
      detail: { file, limit: DAILY_LIMITS.fileBytes, bytes },
    });
  }
}

/** Locate a record by id across the bounded set of date files, for a supersession target. */
async function locate(store: DailyStore, id: string): Promise<{ record: StoredRecord; index: number }> {
  const names = await listFiles(store);
  for (const file of names.slice(0, DAILY_LIMITS.scanFilesMax)) {
    const content = await readDailyFile(store, file);
    if (content === undefined) continue;
    const records = parseFile(file, content);
    const index = records.findIndex((record) => record.segment.id === id);
    const record = records[index];
    if (record !== undefined) return { record, index };
  }
  throw new MemoryError("not-covered", "The superseded record is not in the covered daily files", {
    detail: { id, scanned: Math.min(names.length, DAILY_LIMITS.scanFilesMax) },
  });
}

function renderFile(records: readonly StoredRecord[]): string {
  const first = records[0];
  const header = first === undefined ? "" : headerFor(first.segment.date, first.segment.page);
  const lines = [header, ""];
  for (const record of records) {
    // The text lives in the body only. Keeping a second copy in the meta line would let an edited
    // body disagree with the meta and still parse, which is exactly what the digest must prevent.
    const { text, ...rest } = record.segment;
    lines.push(BEGIN, canonicalJson({ digest: record.digest, segment: rest }), META_END, text, END, "");
  }
  return lines.join("\n");
}

function headerFor(date: string, page: number): string {
  return page === 1 ? `# ${date}` : `# ${date} (page ${page})`;
}

/**
 * Read a date file. Everything in it must be something this module wrote: a header, blank lines and
 * well-formed blocks. Content outside a block is `corrupt-state`, never skipped — a damaged marker
 * would otherwise hide a record from search and let the next publish rewrite the file without it.
 */
function parseFile(file: string, content: string): StoredRecord[] {
  const lines = normalizeNewlines(content).split("\n");
  const { date, page } = dateAndPage(file);
  const records: StoredRecord[] = [];
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  if (index >= lines.length) {
    // A date file this module wrote always has a header; an empty one lost its content.
    throw new MemoryError("corrupt-state", "A date file has no header", { detail: { file } });
  }
  if (lines[index] !== headerFor(date, page)) {
    throw new MemoryError("corrupt-state", "A date file has a header for another date or page", {
      detail: { file, expected: headerFor(date, page), found: lines[index] ?? null },
    });
  }
  index += 1;

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    if (line !== BEGIN) {
      throw new MemoryError("corrupt-state", "A date file holds content outside a segment block", {
        detail: { file, line: index + 1 },
      });
    }
    const meta = lines[index + 1];
    if (meta === undefined || lines[index + 2] !== META_END) {
      throw new MemoryError("corrupt-state", "A segment block is not well formed", { detail: { file, line: index + 1 } });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(meta);
    } catch (cause) {
      throw new MemoryError("corrupt-state", "A segment block holds invalid JSON", { cause, detail: { file, line: index + 2 } });
    }
    const { digest, segment: value } = (parsed ?? {}) as { digest?: unknown; segment?: unknown };
    if (typeof digest !== "string" || value === null || typeof value !== "object") {
      throw new MemoryError("corrupt-state", "A segment block has no digest or no segment", { detail: { file, line: index + 2 } });
    }
    if ("text" in value) {
      // The text has one home. A meta line carrying it is either a file from another writer or a
      // body that was edited away from its meta, and neither can be read as the stored fact.
      throw new MemoryError("corrupt-state", "A segment block repeats its text outside the body", {
        detail: { file, line: index + 2 },
      });
    }
    const body: string[] = [];
    let end = index + 3;
    while (end < lines.length && lines[end] !== END) {
      body.push(lines[end] ?? "");
      end += 1;
    }
    if (end >= lines.length) {
      throw new MemoryError("corrupt-state", "A segment block is not closed", { detail: { file, line: index + 1 } });
    }
    const segment = assertSchema<MemorySegment>(
      MemorySegmentSchema,
      { ...(value as object), text: body.join("\n") },
      "corrupt-state",
    );
    const computed = digestOfSegment(segment);
    if (computed !== digest) {
      throw new MemoryError("corrupt-state", "A segment does not match its stored digest", {
        detail: { file, id: segment.id, stored: digest, computed },
      });
    }
    if (segment.date !== date || segment.page !== page) {
      throw new MemoryError("corrupt-state", "A segment sits in a file for another date or page", {
        detail: { file, id: segment.id, date: segment.date, page: segment.page },
      });
    }
    records.push({ segment, digest, file });
    index = end;
  }
  return records;
}

/** `YYYY-MM-DD[-N].md` and `unknown[-N].md`; anything else is not a date file. */
function dateAndPage(file: string): { date: string; page: number } {
  const calendar = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/.exec(file);
  if (calendar !== null) return { date: calendar[1] ?? "", page: Number(calendar[2] ?? 1) };
  const unknown = /^unknown(?:-(\d+))?\.md$/.exec(file);
  if (unknown !== null) return { date: UNKNOWN_DATE, page: Number(unknown[1] ?? 1) };
  throw new MemoryError("invalid-input", "Not a daily memory file name", { detail: { file } });
}

function admits(segment: MemorySegment, query: DailyQuery): boolean {
  if (query.kinds !== undefined && !query.kinds.includes(segment.kind)) return false;
  if (query.text !== undefined && query.text.length > 0 && !segment.text.toLowerCase().includes(query.text.toLowerCase())) return false;
  return true;
}

function inDateRange(file: string, from: string | undefined, through: string | undefined): boolean {
  const { date } = dateAndPage(file);
  if (from !== undefined && compareDates(date, from) < 0) return false;
  if (through !== undefined && compareDates(date, through) > 0) return false;
  return true;
}

/** `unknown` sorts after every calendar date: its event time is not known to be earlier. */
function compareDates(left: string, right: string): number {
  if (left === right) return 0;
  if (left === UNKNOWN_DATE) return 1;
  if (right === UNKNOWN_DATE) return -1;
  return left < right ? -1 : 1;
}

function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new MemoryError("invalid-input", `${name} must be an integer in 1..${max}`, { detail: { name, value, max } });
  }
  return value;
}

/** Rewind for backfill only when no read position or content digest would be lost across pages. */
function resumeAt(files: readonly string[], cursor: SearchCursor | undefined): { begin: number } {
  if (cursor === undefined) return { begin: 0 };
  const at = files.indexOf(cursor.file);
  if (at < 0) {
    throw new MemoryError("stale", "The cursor names a file that is not in this range", { detail: { file: cursor.file } });
  }
  const covered = new Set(cursor.covered.map((entry) => entry.file));
  let begin = at;
  for (let index = 0; index < at; index += 1) {
    const file = files[index];
    if (file !== undefined && !covered.has(file)) {
      begin = index;
      break;
    }
  }
  if (begin < at && (cursor.index > 0 || cursor.fileDigest !== null)) {
    throw new MemoryError("stale", "Backfill appeared before a cursor with a pinned file position", {
      detail: { file: cursor.file, index: cursor.index },
    });
  }
  return { begin };
}

async function listFiles(store: DailyStore): Promise<string[]> {
  // Listing is a read, but through a junction it would silently be a read of somewhere else.
  await assertNotSymlink(store, DAILY_PROBE);
  const names = await listDirectory(join(store.root, DAILY_DIRECTORY));
  return names.filter((name) => /^(?:\d{4}-\d{2}-\d{2}|unknown)(?:-\d+)?\.md$/.test(name)).sort((left, right) => {
    const a = dateAndPage(left);
    const b = dateAndPage(right);
    return compareDates(a.date, b.date) || a.page - b.page;
  });
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (cause) {
    if (isMissing(cause)) return [];
    throw ioFailure("The daily memory directory cannot be listed", cause);
  }
}

/** Read a date file, stopping one byte past the byte bound instead of buffering a whole file. */
async function readDailyFile(store: DailyStore, file: string): Promise<string | undefined> {
  const path = filePath(store, file);
  await assertNotSymlink(store, file);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw ioFailure("A date file cannot be read", cause);
  }
  try {
    // One byte past the limit is enough to know it is too large; a file of any size costs at most
    // that much memory.
    const buffer = Buffer.allocUnsafe(DAILY_LIMITS.fileBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > DAILY_LIMITS.fileBytes) {
      throw new MemoryError("budget-exceeded", "A date file exceeds its byte bound", {
        detail: { file, limit: DAILY_LIMITS.fileBytes },
      });
    }
    return normalizeNewlines(buffer.toString("utf8", 0, filled));
  } catch (cause) {
    if (cause instanceof MemoryError) throw cause;
    throw ioFailure("A date file cannot be read", cause);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The size and modification time of a date file, or `null` if it is not there. */
async function observe(store: DailyStore, file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await lstat(filePath(store, file));
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw ioFailure("A daily memory path cannot be inspected", cause);
  }
}

/** Write, sync, rename: a reader sees the whole old file or the whole new one. */
async function replaceFile(store: DailyStore, file: string, text: string): Promise<void> {
  const target = filePath(store, file);
  const temp = `${target}.tmp`;
  await assertNotSymlink(store, file);
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (cause instanceof MemoryError) throw cause;
    throw ioFailure("A date file cannot be replaced", cause);
  }
  await syncDirectory(dirname(target));
}

/**
 * A symlink anywhere between the root and the file is refused, not followed: checking only the last
 * directory would let `root/memory` be a junction into somewhere else and still pass. Every existing
 * component of the path is inspected.
 */
async function assertNotSymlink(store: DailyStore, file: string): Promise<void> {
  const directory = join(store.root, DAILY_DIRECTORY);
  const target = filePath(store, file);
  for (const path of [directory, dirname(directory), target]) {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new MemoryError("corrupt-state", "A daily memory path is a symlink; refusing to follow it", {
          detail: { path: relative(store.root, path) },
        });
      }
    } catch (cause) {
      if (cause instanceof MemoryError) throw cause;
      if (isMissing(cause)) continue;
      throw ioFailure("A daily memory path cannot be inspected", cause);
    }
  }
}

async function ensureDirectory(store: DailyStore): Promise<void> {
  const directory = join(store.root, DAILY_DIRECTORY);
  // Inspect the parent before creating anything: `mkdir -p` through a junction would create the
  // directory outside the host's root and only then be refused.
  await assertNotSymlink(store, DAILY_PROBE);
  try {
    await mkdir(directory, { recursive: true });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw new MemoryError("corrupt-state", "The daily memory directory is a symlink; refusing to write through it", {
        detail: { path: relative(store.root, directory) },
      });
    }
  } catch (cause) {
    if (cause instanceof MemoryError) throw cause;
    throw ioFailure("The daily memory directory cannot be created", cause);
  }
}

/**
 * Rename is atomic within a directory; syncing the directory makes it durable where the filesystem
 * supports it. Windows and some filesystems refuse to open a directory for sync, which does not mean
 * the write failed, so only those specific refusals are tolerated.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "EPERM" || code === "EBADF" || code === "EISDIR" || code === "EACCES" || code === "EINVAL") return;
    throw ioFailure("The daily memory directory cannot be synced", cause);
  }
}

/** Resolve inside `root/memory/daily`; anything that would leave the root is refused. */
function filePath(store: DailyStore, file: string): string {
  const path = resolve(store.root, DAILY_DIRECTORY, file);
  const escaped = relative(resolve(store.root), path);
  if (escaped.startsWith("..") || isAbsolute(escaped)) {
    throw new MemoryError("invalid-input", "A daily memory path escapes the configured root", { detail: { file } });
  }
  return path;
}

function digestOfFile(content: string): string {
  return createHash("sha256").update(normalizeNewlines(content)).digest("hex").slice(0, 16);
}

/** One fact has one stored form: the file format is LF, so input is normalized before hashing. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** A segment's text is delimited by marker lines, so it may not contain one. */
function assertTextIsMarkable(text: string): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === END || trimmed.startsWith(BEGIN)) {
      throw new MemoryError("invalid-input", "Segment text contains a memory segment marker line", {
        detail: { marker: trimmed.slice(0, 64) },
      });
    }
  }
}

function isMissing(cause: unknown): boolean {
  return (cause as { code?: string }).code === "ENOENT";
}

function ioFailure(message: string, cause: unknown): MemoryError {
  const code = (cause as { code?: string }).code;
  return new MemoryError("io-failure", message, { cause, detail: code === undefined ? null : { code } });
}

/**
 * One writer per root, in process. The deployment runs a single application process, so this is the
 * whole serialization guarantee; a second process on the same root is not supported and would need a
 * lock file. The map holds one settled promise per root, not one per call.
 */
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  locks.set(key, next.then(() => undefined, () => undefined));
  return next;
}
