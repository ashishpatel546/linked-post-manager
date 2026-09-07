import { config } from "../config.ts";
import {
  ProviderError,
  type ChatMessage,
  type CompleteOptions,
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
      // Not enumerated from /models: that lists hundreds, most of them not
      // chat models. The configured one is offered; type any other into .env.
      models: [config.openaiModel],
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

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<string> {
    if (!config.openaiApiKey) {
      throw new ProviderError("openai", "OPENAI_API_KEY is not set in .env.");
    }

    const model = options.model || config.openaiModel;

    // Two layers, because either alone is wrong.
    //
    // The pattern skips the parameter for the families known to reject it, so
    // the common case costs no extra round trip. The retry below catches every
    // model the pattern has not heard of — including ones released after this
    // was written, and other vendors behind OPENAI_BASE_URL. Guessing from a
    // list that only ever goes stale is what turns "the model changed" into a
    // 400 the user has to decode.
    let response = await send(model, messages, !fixedTemperatureModel(model));

    if (response.status === 400) {
      const detail = await response.text();
      if (!rejectsTemperature(detail)) {
        throw new ProviderError("openai", `OpenAI returned 400: ${detail.slice(0, 300)}`);
      }
      // Said once, so a model quietly running at its default temperature is not
      // a silent difference in how drafts read.
      console.error(
        `[postwright] ${model} does not accept a custom temperature; retrying at the model default.`,
      );
      response = await send(model, messages, false);
    }

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

/**
 * Families that accept only their default temperature: the o-series reasoning
 * models, and GPT-5. Deliberately a prefix test — `gpt-5-nano`, `gpt-5-mini`
 * and whatever else ships under that name behave the same way.
 */
function fixedTemperatureModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model.trim());
}

/** OpenAI's own wording for it, matched loosely enough to survive rephrasing. */
function rejectsTemperature(body: string): boolean {
  return /temperature/i.test(body) && /unsupported|not supported|does not support/i.test(body);
}

function send(
  model: string,
  messages: ChatMessage[],
  withTemperature: boolean,
): Promise<Response> {
  return fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(withTemperature ? { temperature: 0.7 } : {}),
    }),
  });
}
