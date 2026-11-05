import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  ToolResultEntry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
  MemoryError,
  WorkingAnchorEntry,
  WorkingReceiptDoc,
  type WorkingReceipt,
  type WorkingState,
} from "../src/memory/contracts.js";
import {
  activeTask,
  applyWorkingUpdate,
  readCompleted,
  readWorking,
  readWorkingAt,
  readWorkingReceipt,
} from "../src/memory/working.js";
import { workingExtension, workingTools } from "../src/memory/working-tools.js";

const context = BACKGROUND_CONTEXT;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const agent = { model: { provider: "faux", modelId: "faux-1" } };

type Fixture = {
  readonly directory: string;
  readonly database: string;
  readonly faux: FauxProviderHandle;
  harness: Harness;
  root: Conversation;
};

async function openFixture(name: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const database = join(directory, "agent.sqlite");
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(workingExtension);
  const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
  const root = await harness.root(context, { agent });
  harness.resume();
  return { directory, database, faux, harness, root };
}

/** Reopen the same database, as a restart does; the module must read everything back from storage. */
async function reopen(fixture: Fixture): Promise<void> {
  await fixture.harness.close(context);
  const models = createModels();
  models.setProvider(fixture.faux.provider);
  const registry = createRegistry();
  registry.install(workingExtension);
  fixture.harness = await Harness.open(await openNodeSqliteStorage(fixture.database), { models, registry }, context);
  fixture.root = await fixture.harness.root(context, { agent });
  fixture.harness.resume();
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.harness.close(context).catch(() => {});
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

/** A committed user entry: the evidence a real update cites. */
async function userEntry(fixture: Fixture, text: string): Promise<EntryId> {
  return fixture.harness.commit(
    async (tx) => (await tx.appendEntry(fixture.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
    })).id,
    context,
  );
}

function taskDraft(goal: string, extra: { constraints?: string[] } = {}) {
  return {
    status: "active" as const,
    goal,
    scope: null,
    constraints: extra.constraints ?? [],
    progress: [],
    blockers: [],
    nextStep: null,
    notes: null,
  };
}

function update(fixture: Fixture, fields: {
  operationId: string;
  expectedRevision: number;
  evidence?: EntryId[];
  changes: Parameters<typeof applyWorkingUpdate>[1]["changes"];
  now?: number;
}) {
  return applyWorkingUpdate(fixture.harness, {
    conversationId: fixture.root.id,
    operationId: fields.operationId,
    expectedRevision: fields.expectedRevision,
    evidence: fields.evidence ?? [],
    changes: fields.changes,
    now: fields.now ?? Date.now(),
  }, context);
}

function read(fixture: Fixture, conversationId: ConversationId = fixture.root.id): Promise<WorkingState> {
  return readWorking(fixture.harness, conversationId, context);
}

async function entriesOfKind(fixture: Fixture, kind: string) {
  const page = await fixture.root.entries({ order: "ascending" }, 200, undefined, context);
  return page.items.filter((entry) => entry.kind === kind);
}

function toolResults(entries: readonly EntryRecord[]) {
  return entries
    .filter((entry) => ToolResultEntry.is(entry))
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
}

/** The text a tool result shows the model; diagnostics are rendered into it by the Harness. */
function textOf(message: { readonly content: readonly { readonly type: string }[] }): string {
  return message.content.flatMap((part) => (part.type === "text" ? [(part as unknown as { text: string }).text] : [])).join("\n");
}

const isMemoryError = (code: string) => (error: unknown) => error instanceof MemoryError && error.code === code;

// 02-A: a rejected update writes nothing and is reported as a correctable tool result, so the model can
// fix its call. The model can never name the conversation, the operation, or the revision to write.
test("02-A: invalid arguments, foreign evidence and a stale revision write nothing and stay correctable", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-02a-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    fixture.faux.setResponses([
      // Unknown field: the model tries to name the conversation itself.
      fauxAssistantMessage(fauxToolCall("working_update", {
        conversationId: fixture.root.id,
        expectedRevision: 1,
        evidence: [seed],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "unknown-field" }), { stopReason: "toolUse" }),
      // Empty change list.
      fauxAssistantMessage(fauxToolCall("working_update", { expectedRevision: 1, evidence: [seed], changes: [] }, { id: "empty" }), { stopReason: "toolUse" }),
      // A task change with no evidence.
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 1,
        evidence: [],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "no-evidence" }), { stopReason: "toolUse" }),
      // Evidence that is not committed in this conversation.
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 1,
        evidence: [999_999],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "foreign-evidence" }), { stopReason: "toolUse" }),
      // A revision the state is not at.
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 7,
        evidence: [seed],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "stale" }), { stopReason: "toolUse" }),
      // The correction.
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 1,
        evidence: [seed],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "corrected" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Task tracked."),
    ]);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "Track the release task.", requestId: "02a" }, context)).wait(context)).status, "done");

    const results = toolResults((await fixture.root.entries({ order: "ascending" }, 200, undefined, context)).items);
    const byId = new Map(results.map((message) => [message.toolCallId, message]));
    const rejected = ["unknown-field", "empty", "no-evidence", "foreign-evidence", "stale"];
    for (const id of rejected) {
      const result = byId.get(id);
      assert.ok(result !== undefined, `no result for ${id}`);
      assert.equal(result.isError, true, `${id} must be a correctable error result`);
    }
    assert.match(textOf(byId.get("unknown-field")!), /Validation failed/);
    assert.match(textOf(byId.get("empty")!), /Validation failed/);
    assert.match(textOf(byId.get("no-evidence")!), /missing-evidence/);
    assert.match(textOf(byId.get("foreign-evidence")!), /missing-evidence/);
    assert.match(textOf(byId.get("stale")!), /revision-conflict/);

    const corrected = byId.get("corrected")!;
    assert.equal(corrected.isError, false);
    assert.match(textOf(corrected), /revision 2/);
    // The result is bounded: identifiers and the model's own text, no sources or host state.
    assert.doesNotMatch(textOf(corrected), /conversationId|anchorEntryId|entryId/);

    const state = await read(fixture);
    assert.equal(state.revision, 2, "only the valid call changed the state");
    assert.equal(activeTask(state)?.goal, "Ship the fix");
    assert.deepEqual(activeTask(state)?.sources, [{ conversationId: fixture.root.id, entryId: seed }]);
    assert.equal((await entriesOfKind(fixture, WorkingAnchorEntry.kind)).length, 1, "a rejected update writes no anchor");
  } finally {
    await dispose(fixture);
  }
});

// 02-B: the update commits before its tool result does. Recovery reruns the same call, which finds its
// receipt and returns it unchanged — the change applies once and the revision does not move again.
test("02-B: a crash between the commit and the tool result applies the update once", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-02b-"));
  const database = join(directory, "agent.sqlite");
  const marker = join(directory, "committed.txt");
  let fixture: Fixture | undefined;
  try {
    const child = spawn(process.execPath, ["--import", "tsx", join(fixtures, "crash-working.ts"), database, marker], {
      cwd: projectRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = once(child, "exit");
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await access(marker);
          break;
        } catch {
          if (Date.now() > deadline) throw new Error("the fixture never committed the update");
          await delay(25);
        }
      }
    } finally {
      child.kill("SIGKILL");
    }
    await exited;
    const beforeCrash = JSON.parse(await readFile(marker, "utf8")) as WorkingReceipt;

    const faux = fauxProvider({ provider: "faux" });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    // Record each execution in the recovering process, so "the change applied once" is checked against
    // a rerun that really happened rather than against a run that never resumed.
    const reruns: string[] = [];
    const update = workingTools().find((tool) => tool.name === "working_update")!;
    registry.install({
      name: "working-crash",
      tools: [{
        ...update,
        execute: async (args, api, ctx) => {
          reruns.push(api.taskId.toString());
          return update.execute(args, api, ctx);
        },
      }],
    });
    const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
    const root = await harness.root(context, { agent });
    fixture = { directory, database, faux, harness, root };
    faux.setResponses([fauxAssistantMessage("Recovered.")]);
    harness.resume();
    const submission = await harness.commit(
      async (tx) => tx.submissionByRequest(root.id, "crash-working"),
      context,
    );
    assert.ok(submission !== undefined, "the interrupted request is still recoverable by its id");
    await harness.waitForIdle(context);

    const state = await readWorking(harness, root.id, context);
    assert.equal(state.revision, beforeCrash.revision, "the rerun must not increment the revision again");
    assert.equal(activeTask(state)?.goal, "Ship the fix");
    assert.equal(activeTask(state)?.constraints[0], "keep the diff small");

    const anchors = await entriesOfKind(fixture, WorkingAnchorEntry.kind);
    assert.equal(anchors.length, 1, "the change applied exactly once");
    const stored = await readWorkingReceipt(harness, root.id, beforeCrash.operationId, context);
    assert.deepEqual(stored, beforeCrash, "the rerun returns the original receipt");
    assert.equal(stored?.anchorEntryId, anchors[0]!.id);

    const results = toolResults((await root.entries({ order: "ascending" }, 200, undefined, context)).items);
    const result = results.find((message) => message.toolCallId === "update");
    assert.ok(result !== undefined, "the recovered run stored a tool result");
    assert.equal(result.isError, false);
    assert.match(textOf(result), new RegExp(`revision ${beforeCrash.revision}`));
    // The tool really reran — it is `replay: "safe"` — and that rerun produced the stored result.
    assert.equal(reruns.length, 1, "the recovered process reran the update exactly once");
  } finally {
    if (fixture !== undefined) await dispose(fixture);
    else await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

// 02-C: two updates read the same revision; the second is rejected instead of overwriting the first.
// An update with no business effect is acknowledged without a revision change.
test("02-C: a concurrent update loses to the revision guard and a no-op keeps the revision", { timeout: 30_000 }, async () => {
  const fixture = await openFixture("memory-02c-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    const first = await update(fixture, {
      operationId: "tool:1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      now: 10,
    });
    assert.equal(first.changed, true);
    assert.equal(first.revision, 2);

    // A second update written against the revision the first one consumed.
    await assert.rejects(
      update(fixture, {
        operationId: "tool:2",
        expectedRevision: 1,
        evidence: [seed],
        changes: [{ op: "task.set", task: taskDraft("Do something else") }],
      }),
      isMemoryError("revision-conflict"),
    );
    const afterConflict = await read(fixture);
    assert.equal(afterConflict.revision, 2);
    assert.equal(activeTask(afterConflict)?.goal, "Ship the fix", "the rejected update must not overwrite");

    // The same content again: acknowledged, nothing written, no revision change.
    const noop = await update(fixture, {
      operationId: "tool:3",
      expectedRevision: 2,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      now: 20,
    });
    assert.equal(noop.changed, false);
    assert.equal(noop.revision, 2);
    assert.equal(noop.previousRevision, 2);
    const afterNoop = await read(fixture);
    assert.equal(afterNoop.revision, 2);
    assert.equal(afterNoop.updatedAt, 10, "a no-op does not rewrite the state");

    // A second update that did change something still needs the current revision.
    const third = await update(fixture, {
      operationId: "tool:4",
      expectedRevision: 2,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints: ["keep the diff small"] }) }],
      now: 30,
    });
    assert.equal(third.revision, 3);
  } finally {
    await dispose(fixture);
  }
});

// 02-D: current and boundary reads stay correct across updates and a restart, and the ordered revisions
// let a reader holding an older boundary state derive the current one.
test("02-D: boundary reads survive later updates and a restart", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-02d-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    const first = await update(fixture, {
      operationId: "tool:1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      now: 10,
    });
    const second = await update(fixture, {
      operationId: "tool:2",
      expectedRevision: first.revision,
      evidence: [seed],
      changes: [
        { op: "task.set", task: taskDraft("Ship the fix", { constraints: ["keep the diff small"] }) },
        { op: "preference.put", preference: { id: "tone", text: "Be concise", scope: "global", source: seed, expiresAt: null } },
      ],
      now: 20,
    });
    assert.equal(second.revision, 3);

    const current = await read(fixture);
    assert.equal(current.revision, 3);
    assert.equal(current.preferences.length, 1);
    const atFirst = await readWorkingAt(fixture.harness, fixture.root.id, first.anchorEntryId, context);
    assert.equal(atFirst.revision, 2);
    assert.equal(activeTask(atFirst)?.goal, "Ship the fix");
    assert.deepEqual(atFirst.preferences, [], "the preference did not exist at the earlier boundary");

    // Every anchor's boundary state is exactly the revision it records, and the newest one is current.
    const anchors = await entriesOfKind(fixture, WorkingAnchorEntry.kind);
    assert.deepEqual(anchors.map((entry) => (entry.data as { revision: number }).revision), [2, 3]);
    for (const anchor of anchors) {
      const boundary = await readWorkingAt(fixture.harness, fixture.root.id, anchor.id, context);
      assert.equal(boundary.revision, (anchor.data as { revision: number }).revision);
    }
    assert.deepEqual(
      await readWorkingAt(fixture.harness, fixture.root.id, anchors.at(-1)!.id, context),
      current,
      "a reader holding the newest boundary state has the current state",
    );

    await reopen(fixture);
    const restarted = await read(fixture);
    assert.deepEqual(restarted, current, "the current state is restored from storage");
    const restartedBoundary = await readWorkingAt(fixture.harness, fixture.root.id, first.anchorEntryId, context);
    assert.deepEqual(restartedBoundary, atFirst, "the boundary read is restored too");

    // A boundary before the first update has no state: an explicit rejection, never a default.
    const earliest = await fixture.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: fixture.root.id, order: "ascending" }, 1)).items[0]!,
      context,
    );
    await assert.rejects(
      readWorkingAt(fixture.harness, fixture.root.id, earliest.id, context),
      isMemoryError("not-covered"),
    );
  } finally {
    await dispose(fixture);
  }
});

// 02-E: clearing the task keeps a durable completion fact and every valid preference; a one-off
// instruction never becomes a preference by itself.
test("02-E: completion is durable and preferences outlive the task", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-02e-");
  try {
    const seed = await userEntry(fixture, "Track the release task and answer in Chinese from now on.");
    const first = await update(fixture, {
      operationId: "tool:1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [
        { op: "task.set", task: taskDraft("Ship the fix", { constraints: ["do not change the API"] }) },
        { op: "preference.put", preference: { id: "language", text: "Answer in Chinese", scope: "global", source: seed, expiresAt: null } },
        { op: "preference.put", preference: { id: "format", text: "Use short paragraphs", scope: "replies", source: seed, expiresAt: 4_102_444_800_000 } },
      ],
      now: 10,
    });
    assert.equal(first.revision, 2);

    // A one-off instruction stays in the task, not in preferences: only an explicit put creates one.
    const second = await update(fixture, {
      operationId: "tool:2",
      expectedRevision: 2,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints: ["do not change the API", "only this once: skip the changelog"] }) }],
      now: 20,
    });
    assert.equal(second.revision, 3);
    assert.deepEqual((await read(fixture)).preferences.map((preference) => preference.id), ["language", "format"]);

    const cleared = await update(fixture, {
      operationId: "tool:3",
      expectedRevision: 3,
      evidence: [seed],
      changes: [{ op: "task.clear" }],
      now: 30,
    });
    assert.equal(cleared.changed, true);
    assert.notEqual(cleared.completedEntryId, null);

    const state = await read(fixture);
    assert.equal(activeTask(state), undefined, "the active items are cleared");
    assert.equal(state.revision, 4);
    assert.deepEqual(state.preferences.map((preference) => preference.id), ["language", "format"], "valid preferences survive");

    // The completion fact is re-readable by its entry, also after a restart.
    const completed = await fixture.harness.commit(async (tx) => readCompleted(tx, cleared.completedEntryId!), context);
    assert.equal(completed?.goal, "Ship the fix");
    assert.equal(completed?.operationId, "tool:3");
    assert.deepEqual(completed?.sources, [{ conversationId: fixture.root.id, entryId: seed }]);
    const anchor = await entriesOfKind(fixture, WorkingAnchorEntry.kind);
    assert.equal((anchor.at(-1)!.data as { completedEntryId: number | null }).completedEntryId, cleared.completedEntryId);

    await reopen(fixture);
    assert.deepEqual(await read(fixture), state, "the cleared state and its preferences survive a restart");
    const recovered = await fixture.harness.commit(async (tx) => readCompleted(tx, cleared.completedEntryId!), context);
    assert.deepEqual(recovered, completed, "the completion fact is re-readable after a restart");

    // Clearing again is a no-op, not a second completion fact.
    const again = await update(fixture, { operationId: "tool:4", expectedRevision: 4, evidence: [seed], changes: [{ op: "task.clear" }], now: 40 });
    assert.equal(again.changed, false);
    assert.equal(again.completedEntryId, null);
    assert.equal(again.revision, 4);
  } finally {
    await dispose(fixture);
  }
});

// 02-F: reaching a limit is an explicit rejection; the stored constraints and preferences are never
// truncated to make room.
test("02-F: a state limit rejects the update and keeps what is stored", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-02f-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    const constraints = Array.from({ length: MEMORY_LIMITS.constraints }, (_, index) => `constraint ${index + 1}`);
    const preference = (index: number) => ({
      op: "preference.put" as const,
      preference: { id: `pref-${index}`, text: `preference ${index}`, scope: "global", source: seed, expiresAt: null },
    });
    // One update carries at most `changes` changes, so the last preference goes in a second one.
    const full = await update(fixture, {
      operationId: "tool:1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [
        { op: "task.set", task: taskDraft("Ship the fix", { constraints }) },
        ...Array.from({ length: MEMORY_LIMITS.preferences - 1 }, (_, index) => preference(index + 1)),
      ],
      now: 10,
    });
    assert.equal(full.revision, 2);
    assert.equal(full.changes.length, MEMORY_LIMITS.changes);
    const filled = await update(fixture, {
      operationId: "tool:2",
      expectedRevision: 2,
      evidence: [seed],
      changes: [preference(MEMORY_LIMITS.preferences)],
      now: 20,
    });
    assert.equal(filled.revision, 3);
    const before = await read(fixture);
    assert.equal(before.preferences.length, MEMORY_LIMITS.preferences);
    assert.equal(activeTask(before)?.constraints.length, MEMORY_LIMITS.constraints);

    await assert.rejects(
      update(fixture, {
        operationId: "tool:3",
        expectedRevision: 3,
        evidence: [seed],
        changes: [preference(MEMORY_LIMITS.preferences + 1)],
      }),
      isMemoryError("invalid-input"),
    );
    // Over the constraint bound is rejected by the schema before any write, not silently cut to 16.
    await assert.rejects(
      update(fixture, {
        operationId: "tool:4",
        expectedRevision: 3,
        evidence: [seed],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix", { constraints: [...constraints, "one more"] }) }],
      }),
      isMemoryError("invalid-input"),
    );
    assert.deepEqual(await read(fixture), before, "a rejected update changes nothing and drops no constraint");

    // An already-expired preference is rejected instead of being stored dead.
    await assert.rejects(
      update(fixture, {
        operationId: "tool:5",
        expectedRevision: 3,
        evidence: [seed],
        changes: [{ op: "preference.put", preference: { id: "expired", text: "gone", scope: "global", source: seed, expiresAt: 5 } }],
      }),
      isMemoryError("invalid-input"),
    );

    // Removing one makes room again; the model sees the explicit error first, then succeeds.
    const removed = await update(fixture, { operationId: "tool:6", expectedRevision: 3, evidence: [seed], changes: [{ op: "preference.remove", id: "pref-1" }], now: 30 });
    assert.equal(removed.revision, 4);
    const added = await update(fixture, {
      operationId: "tool:7",
      expectedRevision: 4,
      evidence: [seed],
      changes: [preference(MEMORY_LIMITS.preferences + 1)],
      now: 40,
    });
    assert.equal(added.revision, 5);
    const after = await read(fixture);
    assert.equal(after.preferences.length, MEMORY_LIMITS.preferences);
    assert.equal(activeTask(after)?.constraints.length, MEMORY_LIMITS.constraints, "the task survived every rejection");
  } finally {
    await dispose(fixture);
  }
});

// The module-level guarantees the tool layer relies on: a stored value that no longer matches its
// schema is an explicit corrupt-state error, never a silently repaired or defaulted state.
test("02-G: an unsupported stored value is an explicit error, not a default", { timeout: 30_000 }, async () => {
  const fixture = await openFixture("memory-02g-");
  try {
    const seed = await userEntry(fixture, "Track the release task.");
    const receipt = await update(fixture, {
      operationId: "tool:1",
      expectedRevision: 1,
      evidence: [seed],
      changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      now: 10,
    });
    // A stored receipt of another schema version is rejected rather than reinterpreted.
    await fixture.harness.commit(async (tx) => {
      const slot = await tx.doc(WorkingReceiptDoc, fixture.root.id, receipt.operationId, receipt);
      (slot as unknown as { version: number }).version = MEMORY_SCHEMA_VERSION + 1;
    }, context);
    await assert.rejects(
      readWorkingReceipt(fixture.harness, fixture.root.id, receipt.operationId, context),
      isMemoryError("corrupt-state"),
    );
  } finally {
    await dispose(fixture);
  }
});

// 02-H: entry ids never appear in the transcript the model reads, so the tools must tell the
// model which ids it may cite. Regression test for the MEM-08 live finding F-1, where a real
// model guessed `evidence: [1]` on every attempt and working state never persisted: working_read
// now lists the recent user entry ids, and a missing-evidence rejection names them too.
test("02-H: working_read lists citable entry ids and a missing-evidence rejection names them", { timeout: 60_000 }, async () => {
  const fixture = await openFixture("memory-02h-");
  try {
    const first = await userEntry(fixture, "Track the release task.");
    const second = await userEntry(fixture, "The release ships on Friday.");
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("working_read", {}, { id: "read-first" }), { stopReason: "toolUse" }),
      // An id that is not committed in this conversation, as a model guessing ids would pass.
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 1,
        evidence: [999_999],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "bad-evidence" }), { stopReason: "toolUse" }),
      // The correction, citing an id the read listed.
      fauxAssistantMessage(fauxToolCall("working_update", {
        expectedRevision: 1,
        evidence: [second],
        changes: [{ op: "task.set", task: taskDraft("Ship the fix") }],
      }, { id: "corrected" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Task tracked."),
    ]);
    assert.equal((await (await fixture.root.submit({ type: "input", content: "Track the release task.", requestId: "02h" }, context)).wait(context)).status, "done");

    const results = toolResults((await fixture.root.entries({ order: "ascending" }, 200, undefined, context)).items);
    const byId = new Map(results.map((message) => [message.toolCallId, message]));

    const read = byId.get("read-first")!;
    assert.equal(read.isError, false);
    assert.match(textOf(read), new RegExp(`recent user entries \\(newest last\\): ${first}, ${second}`));

    const rejected = byId.get("bad-evidence")!;
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /missing-evidence/);
    assert.match(textOf(rejected), /Retry with one of these ids/);
    assert.match(textOf(rejected), new RegExp(`${second}`));

    const corrected = byId.get("corrected")!;
    assert.equal(corrected.isError, false);
    const state = await readWorking(fixture.harness, fixture.root.id, context);
    assert.equal(state.revision, 2, "the corrected call applies the update");
    assert.deepEqual(activeTask(state)?.sources, [{ conversationId: fixture.root.id, entryId: second }]);
  } finally {
    await dispose(fixture);
  }
});
