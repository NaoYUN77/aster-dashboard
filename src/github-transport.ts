import { McpError, type McpFetch } from "@earendil-works/pi-mcp";
import { GITHUB_ENDPOINT } from "./github-policy.js";

const MAX_BYTES = 1024 * 1024;

/** One active business operation; the caller rejects concurrency before setting this context. */
export type GithubHttpScope = { signal: AbortSignal; received: number };

export function assertGithubProxy(env: NodeJS.ProcessEnv): void {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (env.NODE_USE_ENV_PROXY !== "1" || !proxy || !env.NODE_EXTRA_CA_CERTS || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw Object.assign(new Error("GitHub requires the configured proxy and trusted CA"), { code: "GITHUB_PROXY_REQUIRED" });
  }
  const bypass = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (bypass.some((entry) => entry === "*" || "api.githubcopilot.com" === entry.replace(/:\d+$/, "")
    || "api.githubcopilot.com".endsWith(`.${entry.replace(/^\./, "").replace(/:\d+$/, "")}`))) {
    throw Object.assign(new Error("GitHub must not bypass the configured proxy"), { code: "GITHUB_PROXY_BYPASS" });
  }
}

/** SDK 1.3.0 does not forward request cancellation to fetch; merge it at the host boundary. */
export function githubFetch(scope: () => GithubHttpScope | undefined, base: typeof fetch = fetch): McpFetch {
  return async (input, init) => {
    if (String(input) !== GITHUB_ENDPOINT) throw new McpError(-32600, "GitHub endpoint rejected");
    const active = scope();
    const signal = active ? AbortSignal.any([active.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal;
    const response = await base(input, { ...init, redirect: "error", signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let received = 0;
    const tooLarge = () => new McpError(-32603, "GitHub cumulative response exceeds 1 MiB");
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          received += chunk.value.byteLength;
          if (active) active.received += chunk.value.byteLength;
          if (received > MAX_BYTES || (active?.received ?? 0) > MAX_BYTES) {
            await reader.cancel().catch(() => {});
            controller.error(tooLarge());
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
