import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpAbortError } from "@earendil-works/pi-mcp";
import { Compile } from "typebox/compile";
import type { TSchema } from "@earendil-works/pi-ai";
import { buildGithubApproval, githubCanonical, githubEffectiveTool, githubRegisteredName, githubValidateArguments, verifyGithubApproval, type GithubPolicyConfig } from "./github-policy.js";
import type { McpConnection, McpToolInfo } from "./mcp.js";

function failure(code: string): Error { return Object.assign(new Error(`${code}: GitHub business call not sent; owner review required`), { code }); }

export async function readGithubJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 1024 * 1024) throw failure("GITHUB_BASELINE_LIMIT");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function persistGithubDisabled(policy: GithubPolicyConfig, dataDir: string, code: string): Promise<void> {
  const directory = join(dataDir, "github-policy");
  await mkdir(directory, { recursive: true });
  let fingerprint = "unapproved";
  try { fingerprint = createHash("sha256").update(githubCanonical(await readGithubJson(policy.baselinePath))).digest("hex"); } catch { /* No valid approval can enable tools. */ }
  await writeFile(join(directory, "disabled.json"), JSON.stringify({ fingerprint, code }), { mode: 0o600 });
}

/** Independent approval, never sourced from the observation catalog or auto-created from discovery. */
export async function openGithubGate(connection: McpConnection, policy: GithubPolicyConfig, tools: McpToolInfo[], dataDir: string) {
  const directory = join(dataDir, "github-policy");
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, "disabled.json");
  let baseline: unknown;
  try { baseline = await readGithubJson(policy.baselinePath); } catch { /* Missing or invalid approval stays disabled. */ }
  let candidate: object;
  try { candidate = buildGithubApproval(policy, tools as unknown as Record<string, unknown>[]); }
  catch {
    await writeFile(statePath, JSON.stringify({ fingerprint: baseline === undefined ? "unapproved" : createHash("sha256").update(githubCanonical(baseline)).digest("hex"), code: "GITHUB_DISCOVERY_REJECTED" }), { mode: 0o600 });
    throw failure("GITHUB_DISCOVERY_REJECTED");
  }
  const fingerprint = createHash("sha256").update(githubCanonical(candidate)).digest("hex");
  if (baseline === undefined) {
    await writeFile(join(directory, "candidate.json"), JSON.stringify(candidate, null, 2), { mode: 0o600 });
    throw failure("GITHUB_APPROVAL_REQUIRED");
  }
  try { verifyGithubApproval(policy, tools as unknown as Record<string, unknown>[], baseline); }
  catch {
    await writeFile(join(directory, "candidate.json"), JSON.stringify(candidate, null, 2), { mode: 0o600 });
    await writeFile(statePath, JSON.stringify({ fingerprint: createHash("sha256").update(githubCanonical(baseline)).digest("hex"), code: "GITHUB_DECLARATION_DRIFT" }), { mode: 0o600 });
    throw failure("GITHUB_DECLARATION_DRIFT");
  }
  try {
    const prior = await readGithubJson(statePath) as { fingerprint?: string };
    if (prior.fingerprint === fingerprint) throw failure("GITHUB_APPROVAL_DISABLED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const effective = tools.map((tool) => githubEffectiveTool(tool as unknown as Record<string, unknown>) as unknown as McpToolInfo);
  const checks = new Map(effective.map((tool) => [tool.name, Compile(tool.inputSchema as TSchema)]));
  let disabled = false;
  let busy = false;
  const listeners = new Set<() => void>();
  const disable = async (code: string) => {
    disabled = true;
    for (const listener of listeners) listener();
    await writeFile(statePath, JSON.stringify({ fingerprint, code }), { mode: 0o600 });
  };
  return {
    fingerprint, effective,
    subscribeDisabled(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async disable(code = "GITHUB_DECLARATION_CHANGED") { await disable(code); },
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 60_000) {
      if (disabled) throw failure("GITHUB_APPROVAL_DISABLED");
      if (busy) throw failure("GITHUB_BUSY");
      githubValidateArguments(name, args);
      if (!checks.get(name)?.Check(args) || githubRegisteredName(name) !== `mcp__github__${name}`) throw failure("GITHUB_ARGUMENTS_REJECTED");
      busy = true;
      const total = AbortSignal.timeout(Math.min(timeoutMs, 60_000));
      const operation = signal ? AbortSignal.any([signal, total]) : total;
      try {
        operation.throwIfAborted();
        try {
          const current = await connection.listTools({ signal: AbortSignal.any([operation, AbortSignal.timeout(10_000)]) });
          verifyGithubApproval(policy, current as unknown as Record<string, unknown>[], baseline);
        } catch {
          await disable("GITHUB_RECONCILIATION_FAILED");
          throw failure("GITHUB_RECONCILIATION_FAILED");
        }
        if (disabled) throw failure("GITHUB_APPROVAL_DISABLED");
        operation.throwIfAborted();
        try { return await connection.callTool(name, args, { signal: operation, timeoutMs: Math.min(timeoutMs, 60_000) }); }
        catch (error) {
          // Caller cancellation and the total deadline are not declaration signals; they must not
          // leave the capability disabled pending a new approval. Other failures may conceal a
          // change, so freeze until reviewed and retain the exception for the caller.
          if (error instanceof McpAbortError || signal?.aborted || total.aborted) throw error;
          await disable("GITHUB_CALL_FAILED");
          throw error;
        }
      } finally { busy = false; }
    },
  };
}
export type GithubGate = Awaited<ReturnType<typeof openGithubGate>>;
