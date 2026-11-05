// Durable adapter of the Working Module: the two native tools the model uses.
//
// The model names what changed; the host supplies conversation identity, the operation id, and the
// clock. `working_update` is replay-safe because the module's receipt makes a rerun return the
// original result: the document, the anchor entry, and the receipt share one commit, so a crash
// between them is impossible. A crash after that commit but before the tool result is saved reruns
// the same operation id, reads the stored receipt, and changes nothing.
//
// Model-visible results are text plus a bounded structured value; neither carries memory prose
// beyond what the model itself just wrote. A rejected update returns `isError` so the model can
// correct it; it never fails the request.

import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type EntryId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  activeTask,
  applyWorkingUpdate,
  readWorking,
  type Committer,
  type ProfileEvidenceResolver,
} from "./working.js";
import { DAILY_MAX_PAGES, MEMORY_LIMITS, MemoryError, WorkingUpdateArgsSchema, type WorkingState } from "./contracts.js";

/** The state a model may see: identifiers, revision, and text it wrote itself. */
function renderState(state: WorkingState): string {
  const task = activeTask(state);
  const lines = [`revision: ${state.revision}`];
  if (task === undefined) {
    lines.push("task: none");
  } else {
    lines.push(`task: ${task.goal}`);
    if (task.scope !== null) lines.push(`scope: ${task.scope}`);
    if (task.constraints.length > 0) lines.push(`constraints: ${task.constraints.join("; ")}`);
    if (task.blockers.length > 0) lines.push(`blockers: ${task.blockers.join("; ")}`);
    if (task.nextStep !== null) lines.push(`next step: ${task.nextStep}`);
    lines.push(`progress: ${task.progress.length === 0 ? "none" : task.progress.map((item) => `[${item.status}] ${item.text}`).join("; ")}`);
  }
  const preferences = state.preferences.filter((preference) => preference.expiresAt === null || preference.expiresAt > Date.now());
  lines.push(`preferences: ${preferences.length === 0 ? "none" : preferences.map((preference) => `${preference.id}: ${preference.text} (${preference.scope})`).join("; ")}`);
  lines.push(renderProfile(state));
  return lines.join("\n");
}

/** Model-visible profile line. Evidence is included so a later put can cite the same daily segment. */
function renderProfile(state: WorkingState): string {
  if (state.profile.length === 0) return "profile: none";
  const items = state.profile.map((item) => {
    const evidence = item.evidence.map((ref) => `${ref.date}/${ref.id} p${ref.page}`).join(", ");
    return `${item.id}: ${item.text} (${item.category}; ${evidence})`;
  });
  return `profile: ${items.join("; ")}`;
}

const structuredStateSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    task: Type.Union([Type.Literal("none"), Type.String({ maxLength: MEMORY_LIMITS.goal })]),
    preferences: Type.Array(
      Type.Object(
        { id: Type.String({ maxLength: MEMORY_LIMITS.identifier }), text: Type.String({ maxLength: MEMORY_LIMITS.text }) },
        { additionalProperties: false },
      ),
      { maxItems: MEMORY_LIMITS.preferences },
    ),
    profile: Type.Array(
      Type.Object(
        {
          id: Type.String({ maxLength: MEMORY_LIMITS.identifier }),
          text: Type.String({ maxLength: MEMORY_LIMITS.text }),
          category: Type.String({ maxLength: MEMORY_LIMITS.category }),
          evidence: Type.Array(
            Type.Object(
              {
                date: Type.String({ maxLength: 10 }),
                id: Type.String({ maxLength: MEMORY_LIMITS.identifier }),
                page: Type.Integer({ minimum: 1, maximum: DAILY_MAX_PAGES }),
              },
              { additionalProperties: false },
            ),
            { maxItems: MEMORY_LIMITS.sources },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: MEMORY_LIMITS.profile },
    ),
  },
  { additionalProperties: false },
);

function structuredState(state: WorkingState) {
  const task = activeTask(state);
  return {
    revision: state.revision,
    task: task === undefined ? ("none" as const) : task.goal,
    preferences: state.preferences.map((preference) => ({ id: preference.id, text: preference.text })),
    profile: state.profile.map((item) => ({
      id: item.id,
      text: item.text,
      category: item.category,
      evidence: item.evidence.map((ref) => ({ date: ref.date, id: ref.id, page: ref.page })),
    })),
  };
}

/** How many recent user entries are offered as citable evidence ids. */
const EVIDENCE_HINT_LIMIT = 5;

/**
 * Numeric ids of the newest committed user entries in this conversation, oldest first.
 * Entry ids are host-assigned and never appear in the transcript the model reads, so without
 * this list the model cannot cite evidence at all: the MEM-08 live run showed a real model
 * guessing `evidence: [1]` on every attempt and being rejected every time (finding F-1).
 * Best-effort: a scan failure yields no hint, never a failed tool call.
 */
async function recentUserEntryIds(
  committer: Committer,
  conversationId: ConversationId,
  context: Context,
): Promise<EntryId[]> {
  try {
    return await committer.commit(async (tx) => {
      const page = await tx.scanEntries({ conversationId, order: "descending" }, 500);
      return page.items
        .filter((entry) => entry.kind === "pi.user")
        .slice(0, EVIDENCE_HINT_LIMIT)
        .map((entry) => entry.id)
        .reverse();
    }, context);
  } catch {
    return [];
  }
}

function evidenceHint(ids: readonly EntryId[]): string {
  return `recent user entries (newest last): ${ids.join(", ")}`;
}

/** Working tools bound to the calling conversation; no parameter can select another one. */
export function workingTools(options: { readonly resolveProfileEvidence?: ProfileEvidenceResolver } = {}): ToolRegistration[] {
  const read = defineTool({
    name: "working_read",
    description:
      "Read the current working state: the active task, its progress and blockers, the preferences that outlive it, and the user profile. Call it before updating so the revision you pass is current. The result also lists the numeric entry ids of recent user messages: cite those ids as evidence in working_update, never guess an entry id. Profile lines cite daily-log segments as date/id page; pass those refs back on profile.put.",
    parameters: Type.Object({}, { additionalProperties: false }),
    structuredOutputSchema: structuredStateSchema,
    replay: "safe",
    execute: async (_args, api, context) => {
      const state = await readWorking(api, api.conversationId, context);
      const ids = await recentUserEntryIds(api as unknown as Committer, api.conversationId, context);
      const text = ids.length === 0
        ? renderState(state)
        : `${renderState(state)}\nevidence: cite entry ids of user messages from this conversation; ${evidenceHint(ids)}`;
      return {
        output: [{ type: "text", text }],
        structuredOutput: structuredState(state),
      };
    },
  });

  const update = defineTool({
    name: "working_update",
    description:
      "Change the working state. Pass the revision you read and the entry ids that evidence a task or preference change, taken from the list working_read returns (numeric ids of user messages in this conversation; never guess an entry id). A task change needs at least one evidence entry; preferences need the entry where the user asked for them. A profile item needs its own evidence: one or more current daily-log segments (date, segment id, page), not those entry ids. A missing or superseded segment is rejected. The update is ignored when the revision is stale, and repeating the same call does not apply it twice.",
    parameters: WorkingUpdateArgsSchema,
    replay: "safe",
    execute: async (args, api, context) => {
      const now = Date.now();
      try {
        const receipt = await applyWorkingUpdate(api as unknown as Committer, {
          conversationId: api.conversationId,
          // One native call is one durable tool task, so its id is the idempotency key: stable across
          // retries and restarts, unique per call, and inside the identifier charset.
          operationId: `tool:${api.taskId}`,
          expectedRevision: args.expectedRevision,
          evidence: args.evidence,
          changes: args.changes,
          now,
          ...(options.resolveProfileEvidence === undefined
            ? {}
            : { resolveProfileEvidence: options.resolveProfileEvidence }),
        }, context);
        const state = await readWorking(api, api.conversationId, context);
        const heading = receipt.changed
          ? `working state updated to revision ${receipt.revision}`
          : `no change; working state stays at revision ${receipt.revision}`;
        return {
          output: [{ type: "text", text: `${heading}\n${renderState(state)}` }],
          structuredOutput: structuredState(state),
          details: { operationId: receipt.operationId, changed: receipt.changed },
        };
      } catch (error) {
        // Only a business rejection is correctable. A storage or Session failure is not the model's to
        // fix: rethrow it so the call fails visibly instead of looking like a rejected argument.
        if (!(error instanceof MemoryError)) throw error;
        let text = `${error.code}: ${error.message}`;
        if (error.code === "missing-evidence") {
          // The rejection alone leaves the model nothing to correct with: it cannot see entry
          // ids in its transcript. Name real citable ids so the retry can succeed (F-1).
          const ids = await recentUserEntryIds(api as unknown as Committer, api.conversationId, context);
          if (ids.length > 0) {
            text += `\nEvidence must cite entries committed in this conversation. ${evidenceHint(ids)}. Retry with one of these ids.`;
          }
        }
        return {
          isError: true,
          output: [{ type: "text", text }],
          diagnostics: [{ severity: "warn", code: error.code, message: error.message }],
        };
      }
    },
  });

  return [read, update];
}

/** The extension registered by the application composition root. Pass the daily-log resolver in production. */
export function createWorkingExtension(options: { readonly resolveProfileEvidence?: ProfileEvidenceResolver } = {}) {
  return defineExtension({ name: "working-memory", tools: workingTools(options) });
}

/** Tools with no daily-log resolver. Profile puts then fail `missing-evidence` until a resolver is supplied. */
export const workingExtension = createWorkingExtension();
