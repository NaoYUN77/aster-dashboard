import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DAILY_DIRECTORY,
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  UNKNOWN_DATE,
  type MemorySegment,
} from "../src/memory/contracts.js";
import {
  DAILY_LIMITS,
  digestOfSegment,
  openDaily,
  publishSegments,
  readSegment,
  searchDaily,
  type DailyStore,
  type SearchCursor,
} from "../src/memory/daily.js";

// MEM-04 exercises the Daily Memory Module against a real temporary directory. No Harness, no
// database, no model: the module's whole job is the file protocol, so the file system is the
// subject rather than a stand-in for it.

const conversationId = 1 as MemorySegment["sources"]["conversationId"];
const id = (value: number) => value as MemorySegment["sources"]["through"];

function segment(overrides: Partial<MemorySegment> & { id: string; date: string }): MemorySegment {
  return {
    version: MEMORY_SCHEMA_VERSION,
    timezone: "UTC",
    page: 1,
    kind: "result",
    status: "confirmed",
    text: `fact ${overrides.id}`,
    sources: { conversationId, after: null, through: id(10) },
    supersedes: [],
    supersededBy: null,
    ...overrides,
  };
}

async function store(): Promise<DailyStore> {
  return openDaily(await mkdtemp(join(tmpdir(), "daily-")));
}

async function dispose(target: DailyStore): Promise<void> {
  await rm(target.root, { recursive: true, force: true });
}

function errorCode(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "no-error",
    (error: unknown) => (error instanceof MemoryError ? error.code : `other:${String(error)}`),
  );
}

test("04-A: the same id and content is not appended twice, and a different body is a conflict", async () => {
  const daily = await store();
  try {
    const first = segment({ id: "s1", date: "2026-10-20", text: "Shipped the release." });
    const receipt = await publishSegments(daily, [first]);
    assert.deepEqual(receipt.map((entry) => entry.status), ["published"]);
    assert.equal(receipt[0]?.digest, digestOfSegment(first));

    // The same record again: same digest, nothing appended, and the file is unchanged byte for byte.
    const file = join(daily.root, DAILY_DIRECTORY, "2026-10-20.md");
    const before = await readFile(file, "utf8");
    const again = await publishSegments(daily, [first]);
    assert.deepEqual(again.map((entry) => entry.status), ["duplicate"]);
    assert.equal(again[0]?.digest, receipt[0]?.digest, "a duplicate reports the stored digest");
    assert.equal(await readFile(file, "utf8"), before);

    // The same id with a different body is a conflict, and writes nothing at all.
    const changed = segment({ id: "s1", date: "2026-10-20", text: "Shipped the release late." });
    assert.equal(await errorCode(() => publishSegments(daily, [changed])), "revision-conflict");
    assert.equal(await readFile(file, "utf8"), before, "a refused publish leaves the file untouched");
    const found = await readSegment(daily, { id: "s1", date: "2026-10-20" });
    assert.equal(found.found && found.record.segment.text, "Shipped the release.");

    // Two records with one id inside one call are refused before anything is written.
    const twin = segment({ id: "s2", date: "2026-10-21", text: "one" });
    assert.equal(
      await errorCode(() => publishSegments(daily, [twin, { ...twin, text: "two" }])),
      "revision-conflict",
    );
    assert.equal((await readSegment(daily, { id: "s2", date: "2026-10-21" })).found, false);
  } finally {
    await dispose(daily);
  }
});

test("04-A: concurrent publishes on one root are serialized and lose no segment", async () => {
  const daily = await store();
  try {
    const batch = Array.from({ length: 12 }, (_, index) => segment({ id: `c${index}`, date: "2026-10-22", text: `parallel ${index}` }));
    // Fired together: without a writer lock, each call would read the same file and the last rename
    // would win, dropping the others.
    const receipts = await Promise.all(batch.map((item) => publishSegments(daily, [item])));
    assert.ok(receipts.every((entries) => entries.length === 1));
    const content = await readFile(join(daily.root, DAILY_DIRECTORY, "2026-10-22.md"), "utf8");
    for (const item of batch) assert.ok(content.includes(`parallel ${item.id.slice(1)}`), `${item.id} survived`);
    const searched = await searchDaily(daily, { limit: DAILY_LIMITS.hitsMax });
    assert.equal(searched.hits.length, batch.length, "every segment is readable exactly once");
    assert.deepEqual(new Set(searched.hits.map((hit) => hit.segment.id)).size, batch.length);
  } finally {
    await dispose(daily);
  }
});

test("04-B: a failed replace leaves the whole old file, and the retry publishes the same digest", async () => {
  const daily = await store();
  try {
    const first = segment({ id: "b1", date: "2026-10-23", text: "First version." });
    const receipt = await publishSegments(daily, [first]);
    const file = join(daily.root, DAILY_DIRECTORY, "2026-10-23.md");
    const before = await readFile(file, "utf8");

    // Fail before the temp file is written: a directory sits where the temp file would go.
    await mkdir(`${file}.tmp`, { recursive: true });
    const second = segment({ id: "b2", date: "2026-10-23", text: "Second version." });
    assert.equal(await errorCode(() => publishSegments(daily, [second])), "io-failure");
    assert.equal(await readFile(file, "utf8"), before, "a reader sees the complete old file");
    assert.equal((await readSegment(daily, { id: "b2", date: "2026-10-23" })).found, false);
    await rm(`${file}.tmp`, { recursive: true, force: true });

    // A temp path linked to a directory also refuses the write on Windows and Linux, including root.
    // Unlike a real directory blocker, the link can be removed by the failed write's cleanup.
    const tempDirectory = join(daily.root, "temp-directory");
    await mkdir(tempDirectory);
    await symlink(tempDirectory, `${file}.tmp`, "junction");
    assert.equal(await errorCode(() => publishSegments(daily, [second])), "io-failure");
    assert.equal(await readFile(file, "utf8"), before, "the old file is still whole");
    await assert.rejects(readFile(`${file}.tmp`), { code: "ENOENT" }, "no temp link is left behind");

    // The retry succeeds with the same content the failed attempt would have published, so the
    // receipt is stable across the failure rather than a new fact.
    const retried = await publishSegments(daily, [second]);
    assert.deepEqual(retried.map((entry) => entry.status), ["published"]);
    assert.equal(retried[0]?.digest, digestOfSegment(second));

    // A fresh store over the same directory reads the record back: the receipt can be checked after
    // a restart without re-publishing anything.
    const reopened = openDaily(daily.root);
    const found = await readSegment(reopened, { id: "b2", date: "2026-10-23" });
    assert.equal(found.found, true);
    assert.equal(found.found && found.record.digest, receipt.length === 1 ? retried[0]?.digest : "");
    const repeated = await publishSegments(reopened, [second]);
    assert.deepEqual(repeated.map((entry) => entry.status), ["duplicate"], "the restart does not re-append");
  } finally {
    await dispose(daily);
  }
});

test("04-C: escaping paths, symlinks, unreadable and corrupt files each have an explicit result", async () => {
  const daily = await store();
  try {
    // A relative root is refused: the host must name an absolute directory it controls.
    assert.equal(await errorCode(async () => openDaily("memory")), "invalid-input");
    // Names that would leave the directory are rejected by the frozen naming rule.
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "../escape" })), "invalid-input");
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-02-30" })), "invalid-input");

    // A missing file and a missing record inside a real file are different facts.
    assert.deepEqual(await readSegment(daily, { id: "x", date: "2026-01-01" }), { found: false, reason: "missing-file" });
    await publishSegments(daily, [segment({ id: "present", date: "2026-01-01" })]);
    assert.deepEqual(await readSegment(daily, { id: "absent", date: "2026-01-01" }), { found: false, reason: "missing-segment" });

    // A symlink where a date file belongs is refused rather than followed out of the root.
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "# 2026-01-02\n");
      await symlink(outside, join(daily.root, DAILY_DIRECTORY, "2026-01-02.md"), "junction");
      assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-01-02" })), "corrupt-state");
      assert.equal(await errorCode(() => publishSegments(daily, [segment({ id: "y", date: "2026-01-02" })])), "corrupt-state");
      assert.equal(await errorCode(() => searchDaily(daily, { from: "2026-01-02", through: "2026-01-02" })), "corrupt-state");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await rm(join(daily.root, DAILY_DIRECTORY, "2026-01-02.md"), { force: true });

    // A directory where a date file belongs is an I/O failure, not "no records".
    await mkdir(join(daily.root, DAILY_DIRECTORY, "2026-01-03.md"));
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-01-03" })), "io-failure");

    // A corrupt file is reported, never parsed into a different fact.
    const file = join(daily.root, DAILY_DIRECTORY, "2026-01-04.md");
    await writeFile(file, "# 2026-01-04\n\n<!-- memory-segment:begin\n{not json\n-->\nbody\n<!-- memory-segment:end -->\n");
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-01-04" })), "corrupt-state");
    await writeFile(file, "# 2026-01-04\n\n<!-- memory-segment:begin\n{\"digest\":\"abc\",\"segment\":{}}\n-->\nbody\n<!-- memory-segment:end -->\n");
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-01-04" })), "corrupt-state");

    // An edited body no longer matches its digest: the file is corrupt, not quietly a new value.
    const tampered = segment({ id: "t1", date: "2026-01-05", text: "Original." });
    await publishSegments(daily, [tampered]);
    const tamperedFile = join(daily.root, DAILY_DIRECTORY, "2026-01-05.md");
    const content = await readFile(tamperedFile, "utf8");
    await writeFile(tamperedFile, content.replace("Original.", "Rewritten."));
    assert.equal(await errorCode(() => readSegment(daily, { id: "t1", date: "2026-01-05" })), "corrupt-state");
    assert.equal(await errorCode(() => searchDaily(daily, { from: "2026-01-05", through: "2026-01-05" })), "corrupt-state");

    // A meta line that carries the text as well as the body is refused even when the digest matches:
    // two copies of the fact can disagree, and the reader would have no way to say which one is real.
    const duplicated = segment({ id: "t2", date: "2026-01-07", text: "One copy only." });
    await writeFile(
      join(daily.root, DAILY_DIRECTORY, "2026-01-07.md"),
      [
        "# 2026-01-07",
        "",
        "<!-- memory-segment:begin",
        JSON.stringify({ digest: digestOfSegment(duplicated), segment: duplicated }),
        "-->",
        duplicated.text,
        "<!-- memory-segment:end -->",
        "",
      ].join("\n"),
    );
    assert.equal(await errorCode(() => readSegment(daily, { id: "t2", date: "2026-01-07" })), "corrupt-state");

    // Text that would forge a block boundary is refused before it reaches a file. Both markers count:
    // an opening line would start a block the reader never closes.
    assert.equal(
      await errorCode(() => publishSegments(daily, [segment({ id: "m1", date: "2026-01-06", text: "x\n<!-- memory-segment:end -->\ny" })])),
      "invalid-input",
    );
    assert.equal(
      await errorCode(() => publishSegments(daily, [segment({ id: "m2", date: "2026-01-06", text: "x\n<!-- memory-segment:begin\ny" })])),
      "invalid-input",
    );
    assert.equal((await readSegment(daily, { id: "m1", date: "2026-01-06" })).found, false);

    // A damaged marker is not skipped. Skipping would make the record invisible and let the next
    // publish rewrite the file without it — a silent loss of memory.
    const damaged = segment({ id: "d1", date: "2026-01-08", text: "Do not lose me." });
    await publishSegments(daily, [damaged]);
    const damagedFile = join(daily.root, DAILY_DIRECTORY, "2026-01-08.md");
    const intact = await readFile(damagedFile, "utf8");
    await writeFile(damagedFile, intact.replace("<!-- memory-segment:begin", "<!-- memory-segment:begun"));
    assert.equal(await errorCode(() => readSegment(daily, { id: "d1", date: "2026-01-08" })), "corrupt-state");
    assert.equal(await errorCode(() => searchDaily(daily, { from: "2026-01-08", through: "2026-01-08" })), "corrupt-state");
    // Publishing into the same file must be refused too, and must leave the damaged file alone.
    assert.equal(
      await errorCode(() => publishSegments(daily, [segment({ id: "d2", date: "2026-01-08" })])),
      "corrupt-state",
    );
    assert.equal(await readFile(damagedFile, "utf8"), intact.replace("<!-- memory-segment:begin", "<!-- memory-segment:begun"));

    // Anything else outside a block is refused as well: only what this module wrote is readable.
    const stray = join(daily.root, DAILY_DIRECTORY, "2026-01-09.md");
    await writeFile(stray, "# 2026-01-09\n\nhand-written note\n");
    assert.equal(await errorCode(() => searchDaily(daily, { from: "2026-01-09", through: "2026-01-09" })), "corrupt-state");
    // A file whose header names another date is corrupt, not a file of the date in its name.
    await writeFile(stray, "# 2026-01-10\n");
    assert.equal(await errorCode(() => searchDaily(daily, { from: "2026-01-09", through: "2026-01-09" })), "corrupt-state");

    // `root/memory` itself is inspected: a junction there would put every write outside the root.
    const escaped = await store();
    try {
      const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
      try {
        await mkdir(join(elsewhere, "daily"), { recursive: true });
        await symlink(elsewhere, join(escaped.root, "memory"), "junction");
        assert.equal(await errorCode(() => publishSegments(escaped, [segment({ id: "e1", date: "2026-02-01" })])), "corrupt-state");
        assert.equal(await errorCode(() => readSegment(escaped, { id: "e1", date: "2026-02-01" })), "corrupt-state");
        assert.equal(await errorCode(() => searchDaily(escaped, {})), "corrupt-state");
        // Nothing was written through the junction.
        assert.equal(await readFile(join(elsewhere, "daily", "2026-02-01.md"), "utf8").then(() => "written", () => "absent"), "absent");
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    } finally {
      await dispose(escaped);
    }

    // A CRLF body is stored as LF and reads back with the same content and digest.
    const crlf = segment({ id: "crlf", date: "2026-01-11", text: "line one\r\nline two" });
    const crlfReceipt = await publishSegments(daily, [crlf]);
    assert.deepEqual(crlfReceipt.map((entry) => entry.status), ["published"]);
    const crlfRead = await readSegment(daily, { id: "crlf", date: "2026-01-11" });
    assert.equal(crlfRead.found && crlfRead.record.segment.text, "line one\nline two");
    assert.equal(crlfRead.found && crlfRead.record.digest, crlfReceipt[0]?.digest, "the receipt digest is reproducible");
    // Replaying the same CRLF publish is a duplicate, not a conflict.
    assert.deepEqual(
      (await publishSegments(daily, [crlf])).map((entry) => entry.status),
      ["duplicate"],
    );
  } finally {
    await dispose(daily);
  }
});

test("04-D: a paged search reports what it scanned, what it left, and resumes without gaps", async () => {
  const daily = await store();
  try {
    // Nothing at all: the answer says so, and is not the same as "scanned and found nothing".
    const empty = await searchDaily(daily, { text: "anything" });
    assert.deepEqual(empty.hits, []);
    assert.equal(empty.available, 0);
    assert.equal(empty.scanned.files, 0);
    assert.equal(empty.scanned.from, null);

    const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
    for (const date of dates) {
      await publishSegments(daily, [
        segment({ id: `${date}-a`, date, text: `decision on ${date}` }),
        segment({ id: `${date}-b`, date, text: `result on ${date}` }),
      ]);
    }

    // No match, but the history exists: both facts are reported.
    const miss = await searchDaily(daily, { text: "nothing-matches" });
    assert.deepEqual(miss.hits, []);
    assert.equal(miss.available, 5, "five date files exist");
    assert.equal(miss.scanned.files, 5, "and all of them were read");
    assert.deepEqual([miss.scanned.from, miss.scanned.through], ["2026-10-01.md", "2026-10-05.md"]);

    // Paged by hits: the cursor resumes exactly where the last call stopped, with no repeats.
    const seen: string[] = [];
    let cursor: SearchCursor | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await searchDaily(daily, { text: "on", limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...result.hits.map((hit) => hit.segment.id));
      if (result.next === null) break;
      cursor = result.next;
    }
    assert.deepEqual(seen, dates.flatMap((date) => [`${date}-a`, `${date}-b`]), "every record once, in date order");

    // A record appended to a file that was already consumed, after the scan read it but before the
    // cursor was used, is caught. The cursor records the state observed *at read time*; measuring the
    // files again when the cursor is built would fold the append into the cursor's own fingerprint
    // and lose it silently.
    const racing = await store();
    try {
      for (const date of ["2026-12-10", "2026-12-11"]) {
        await publishSegments(racing, [segment({ id: `${date}-r`, date, text: `race ${date}` })]);
      }
      const firstPage = await searchDaily(racing, { text: "race", limit: 1 });
      assert.equal(firstPage.next?.file, "2026-12-11.md");
      assert.deepEqual(firstPage.next?.covered.map((entry) => entry.file), ["2026-12-10.md"]);
      // The append lands after the first file was read.
      await publishSegments(racing, [segment({ id: "late-r", date: "2026-12-10", text: "late arrival" })]);
      assert.equal(
        await errorCode(() => searchDaily(racing, { text: "race", cursor: firstPage.next ?? undefined })),
        "stale",
        "the append behind the cursor is reported, not skipped",
      );
      // A fresh scan finds it: the fact was never lost, only the stale cursor was refused.
      const rescanned = await searchDaily(racing, { text: "late" });
      assert.deepEqual(rescanned.hits.map((hit) => hit.segment.id), ["late-r"]);
    } finally {
      await dispose(racing);
    }

    // The scan range names the file that was actually read, even when the last read ended on a hit
    // bound. `through` must not be null just because the loop left early.
    const oneHit = await searchDaily(daily, { from: "2026-10-01", through: "2026-10-01", limit: 1 });
    assert.equal(oneHit.hits.length, 1);
    assert.deepEqual([oneHit.scanned.from, oneHit.scanned.through], ["2026-10-01.md", "2026-10-01.md"]);
    assert.equal(oneHit.scanned.files, 1);
    assert.notEqual(oneHit.next, null, "the second record is still reachable");

    // Paged by files: the files not scanned are named, so a partial scan cannot read as complete.
    const partial = await searchDaily(daily, { text: "on", maxFiles: 2, limit: DAILY_LIMITS.hitsMax });
    assert.equal(partial.scanned.files, 2);
    assert.equal(partial.available, 5);
    assert.deepEqual(
      [partial.scanned.from, partial.scanned.through],
      ["2026-10-01.md", "2026-10-02.md"],
      "the scan range is what was read, not the whole range",
    );
    assert.deepEqual(partial.unread, ["2026-10-03.md", "2026-10-04.md", "2026-10-05.md"]);
    assert.notEqual(partial.next, null);
    const rest = await searchDaily(daily, { text: "on", limit: DAILY_LIMITS.hitsMax, cursor: partial.next ?? undefined });
    assert.equal(rest.hits.length, 6, "the remaining three files hold six records");

    // A file that changed under a cursor is stale: resuming would skip whatever shifted into place.
    const held = await searchDaily(daily, { text: "on", limit: 2 });
    assert.notEqual(held.next, null);
    await publishSegments(daily, [segment({ id: "late", date: "2026-10-01", text: "a late arrival" })]);
    assert.equal(
      await errorCode(() => searchDaily(daily, { text: "on", limit: 2, cursor: held.next ?? undefined })),
      "stale",
    );
    // A cursor naming a file outside the range is stale too, not a silent restart.
    assert.equal(
      await errorCode(() =>
        searchDaily(daily, { from: "2026-10-03", cursor: { file: "2026-10-01.md", index: 1, fileDigest: "x", covered: [] } }),
      ),
      "stale",
    );
    // A file that disappears before the scan starts is not listed, and a cursor that names it is
    // stale rather than silently restarting the scan.
    const vanishing = await store();
    try {
      for (const date of ["2026-11-01", "2026-11-02", "2026-11-03"]) {
        await publishSegments(vanishing, [segment({ id: `${date}-v`, date, text: `vanish ${date}` })]);
      }
      const first = await searchDaily(vanishing, { text: "vanish", limit: 1 });
      assert.equal(first.hits.length, 1);
      assert.equal(first.next?.file, "2026-11-02.md", "the cursor starts at the file after the last hit");
      await rm(join(vanishing.root, DAILY_DIRECTORY, "2026-11-02.md"), { force: true });
      assert.equal(
        await errorCode(() => searchDaily(vanishing, { text: "vanish", cursor: first.next ?? undefined })),
        "stale",
      );
      // Without the cursor the remaining file is still reachable, so the loss is not a dead end.
      const rest = await searchDaily(vanishing, { text: "vanish" });
      assert.deepEqual(rest.hits.map((hit) => hit.segment.id), ["2026-11-01-v", "2026-11-03-v"]);

      // A file that was already consumed and is later deleted does not block the rest of the scan:
      // nothing in it can be skipped, so a cursor issued afterwards still resumes.
      const held = await searchDaily(vanishing, { text: "vanish", limit: 1 });
      assert.deepEqual(held.next?.covered.map((entry) => entry.file), ["2026-11-01.md"]);
      await rm(join(vanishing.root, DAILY_DIRECTORY, "2026-11-01.md"), { force: true });
      const resumed = await searchDaily(vanishing, { text: "vanish", cursor: held.next ?? undefined });
      assert.deepEqual(resumed.hits.map((hit) => hit.segment.id), ["2026-11-03-v"], "the remaining file is still returned");
    } finally {
      await dispose(vanishing);
    }

    // A date published between pages sorts in front of the cursor. It was never read, so it is not
    // in `covered` and no stale check applies to it; resuming must still reach it rather than step
    // over it and claim there is nothing left.
    const inserting = await store();
    try {
      for (const date of ["2026-10-20", "2026-10-22"]) {
        await publishSegments(inserting, [segment({ id: `${date}-i`, date, text: `backfill ${date}` })]);
      }
      const firstPage = await searchDaily(inserting, { text: "backfill", maxFiles: 1 });
      assert.deepEqual(firstPage.hits.map((hit) => hit.segment.id), ["2026-10-20-i"]);
      assert.equal(firstPage.next?.file, "2026-10-22.md");
      await publishSegments(inserting, [segment({ id: "2026-10-21-i", date: "2026-10-21", text: "backfill 2026-10-21" })]);
      const resumed = await searchDaily(inserting, { text: "backfill", limit: 10, cursor: firstPage.next ?? undefined });
      assert.deepEqual(
        resumed.hits.map((hit) => hit.segment.id),
        ["2026-10-21-i", "2026-10-22-i"],
        "the earlier date inserted behind the cursor is scanned, and the consumed file is not repeated",
      );
      assert.equal(resumed.next, null, "and the scan is genuinely complete when it says so");

      // The same holds when the inserted file is what fills the page: the cursor must not skip the
      // rest of the range because a file appeared in front of it.
      const bounded = await store();
      try {
        for (const date of ["2026-10-20", "2026-10-22"]) {
          await publishSegments(bounded, [segment({ id: `${date}-b`, date, text: `bounded ${date}` })]);
        }
        const head = await searchDaily(bounded, { text: "bounded", maxFiles: 1 });
        assert.equal(head.next?.file, "2026-10-22.md");
        await publishSegments(bounded, [
          segment({ id: "2026-10-21-b1", date: "2026-10-21", text: "bounded 2026-10-21" }),
          segment({ id: "2026-10-21-b2", date: "2026-10-21", text: "bounded 2026-10-21" }),
        ]);
        const second = await searchDaily(bounded, { text: "bounded", limit: 1, cursor: head.next ?? undefined });
        assert.deepEqual(second.hits.map((hit) => hit.segment.id), ["2026-10-21-b1"]);
        assert.deepEqual([second.next?.file, second.next?.index], ["2026-10-21.md", 1], "the cursor stays in the inserted file");
        assert.deepEqual(second.unread, ["2026-10-22.md"]);
        const third = await searchDaily(bounded, { text: "bounded", limit: 1, cursor: second.next ?? undefined });
        assert.deepEqual(third.hits.map((hit) => hit.segment.id), ["2026-10-21-b2"]);
        const fourth = await searchDaily(bounded, { text: "bounded", limit: 1, cursor: third.next ?? undefined });
        assert.deepEqual(fourth.hits.map((hit) => hit.segment.id), ["2026-10-22-b"]);
        assert.equal(fourth.next, null, "the range ends only after every file was read");
      } finally {
        await dispose(bounded);
      }
      // Across several pages `covered` holds files that sort *after* an inserted date, so resuming
      // has to step over the files the caller already has instead of returning them again.
      const deep = await store();
      try {
        const dates = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];
        for (const date of dates) {
          await publishSegments(deep, [segment({ id: `${date}-m`, date, text: `multi ${date}` })]);
        }
        const pageOne = await searchDaily(deep, { text: "multi", maxFiles: 2 });
        assert.deepEqual(pageOne.hits.map((hit) => hit.segment.id), ["2026-10-20-m", "2026-10-21-m"]);
        const pageTwo = await searchDaily(deep, { text: "multi", maxFiles: 2, cursor: pageOne.next ?? undefined });
        assert.deepEqual(pageTwo.hits.map((hit) => hit.segment.id), ["2026-10-22-m", "2026-10-23-m"]);
        assert.deepEqual(pageTwo.next?.covered.map((entry) => entry.file), dates.slice(0, 4).map((date) => `${date}.md`));
        // A second page for the 21st appears behind the cursor, in front of four consumed files.
        await publishSegments(deep, [segment({ id: "2026-10-21-m2", date: "2026-10-21", page: 2, text: "multi backfill" })]);
        const pageThree = await searchDaily(deep, { text: "multi", maxFiles: 2, cursor: pageTwo.next ?? undefined });
        assert.deepEqual(
          pageThree.hits.map((hit) => hit.segment.id),
          ["2026-10-21-m2", "2026-10-24-m"],
          "the inserted page is returned and the consumed files are not repeated",
        );
        assert.equal(pageThree.next, null);

        // When the scan has to restart in front of the cursor, the file right after the inserted one
        // is already consumed: the cursor must skip it, not point at a page the caller already has.
        const stepped = await store();
        try {
          for (const date of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
            await publishSegments(stepped, [segment({ id: `${date}-s`, date, text: `step ${date}` })]);
          }
          const one = await searchDaily(stepped, { text: "step", maxFiles: 1 });
          const two = await searchDaily(stepped, { text: "step", maxFiles: 1, cursor: one.next ?? undefined });
          assert.deepEqual(two.hits.map((hit) => hit.segment.id), ["2026-10-21-s"]);
          assert.equal(two.next?.file, "2026-10-22.md");
          // `19` lands in front of a cursor whose `covered` holds 20 and 21.
          await publishSegments(stepped, [segment({ id: "2026-10-19-s", date: "2026-10-19", text: "step 2026-10-19" })]);
          const three = await searchDaily(stepped, { text: "step", limit: 1, cursor: two.next ?? undefined });
          assert.deepEqual(three.hits.map((hit) => hit.segment.id), ["2026-10-19-s"]);
          assert.deepEqual(
            [three.scanned.from, three.scanned.through],
            ["2026-10-19.md", "2026-10-22.md"],
            "the two consumed files in between are stepped over, not read again",
          );
          assert.equal(three.scanned.files, 2, "only the backfilled file and the one that filled the page");
          assert.equal(three.next?.file, "2026-10-22.md");
          const four = await searchDaily(stepped, { text: "step", limit: 1, cursor: three.next ?? undefined });
          assert.deepEqual(four.hits.map((hit) => hit.segment.id), ["2026-10-22-s"], "no page is returned twice");
          const five = await searchDaily(stepped, { text: "step", limit: 1, cursor: four.next ?? undefined });
          assert.deepEqual(five.hits.map((hit) => hit.segment.id), ["2026-10-23-s"]);
          assert.equal(five.next, null);
        } finally {
          await dispose(stepped);
        }
      } finally {
        await dispose(deep);
      }
    } finally {
      await dispose(inserting);
    }

    // A rewind cannot preserve both a pinned file position and a separately paged backfill in a
    // single-position cursor. Refuse before returning a backfill page; the caller starts a new scan.
    const pinned = await store();
    try {
      await publishSegments(pinned, [
        segment({ id: "A", date: "2026-10-22" }),
        segment({ id: "B", date: "2026-10-22" }),
      ]);
      const first = await searchDaily(pinned, { limit: 1 });
      assert.deepEqual(first.hits.map((hit) => hit.segment.id), ["A"]);
      assert.ok(first.next);
      assert.equal(first.next.index, 1);
      const heldCursor = first.next;
      const originalCursor = structuredClone(heldCursor);
      await publishSegments(pinned, [
        segment({ id: "X", date: "2026-10-21" }),
        segment({ id: "Y", date: "2026-10-21" }),
      ]);
      for (const bounds of [{ limit: 1 }, { limit: 1, maxFiles: 1 }, { limit: 100 }]) {
        assert.equal(await errorCode(() => searchDaily(pinned, { ...bounds, cursor: heldCursor })), "stale");
      }
      assert.deepEqual(first.next, originalCursor, "a refused resume leaves the original cursor intact");

      // Removing the backfill makes the old position usable again; its digest still detects edits.
      await rm(join(pinned.root, DAILY_DIRECTORY, "2026-10-21.md"));
      const tail = await searchDaily(pinned, { limit: 1, cursor: heldCursor });
      assert.deepEqual(tail.hits.map((hit) => hit.segment.id), ["B"]);
      await publishSegments(pinned, [segment({ id: "C", date: "2026-10-22" })]);
      assert.equal(await errorCode(() => searchDaily(pinned, { cursor: heldCursor })), "stale");

      // Even index zero can carry a digest: the preceding file filled the hit budget before any of
      // this file's records fit. Rewinding must preserve that content check too.
      await publishSegments(pinned, [segment({ id: "earlier", date: "2026-10-20" })]);
      const zero = await searchDaily(pinned, { limit: 1 });
      assert.ok(zero.next);
      assert.equal(zero.next.file, "2026-10-22.md");
      assert.equal(zero.next.index, 0);
      assert.notEqual(zero.next.fileDigest, null);
      await publishSegments(pinned, [segment({ id: "middle", date: "2026-10-21" })]);
      assert.equal(await errorCode(() => searchDaily(pinned, { cursor: zero.next ?? undefined })), "stale");
      const fresh = await searchDaily(pinned);
      assert.deepEqual(fresh.hits.map((hit) => hit.segment.id), ["earlier", "middle", "A", "B", "C"]);
    } finally {
      await dispose(pinned);
    }

    // Bounds are validated rather than clamped.
    assert.equal(await errorCode(() => searchDaily(daily, { limit: DAILY_LIMITS.hitsMax + 1 })), "invalid-input");
    assert.equal(await errorCode(() => searchDaily(daily, { maxFiles: 0 })), "invalid-input");
  } finally {
    await dispose(daily);
  }
});

test("04-E: a superseded fact is not returned as current, and history keeps the old state visible", async () => {
  const daily = await store();
  try {
    const original = segment({ id: "e1", date: "2026-10-10", kind: "user-requirement", text: "Deploy on Fridays." });
    await publishSegments(daily, [original]);

    // A later record replaces it. The replacement names what it supersedes; the old record is marked
    // in place, so the two facts cannot both read as current.
    const replacement = segment({
      id: "e2",
      date: "2026-10-12",
      kind: "user-requirement",
      text: "Do not deploy on Fridays.",
      supersedes: ["e1"],
    });
    await publishSegments(daily, [replacement]);

    const current = await searchDaily(daily, { text: "deploy" });
    assert.deepEqual(current.hits.map((hit) => hit.segment.id), ["e2"], "only the current requirement is returned");
    assert.equal(current.historyExcluded, 1);

    const history = await searchDaily(daily, { text: "deploy", includeHistory: true });
    assert.deepEqual(history.hits.map((hit) => hit.segment.id).sort(), ["e1", "e2"]);
    const old = history.hits.find((hit) => hit.segment.id === "e1");
    assert.equal(old?.segment.supersededBy, "e2", "the history view marks the old state as superseded");

    // Reading the old record by reference still works, and still says it is superseded: a stable
    // reference never silently becomes the new value.
    const direct = await readSegment(daily, { id: "e1", date: "2026-10-10" });
    assert.equal(direct.found, true);
    assert.equal(direct.found && direct.record.segment.supersededBy, "e2");
    assert.equal(direct.found && direct.record.segment.text, "Deploy on Fridays.");

    // A second replacement of the same record is refused rather than chained silently.
    assert.equal(
      await errorCode(() =>
        publishSegments(daily, [segment({ id: "e3", date: "2026-10-13", text: "Never deploy.", supersedes: ["e1"] })]),
      ),
      "revision-conflict",
    );
    // A replacement naming a record that is not there is refused, not written with a dangling link.
    assert.equal(
      await errorCode(() => publishSegments(daily, [segment({ id: "e4", date: "2026-10-14", text: "x", supersedes: ["nope"] })])),
      "not-covered",
    );
    assert.equal((await readSegment(daily, { id: "e4", date: "2026-10-14" })).found, false);

    // Across two files the old record is marked first and the replacement appended second. A failure
    // between the two can lose the new fact, but it cannot leave the old one reading as current: the
    // wrong answer would be "the old requirement still holds", and no retry can undo that.
    const prior = segment({ id: "e5", date: "2026-10-20", kind: "user-requirement", text: "Use tabs." });
    await publishSegments(daily, [prior]);
    const blocker = segment({ id: "keep", date: "2026-10-21", text: "unrelated" });
    await publishSegments(daily, [blocker]);
    const blockerFile = join(daily.root, DAILY_DIRECTORY, "2026-10-21.md");
    const blockerBefore = await readFile(blockerFile, "utf8");
    // Blocking the temp path fails independently of permissions and leaves the target readable.
    await mkdir(`${blockerFile}.tmp`);
    const successor = segment({ id: "e6", date: "2026-10-21", kind: "user-requirement", text: "Use spaces.", supersedes: ["e5"] });
    assert.equal(await errorCode(() => publishSegments(daily, [successor])), "io-failure");
    const afterFailure = await readSegment(daily, { id: "e5", date: "2026-10-20" });
    assert.equal(afterFailure.found && afterFailure.record.segment.supersededBy, "e6", "the old fact is already retired");
    assert.equal((await readSegment(daily, { id: "e6", date: "2026-10-21" })).found, false);
    assert.equal(await readFile(blockerFile, "utf8"), blockerBefore, "the target file is unchanged");

    // The retry lands the replacement and keeps the old one retired: one current requirement.
    await rm(`${blockerFile}.tmp`, { recursive: true });
    await publishSegments(daily, [successor]);
    const settled = await searchDaily(daily, { text: "use ", kinds: ["user-requirement"] });
    assert.deepEqual(settled.hits.map((hit) => hit.segment.id), ["e6"]);

    // Two replacements of one fact in a single call are refused: both would read as current while
    // the old record points at only one of them.
    const contested = segment({ id: "e7", date: "2026-10-30", kind: "user-requirement", text: "Use tabs, really." });
    await publishSegments(daily, [contested]);
    const rivalA = segment({ id: "e8", date: "2026-10-31", text: "Tabs.", supersedes: ["e7"] });
    const rivalB = segment({ id: "e9", date: "2026-11-01", text: "Spaces.", supersedes: ["e7"] });
    assert.equal(await errorCode(() => publishSegments(daily, [rivalA, rivalB])), "revision-conflict");
    assert.equal((await readSegment(daily, { id: "e8", date: "2026-10-31" })).found, false);
    assert.equal((await readSegment(daily, { id: "e9", date: "2026-11-01" })).found, false);
    const stillCurrent = await readSegment(daily, { id: "e7", date: "2026-10-30" });
    assert.equal(stillCurrent.found && stillCurrent.record.segment.supersededBy, null, "the old fact is untouched");

    // Across two files the ordering holds even when the *replacement* file is the one that fails.
    // Every mark is written before any replacement, so a fact is never published while the fact it
    // replaces still reads as current. Here A lives in file one, B in file two; C replaces B (file
    // one) and D replaces A (file two). File two can be replaced; file one's temp path is blocked.
    const markedA = segment({ id: "mA", date: "2026-12-01", text: "old A" });
    const markedB = segment({ id: "mB", date: "2026-12-02", text: "old B" });
    await publishSegments(daily, [markedA, markedB]);
    const fileOne = join(daily.root, DAILY_DIRECTORY, "2026-12-01.md");
    const fileTwo = join(daily.root, DAILY_DIRECTORY, "2026-12-02.md");
    const fileOneBefore = await readFile(fileOne, "utf8");
    await mkdir(`${fileOne}.tmp`);
    const replacesB = segment({ id: "mC", date: "2026-12-01", text: "new C", supersedes: ["mB"] });
    const replacesA = segment({ id: "mD", date: "2026-12-02", text: "new D", supersedes: ["mA"] });
    assert.equal(await errorCode(() => publishSegments(daily, [replacesB, replacesA])), "io-failure");
    assert.equal(await readFile(fileOne, "utf8"), fileOneBefore, "the failed mark leaves the whole old file");
    await rm(`${fileOne}.tmp`, { recursive: true });
    const aAfter = await readSegment(daily, { id: "mA", date: "2026-12-01" });
    const bAfter = await readSegment(daily, { id: "mB", date: "2026-12-02" });
    assert.equal(bAfter.found && bAfter.record.segment.supersededBy, "mC", "B was retired in the phase that succeeded");
    assert.equal(aAfter.found && aAfter.record.segment.supersededBy, null, "A's own mark failed, so A stays current");
    assert.equal((await readSegment(daily, { id: "mC", date: "2026-12-01" })).found, false);
    assert.equal((await readSegment(daily, { id: "mD", date: "2026-12-02" })).found, false);
    // The failure can leave an old fact with its successor missing, but never two current answers:
    // D is not published, so it cannot contradict the A that is still current.
    assert.equal(
      await readFile(fileTwo, "utf8").then((text) => text.includes("new D"), () => false),
      false,
      "the replacement was not published",
    );
    await publishSegments(daily, [replacesB, replacesA]);
    const currentAfterRetry = await searchDaily(daily, { text: "new ", kinds: ["result"] });
    assert.deepEqual(currentAfterRetry.hits.map((hit) => hit.segment.id).sort(), ["mC", "mD"]);
    const retiredAfterRetry = await searchDaily(daily, { text: "old ", kinds: ["result"] });
    assert.deepEqual(retiredAfterRetry.hits.map((hit) => hit.segment.id), [], "neither old fact is current");

    // A file holding both a mark and its own replacement is written in two passes for this reason:
    // the mark lands first, so a failure before the append leaves the old fact retired rather than
    // leaving two current answers.
    const sameFileOld = segment({ id: "s1", date: "2026-12-05", text: "same-file old" });
    await publishSegments(daily, [sameFileOld]);
    const sameFile = join(daily.root, DAILY_DIRECTORY, "2026-12-05.md");
    const sameFileNew = segment({ id: "s2", date: "2026-12-05", text: "same-file new", supersedes: ["s1"] });
    await publishSegments(daily, [sameFileNew]);
    const sameFileCurrent = await searchDaily(daily, { from: "2026-12-05", through: "2026-12-05" });
    assert.deepEqual(sameFileCurrent.hits.map((hit) => hit.segment.id), ["s2"]);
    assert.equal(await readFile(sameFile, "utf8").then((text) => text.includes("same-file old")), true);

    // Replaying a publish after the record has been superseded still returns the original receipt:
    // the published identity excludes the later state, so recovery does not turn into a conflict.
    const replay = await publishSegments(daily, [prior]);
    assert.deepEqual(replay.map((entry) => entry.status), ["duplicate"]);
    assert.equal(replay[0]?.digest, digestOfSegment({ ...prior, supersededBy: null }), "the receipt names the original content");
  } finally {
    await dispose(daily);
  }
});

test("04-F: files and text are bounded, and the module has no agent-runtime dependency", async () => {
  const source = await readFile(new URL("../src/memory/daily.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const specifiers = [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort();
  // Deliberately exact: a new dependency in the storage module is a contract change.
  assert.deepEqual(specifiers, ["./contracts.js", "node:crypto", "node:fs/promises", "node:path"]);
  assert.doesNotMatch(code, /pi-durable|pi-ai|chord|Harness|Telegram|process\.env/);
  // Reads are bounded at the source: `readFile` would buffer a whole file before the size check,
  // so the bound would limit the answer but not the memory. Reads go through a handle instead.
  assert.doesNotMatch(code, /\breadFile\b/, "no unbounded whole-file read");
  assert.match(code, /handle\.read\(/, "the reader stops at the byte bound");

  const daily = await store();
  try {
    // A full-length record is accepted; a longer one is refused by the frozen schema, not cut short.
    const longest = segment({ id: "f1", date: "2026-09-01", text: "x".repeat(MEMORY_LIMITS.note) });
    await publishSegments(daily, [longest]);
    assert.equal((await readSegment(daily, { id: "f1", date: "2026-09-01" })).found, true);
    assert.equal(
      await errorCode(() => publishSegments(daily, [segment({ id: "f2", date: "2026-09-01", text: "x".repeat(MEMORY_LIMITS.note + 1) })])),
      "invalid-input",
    );
    // More segments in one call than a file may hold is refused; the caller pages instead.
    const tooMany = Array.from({ length: DAILY_LIMITS.segmentsPerFile + 1 }, (_, index) => segment({ id: `m${index}`, date: "2026-09-02" }));
    assert.equal(await errorCode(() => publishSegments(daily, tooMany)), "budget-exceeded");

    // A date file that would exceed its segment bound is refused rather than split silently.
    const almost = Array.from({ length: DAILY_LIMITS.segmentsPerFile }, (_, index) => segment({ id: `n${index}`, date: "2026-09-03" }));
    await publishSegments(daily, almost);
    assert.equal(
      await errorCode(() => publishSegments(daily, [segment({ id: "overflow", date: "2026-09-03" })])),
      "budget-exceeded",
    );
    // The next page is the documented way out, and it holds the same content.
    const pageTwo = await publishSegments(daily, [segment({ id: "overflow", date: "2026-09-03", page: 2 })]);
    assert.deepEqual(pageTwo.map((entry) => entry.file), ["2026-09-03-2.md"]);
    assert.equal((await readSegment(daily, { id: "overflow", date: "2026-09-03", page: 2 })).found, true);
    // A page number outside the frozen range is rejected by the naming rule.
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-09-03", page: 10 })), "invalid-input");

    // An oversized file is refused without buffering it whole. 8 MiB is eight times the bound, and
    // the read stops one byte past the bound: the test asserts the refusal, and the allocation stays
    // bounded because the reader never asks for more than that.
    const oversized = join(daily.root, DAILY_DIRECTORY, "2026-09-04.md");
    await writeFile(oversized, `# 2026-09-04\n\n${"x".repeat(8 * 1024 * 1024)}`);
    assert.equal(await errorCode(() => readSegment(daily, { id: "x", date: "2026-09-04" })), "budget-exceeded");
    assert.equal(await errorCode(() => searchDaily(daily, { from: "2026-09-04", through: "2026-09-04" })), "budget-exceeded");
    // A file exactly at the bound is read, so the limit is a bound and not an off-by-one refusal.
    const exact = join(daily.root, DAILY_DIRECTORY, "2026-09-05.md");
    const header = "# 2026-09-05\n\n";
    await writeFile(exact, header + "\n".repeat(DAILY_LIMITS.fileBytes - Buffer.byteLength(header)));
    assert.deepEqual(await readSegment(daily, { id: "x", date: "2026-09-05" }), {
      found: false,
      reason: "missing-segment",
    });
    await rm(oversized, { force: true });
    await rm(exact, { force: true });

    // Many date files: one call reads at most its bound and says how many it left.
    for (let day = 1; day <= 24; day += 1) {
      const date = `2026-08-${String(day).padStart(2, "0")}`;
      await publishSegments(daily, [segment({ id: `d${day}`, date, text: `august ${day}` })]);
    }
    const bounded = await searchDaily(daily, { text: "fact", limit: DAILY_LIMITS.hitsMax });
    assert.ok(bounded.scanned.files <= DAILY_LIMITS.scanFiles, `read ${bounded.scanned.files} files`);
    assert.equal(bounded.available, 27, "every date file is counted, including the paged one");
    assert.ok(bounded.unread.length > 0, "the files beyond the bound are named as unread");
    assert.equal(bounded.scanned.files + bounded.unread.length, bounded.available);

    // The unknown-date file sorts last and keeps its event time unknown rather than pretending.
    await publishSegments(daily, [segment({ id: "u1", date: UNKNOWN_DATE, text: "undated fact" })]);
    const withUnknown = await searchDaily(daily, {
      from: "2026-08-01",
      text: "undated",
      limit: DAILY_LIMITS.hitsMax,
      maxFiles: DAILY_LIMITS.scanFilesMax,
    });
    assert.deepEqual(withUnknown.hits.map((hit) => hit.segment.id), ["u1"]);
    assert.equal(withUnknown.scanned.through, `${UNKNOWN_DATE}.md`);
  } finally {
    await dispose(daily);
  }
});
