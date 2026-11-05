import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { ConfigurationError } from "./errors.js";

export interface ProviderEntry {
  readonly label: string;
  /** Environment variable holding the explicit API key. Only the name is stored here. */
  readonly apiKeyEnv: string;
  readonly create: () => Provider;
}

// Explicit API-key providers only. OAuth/subscription, ambient cloud credentials, and providers
// that need extra endpoint settings stay out of the registry: they cannot be configured with a
// single key from the environment file this application validates.
export const PROVIDERS = {
  anthropic: { label: "Anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", create: anthropicProvider },
  openai: { label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", create: openaiProvider },
  deepseek: { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", create: deepseekProvider },
  google: { label: "Google Gemini", apiKeyEnv: "GEMINI_API_KEY", create: googleProvider },
  xai: { label: "xAI", apiKeyEnv: "XAI_API_KEY", create: xaiProvider },
  mistral: { label: "Mistral", apiKeyEnv: "MISTRAL_API_KEY", create: mistralProvider },
  groq: { label: "Groq", apiKeyEnv: "GROQ_API_KEY", create: groqProvider },
  moonshotai: { label: "Moonshot AI", apiKeyEnv: "MOONSHOT_API_KEY", create: moonshotaiProvider },
  "moonshotai-cn": { label: "Moonshot AI CN", apiKeyEnv: "MOONSHOT_API_KEY", create: moonshotaiCnProvider },
  minimax: { label: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY", create: minimaxProvider },
  zai: { label: "Z.AI", apiKeyEnv: "ZAI_API_KEY", create: zaiProvider },
  openrouter: { label: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", create: openrouterProvider },
} as const satisfies Record<string, ProviderEntry>;

export type ProviderId = keyof typeof PROVIDERS;

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

export function createProviderModels(id: ProviderId): Models {
  const models = createModels();
  models.setProvider(PROVIDERS[id].create());
  return models;
}

/** Fail before any network call when MODEL_ID is not in the provider catalog shipped with pi-ai. */
export function requireModel(models: Models, provider: ProviderId, modelId: string): void {
  if (models.getModel(provider, modelId)) return;
  const examples = models.getModels(provider).slice(0, 5).map((model) => model.id);
  const hint = examples.length > 0 ? `; examples: ${examples.join(", ")}` : "";
  throw new ConfigurationError(`Unknown MODEL_ID "${modelId}" for MODEL_PROVIDER=${provider}${hint}`);
}
