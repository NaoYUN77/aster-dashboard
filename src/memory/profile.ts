// Profile extraction from daily-log segments (ADR-0016).
//
// Interface
//   extractProfileDrafts(segments)              -> profile drafts a host can apply with `profile.put`
//   profilePutChanges(drafts)                   -> one `profile.put` per draft
//   profilePutChangesWithinLimit(profile, drafts) -> the puts that fit the stored cap
//   profileOperationId(batchId)                 -> stable idempotency key for one archive batch
//   requireCurrentProfileEvidence(store, refs)  -> resolves refs or throws `missing-evidence`
//
// The filter keeps current `user-requirement` segments whose text already fits a profile item.
// Longer text is left in the daily log: this pass does not shorten it. It does not call a model.
// The archive task runs it after a batch is published; this module does not write working state.

import { createHash } from "node:crypto";
import {
  assertSchema,
  MEMORY_LIMITS,
  MemoryError,
  ProfileItemDraftSchema,
  type DailySegmentRef,
  type MemorySegment,
  type ProfileItemDraft,
  type WorkingChangeDraft,
} from "./contracts.js";
import { readSegment, type DailyStore } from "./daily.js";

export type ProfileDraft = ProfileItemDraft;

/**
 * Draft profile items from daily-log segments. Segments that are not a current user requirement,
 * or whose text is longer than `MEMORY_LIMITS.text`, are omitted. Duplicate segment ids keep the
 * first draft.
 */
export function extractProfileDrafts(segments: readonly MemorySegment[]): ProfileDraft[] {
  const drafts: ProfileDraft[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== "user-requirement" || segment.supersededBy !== null) continue;
    if (segment.text.length > MEMORY_LIMITS.text) continue;
    if (seen.has(segment.id)) continue;
    seen.add(segment.id);
    drafts.push(assertSchema<ProfileDraft>(ProfileItemDraftSchema, {
      id: segment.id,
      text: segment.text,
      category: segment.kind,
      evidence: [{ date: segment.date, id: segment.id, page: segment.page }],
    }, "invalid-input"));
  }
  return drafts;
}

/** `profile.put` changes for drafts `extractProfileDrafts` returned. The host still supplies revision and operation id. */
export function profilePutChanges(drafts: readonly ProfileDraft[]): WorkingChangeDraft[] {
  return drafts.map((item) => ({ op: "profile.put", item }));
}

/**
 * Puts that fit the stored profile. Replacements of an existing id always fit. New ids are added
 * until `MEMORY_LIMITS.profile` is reached; the rest are omitted and stay in the daily log.
 * Stored items are not removed or shortened to make room.
 */
export function profilePutChangesWithinLimit(
  profile: readonly { readonly id: string }[],
  drafts: readonly ProfileDraft[],
): WorkingChangeDraft[] {
  const existing = new Set(profile.map((item) => item.id));
  let room = MEMORY_LIMITS.profile - existing.size;
  const changes: WorkingChangeDraft[] = [];
  for (const item of drafts) {
    if (!existing.has(item.id)) {
      if (room <= 0) continue;
      room -= 1;
      existing.add(item.id);
    }
    changes.push({ op: "profile.put", item });
  }
  return changes;
}

/** Idempotency key for the profile write of one archive batch. Stable across retries of that batch. */
export function profileOperationId(batchId: string): string {
  return `pf.${createHash("sha256").update(batchId).digest("hex").slice(0, 16)}`;
}

/**
 * Each ref must name a daily-log segment that is still current (`supersededBy === null`).
 * A missing file, a missing segment, or a superseded segment is `missing-evidence`.
 */
export async function requireCurrentProfileEvidence(
  store: DailyStore,
  refs: readonly DailySegmentRef[],
): Promise<void> {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.date}\0${ref.page}\0${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = await readSegment(store, { date: ref.date, id: ref.id, page: ref.page });
    if (!found.found) {
      throw new MemoryError("missing-evidence", "Profile evidence segment is not in the daily log", {
        detail: { date: ref.date, id: ref.id, page: ref.page, reason: found.reason },
      });
    }
    const segment = found.record.segment;
    if (segment.id !== ref.id || segment.date !== ref.date || segment.page !== ref.page || segment.supersededBy !== null) {
      throw new MemoryError("missing-evidence", "Profile evidence segment is not current", {
        detail: {
          date: ref.date,
          id: ref.id,
          page: ref.page,
          supersededBy: segment.supersededBy,
        },
      });
    }
  }
}
