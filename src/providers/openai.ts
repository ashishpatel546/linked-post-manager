import { config } from "../config.ts";
import {
  ProviderError,
  type ChatMessage,
  type DraftProvider,
  type ProviderStatus,
} from "./types.ts";

/**
 * OpenAI, or anything that speaks its chat-completions shape — set
 * OPENAI_BASE_URL to point at a compatible endpoint (Groq, Together, LM Studio,
 * an internal gateway) and it works unchanged.
 */
export const openaiProvider: DraftProvider = {
  id: "openai",
  label: "OpenAI",

  status(): ProviderStatus {
    const hasKey = config.openaiApiKey.length > 0;
    return {
      id: "openai",
      label: "OpenAI",
      configured: hasKey,
      ...(hasKey ? {} : { reason: "OPENAI_API_KEY is not set in .env." }),
      model: config.openaiModel,
      endpoint: config.openaiBaseUrl,
      metered: true,
    };
  },

  async probe(): Promise<ProviderStatus> {
    const base = this.status();
    if (!base.configured) return { ...base, reachable: false };
    try {
      const response = await fetch(`${config.openaiBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok
        ? { ...base, reachable: true }
        : {
            ...base,
            reachable: false,
            configured: false,
            reason: `Key rejected (${response.status}).`,
          };
    } catch (cause) {
      return { ...base, reachable: false, reason: `Unreachable: ${String(cause)}` };
    }
  },

  async complete(messages: ChatMessage[]): Promise<string> {
    if (!config.openaiApiKey) {
      throw new ProviderError("openai", "OPENAI_API_KEY is not set in .env.");
    }

    const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        messages,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        "openai",
        `OpenAI returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new ProviderError("openai", "OpenAI returned an empty response.");
    return text;
  },
};
