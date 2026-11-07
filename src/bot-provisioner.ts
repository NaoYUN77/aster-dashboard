// BotProvisioner: the durable, idempotent path from "a bot row exists" to "this bot may chat".
//
// Interface: `provision()` claims one durable attempt, resolves the platform catalog, configures
// the bot's durable conversation, runs a real host health check, and only then records ready /
// degraded / failed. `retry()` re-runs the same target without creating a second workspace or
// transcript. `records()` is the console's read-only view of provisioning state.
//
// Errors: a failed configure, a failed health check, an exception, an interrupted claim or an
// unavailable base capability is persisted as `failed` with an operator-facing reason. Nothing in
// this module converts any of those into success. A `provisioning` row left by a crashed process
// is an UNKNOWN result, never a completed initialization.
//
// Security: every path, manifest and catalog switch is host-derived. No model or browser input
// reaches this module. Credentials must never appear in a reason or a log line; `sanitize()`
// redacts the shapes a host dependency could accidentally echo. The store is the single writer.

import { resolveCatalog } from "./capability-resolver.js";
import type { IntegrationRegistry } from "./integrations.js";
import type { CapabilityId, PlatformManifest } from "./platform-capabilities.js";
import type { CatalogProfile, ToolScope } from "./tool-catalog.js";

export type ProvisioningState = "provisioning" | "ready" | "degraded" | "failed";

export type ProvisioningRecord = {
  readonly botId: string;
  readonly state: ProvisioningState;
  /** Monotonic across restarts; a retry never erases the history of a failed attempt. */
  readonly attempt: number;
  /** The manifest this claim was settled against; a change forces re-provisioning. */
  readonly manifestFingerprint: string;
  readonly workspace: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Operator-facing failure reason. Null only for ready/degraded. Never carries a credential. */
  readonly error: string | null;
  /** Explicitly unavailable capabilities. Ready is never claimed while one of these is hidden. */
  readonly unavailable: readonly CapabilityId[];
};

export type ProvisioningSettlement = {
  readonly state: "ready" | "degraded" | "failed";
  readonly workspace: string;
  readonly finishedAt: string;
  readonly error: string | null;
  readonly unavailable: readonly CapabilityId[];
};

/**
 * Durable claim/finish boundary implemented by Inbox with `BEGIN IMMEDIATE`. `claim()` must
 * preserve an existing conversation/workspace identity; the provisioner always passes the same
 * deterministic path and the stored conversation id, so an attempt cannot allocate new resources.
 */
export interface ProvisioningStore {
  claim(botId: string, fingerprint: string, startedAt: string): ProvisioningRecord;
  finish(botId: string, result: ProvisioningSettlement): ProvisioningRecord;
  record(botId: string): ProvisioningRecord | undefined;
  records(): readonly ProvisioningRecord[];
}

export type HealthCheck = {
  readonly name: string;
  readonly ok: boolean;
  /** Operator-facing. Must never carry a credential, token or endpoint secret. */
  readonly reason: string;
};

export type HealthReport = {
  readonly ok: boolean;
  readonly checks: readonly HealthCheck[];
};

/** Host-derived facts about one bot. No field here comes from the model or the browser. */
export type ProvisionTarget = {
  readonly botId: string;
  readonly name: string;
  readonly systemPrompt: string;
  /** The stored durable conversation id, or undefined only for a brand-new bot. */
  readonly conversationId: string | undefined;
  /** Deterministic workspace path derived by the host from userId + botId. */
  readonly cwd: string;
  readonly channel: "console";
};

export type ConfigureResult = {
  readonly conversationId: string;
  readonly tools: readonly string[];
};

/** Host adapter over the real agent, filesystem and execution environment. */
export interface ProvisioningRuntime {
  configure(input: {
    readonly botId: string;
    readonly conversationId: string | undefined;
    readonly cwd: string;
    readonly channel: "console";
    readonly prompt: string;
    readonly catalogProfile: CatalogProfile;
    readonly toolScope: ToolScope;
    readonly capabilityReasons: ReadonlyMap<string, string>;
  }): Promise<ConfigureResult>;
  /**
   * Real checks, not a configuration echo: the workspace is present and writable, the durable
   * transcript is readable, and the core tools are available. A host that cannot verify one of
   * these must return ok:false with a reason instead of claiming success.
   */
  health(input: { readonly conversationId: string; readonly cwd: string }): Promise<HealthReport>;
}

/** Capabilities that must actually work before a bot may be called Ready. */
export const REQUIRED_CAPABILITIES: readonly CapabilityId[] = Object.freeze(["core", "workspace"]);

type Verdict = { readonly ok: boolean; readonly reason: string };
type Outcome = {
  readonly state: "ready" | "degraded" | "failed";
  readonly error: string | null;
  readonly unavailable: readonly CapabilityId[];
};

/** Only these states allow a chat request. A missing/failed/provisioning record never does. */
export function chatAllowed(state: ProvisioningState | undefined): boolean {
  return state === "ready" || state === "degraded";
}

function sanitize(value: unknown): string {
  const text = (value instanceof Error ? value.message : String(value))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|api|token)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]");
  return text.slice(0, 500);
}

export type BotProvisionerOptions = {
  readonly store: ProvisioningStore;
  readonly manifest: PlatformManifest;
  readonly integrations: IntegrationRegistry;
  readonly runtime: ProvisioningRuntime;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

export class BotProvisioner {
  readonly #options: BotProvisionerOptions;
  /** One in-flight attempt per bot in this process; the store handles cross-process claims. */
  readonly #inFlight = new Map<string, Promise<ProvisioningRecord>>();

  constructor(options: BotProvisionerOptions) {
    this.#options = options;
  }

  record(botId: string): ProvisioningRecord | undefined {
    return this.#options.store.record(botId);
  }

  state(botId: string): ProvisioningState | undefined {
    return this.#options.store.record(botId)?.state;
  }

  records(): readonly ProvisioningRecord[] {
    return this.#options.store.records();
  }

  /**
   * Idempotent. A Ready record on the same manifest returns early ONLY after a fresh health check;
   * a changed fingerprint, an interrupted claim or a failed health check re-runs against the same
   * workspace path and conversation id. Concurrent callers share the same attempt.
   */
  async provision(target: ProvisionTarget, options: { readonly force?: boolean } = {}): Promise<ProvisioningRecord> {
    const pending = this.#inFlight.get(target.botId);
    if (pending !== undefined) return pending;
    const run = this.#provision(target, options.force === true).finally(() => {
      this.#inFlight.delete(target.botId);
    });
    this.#inFlight.set(target.botId, run);
    return run;
  }

  /** Explicit operator retry after a failure; never allocates a second workspace or transcript. */
  async retry(target: ProvisionTarget): Promise<ProvisioningRecord> {
    return this.provision(target, { force: true });
  }

  async #provision(target: ProvisionTarget, force: boolean): Promise<ProvisioningRecord> {
    const { store, manifest } = this.#options;
    const stamp = (): string => (this.#options.now?.() ?? new Date()).toISOString();
    const existing = store.record(target.botId);

    // Restart recovery: a durable "ready" row is not proof that the runtime is still usable.
    if (!force && existing?.state === "ready" && existing.manifestFingerprint === manifest.fingerprint) {
      const verdict = await this.#verify(target);
      if (verdict.ok) return existing;
      return this.#settle(target, "failed", verdict.reason, [], stamp());
    }

    // An interrupted `provisioning` row is an unknown result. Claiming again records a new
    // attempt instead of assuming the previous process finished; identity is preserved by the store.
    const claim = store.claim(target.botId, manifest.fingerprint, stamp());
    this.#options.log?.(JSON.stringify({
      event: "provision_start", botId: target.botId, attempt: claim.attempt,
      fingerprint: manifest.fingerprint,
    }));

    let outcome: Outcome;
    try {
      const resolved = resolveCatalog({ manifest, integrations: this.#options.integrations });
      // Configure is host-only: the browser never supplies a profile, scope, cwd or credential.
      const configured = await this.#options.runtime.configure({
        botId: target.botId,
        conversationId: target.conversationId,
        cwd: target.cwd,
        channel: target.channel,
        prompt: target.systemPrompt,
        catalogProfile: resolved.profile,
        toolScope: resolved.scope,
        capabilityReasons: resolved.reasons,
      });
      const verdict = await this.#verify({ ...target, conversationId: configured.conversationId });
      const unavailable = resolved.unavailableCapabilities;
      const missing = unavailable.filter((id) => REQUIRED_CAPABILITIES.includes(id));
      if (!verdict.ok) {
        outcome = { state: "failed", error: verdict.reason, unavailable };
      } else if (missing.length > 0) {
        // A base capability that is actually unavailable can never produce a Ready bot.
        outcome = { state: "failed", error: `基础能力不可用：${missing.join(", ")}`, unavailable };
      } else {
        // Optional capabilities that are down are reported explicitly; the bot stays usable but
        // is degraded, never silently Ready.
        outcome = {
          state: unavailable.length === 0 ? "ready" : "degraded",
          error: null,
          unavailable,
        };
      }
    } catch (error) {
      outcome = { state: "failed", error: `运行时初始化失败：${sanitize(error)}`, unavailable: [] };
    }
    return this.#settle(target, outcome.state, outcome.error, outcome.unavailable, stamp());
  }

  /** Normalize a host report: an empty or inconsistent report is a failure, not a success. */
  async #verify(target: ProvisionTarget): Promise<Verdict> {
    let report: HealthReport;
    try {
      report = await this.#options.runtime.health({
        conversationId: target.conversationId ?? "",
        cwd: target.cwd,
      });
    } catch (error) {
      return { ok: false, reason: `健康检查异常：${sanitize(error)}` };
    }
    const failed = report.checks.filter((check) => !check.ok);
    if (report.checks.length === 0) {
      return { ok: false, reason: "健康检查未提供任何校验项；不能判定为 Ready。" };
    }
    if (!report.ok || failed.length > 0) {
      const detail = failed.length > 0
        ? failed.map((check) => `${check.name}: ${sanitize(check.reason)}`).join("; ")
        : "宿主健康检查返回未通过";
      return { ok: false, reason: `健康检查未通过：${detail}` };
    }
    return { ok: true, reason: "" };
  }

  #settle(
    target: ProvisionTarget,
    state: "ready" | "degraded" | "failed",
    error: string | null,
    unavailable: readonly CapabilityId[],
    finishedAt: string,
  ): ProvisioningRecord {
    const record = this.#options.store.finish(target.botId, {
      state,
      workspace: target.cwd,
      finishedAt,
      error: error === null ? null : sanitize(error),
      unavailable,
    });
    this.#options.log?.(JSON.stringify({
      event: state === "failed" ? "provision_failed" : "provision_done",
      botId: target.botId, attempt: record.attempt, state,
      unavailable, ...(record.error === null ? {} : { error: record.error }),
    }));
    return record;
  }
}
