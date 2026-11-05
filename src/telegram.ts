import { Agent as HttpsAgent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { Api, GrammyError } from "grammy";
import { AbortController as TelegramAbortController, type AbortSignal as TelegramSignal } from "abort-controller";
import type { Update } from "grammy/types";
import { hasProxyEnv, type readConfig } from "./config.js";
import type { Inbox } from "./inbox.js";
import type { TextRequest } from "./messages.js";

async function telegramCall<T>(signal: AbortSignal, call: (signal: TelegramSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new TelegramAbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await call(controller.signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class TelegramClient {
  private readonly api: Api;

  constructor(token: string, apiRoot?: string, env: NodeJS.ProcessEnv = process.env) {
    this.api = new Api(token, {
      ...(apiRoot ? { apiRoot } : {}),
      ...(hasProxyEnv(env) ? {
        // grammY constructs its own https.Agent without proxyEnv, so NODE_USE_ENV_PROXY=1 on the
        // global agent alone does not route Bot API calls through HTTPS_PROXY.
        baseFetchConfig: { agent: new HttpsAgent({ keepAlive: true, proxyEnv: env }) },
      } : {}),
    });
  }

  async identity(signal: AbortSignal): Promise<string> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const me = await telegramCall(bounded, (cancel) => this.api.getMe(cancel));
    const webhook = await telegramCall(bounded, (cancel) => this.api.getWebhookInfo(cancel));
    if (webhook.url) throw new Error("Telegram webhook is active; remove it before starting long polling");
    return String(me.id);
  }

  updates(offset: number, signal: AbortSignal): Promise<Update[]> {
    return telegramCall(AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      (cancel) => this.api.getUpdates({ offset, timeout: 25, limit: 10, allowed_updates: ["message"] }, cancel));
  }

  async send(chatId: string, text: string, signal: AbortSignal): Promise<string> {
    const message = await telegramCall(AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      (cancel) => this.api.sendMessage(chatId, text, {}, cancel));
    return String(message.message_id);
  }
}

function updateIdOf(update: Update): number | undefined {
  const id = update.update_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function numericId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return String(Number(value));
  return undefined;
}

export function toRequest(update: Update, ownerId: string, botId: string): TextRequest | undefined {
  const updateId = updateIdOf(update);
  const message = update.message;
  if (updateId === undefined || !message || message.chat?.type !== "private"
    || typeof message.text !== "string" || !message.text) return;
  const conversationId = numericId(message.chat.id);
  const senderId = numericId(message.from?.id);
  if (!conversationId || !senderId || senderId !== ownerId) return;
  return {
    requestId: `telegram:${botId}:${updateId}`,
    conversationId,
    senderId,
    text: message.text,
  };
}

export function failureCode(error: unknown): string {
  if (error instanceof GrammyError) return `TELEGRAM_${error.error_code}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(error.code)) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "EXECUTION_ERROR";
}

function isFatal(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "AGENT_SESSION_FAILED";
}

export async function serveTelegram(
  config: ReturnType<typeof readConfig>,
  botId: string,
  inbox: Inbox,
  reply: (request: TextRequest, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  client: Pick<TelegramClient, "updates" | "send">,
): Promise<void> {
  if (inbox.blocked().length) console.error("Some replies need delivery reconciliation; run npm run deliveries -- list.");
  let pollFailures = 0;
  while (!signal.aborted) {
    const job = inbox.next();
    if (job) {
      if (job.status === "pending") {
        let text: string;
        let errorCode: string | undefined;
        try {
          text = job.text.length > 16_000
            ? "消息过长，请拆分后再发送。"
            : await reply(job, signal);
        } catch (error) {
          if (signal.aborted) return;
          // The Session will reject every later request; a failure notice would only hide that.
          if (isFatal(error)) throw error;
          errorCode = failureCode(error);
          console.error(`Agent request failed: ${job.requestId} (${errorCode})`);
          const partial = errorCode === "AGENT_TRUNCATED" && error instanceof Error && "partialReply" in error
            && typeof error.partialReply === "string" ? error.partialReply.trim() : "";
          text = partial
            ? `${partial}\n\n（回复因长度限制被截断，内容不完整。请拆分请求后重试。）`
            : errorCode === "AGENT_TIMEOUT"
              ? "本次处理超时，已请求停止执行。已执行的操作可能仍然生效，请先核对结果。"
              : errorCode === "AGENT_LOOP_DETECTED"
                ? "检测到重复调用循环，已停止本次处理。已执行的操作可能仍然生效，请调整请求后重试。"
                : "本次处理未能完成。已执行的操作可能仍然生效，请先核对结果。";
        }
        inbox.saveReply(job.requestId, text, errorCode);
      }
      if (signal.aborted) return;
      let part = inbox.nextPart(job.requestId);
      while (part && !signal.aborted) {
        inbox.beginPart(job.requestId, part.part);
        let messageId: string;
        try {
          messageId = await client.send(job.conversationId, part.text, signal);
        } catch (error) {
          // Explicit Telegram 4xx rejection means not sent. Transport failures remain ambiguous.
          const status = error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 ? "failed" : "uncertain";
          inbox.failPart(job.requestId, part.part, status, failureCode(error));
          console.error(`Telegram delivery ${status}: ${job.requestId}, part ${part.part}`);
          break;
        }
        // Local state is authoritative: a write failure must stop the process, not look like a send failure.
        inbox.confirmPart(job.requestId, part.part, messageId);
        part = inbox.nextPart(job.requestId);
      }
      inbox.prune();
      continue;
    }

    let updates: Update[];
    try {
      updates = await client.updates(inbox.offset, signal);
      pollFailures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof GrammyError && error.error_code < 500 && error.error_code !== 429) throw error;
      const seconds = error instanceof GrammyError && error.error_code === 429
        ? Math.min(60, Math.max(1, error.parameters.retry_after ?? 5))
        : Math.min(30, 2 ** Math.min(++pollFailures, 5));
      console.error(`Telegram polling retry in ${seconds}s (${failureCode(error)})`);
      await delay(seconds * 1000, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
      continue;
    }
    for (const update of updates) {
      const updateId = updateIdOf(update);
      if (updateId === undefined) {
        // Without a usable id there is no checkpoint value to advance; skip instead of persisting NaN.
        console.error("Skipping Telegram update without a valid update_id");
        continue;
      }
      inbox.accept(updateId + 1, toRequest(update, config.ownerId, botId));
    }
  }
}
