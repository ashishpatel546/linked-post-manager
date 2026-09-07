import { config } from "../config.ts";
import {
  ProviderError,
  type ChatMessage,
  type CompleteOptions,
  type DraftProvider,
  type ProviderStatus,
} from "./types.ts";

/**
 * Local Ollama. Needs no key and costs nothing, so it is the default: choosing
 * it in the extension requires no configuration beyond having Ollama running.
 */
export const ollamaProvider: DraftProvider = {
  id: "ollama",
  label: "Ollama (local)",

  status(): ProviderStatus {
    return {
      id: "ollama",
      label: "Ollama (local)",
      configured: true,
      model: config.ollamaModel,
      endpoint: config.ollamaBaseUrl,
      metered: false,
    };
  },

  async probe(): Promise<ProviderStatus> {
    const base = this.status();
    try {
      const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return { ...base, reachable: false, reason: `Ollama replied ${response.status}` };

      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map((m) => m.name ?? "");
      const wanted = config.ollamaModel;
      const present = names.some((name) => name === wanted || name.startsWith(`${wanted}:`));

      // `/api/tags` lists only what is stored on this machine. A "-cloud" model
      // runs on Ollama's infrastructure and never appears there, so treating an
      // absence as "not pulled" reports a working model as unavailable and
      // greys it out in the UI. Trust the suffix and let `complete()` surface a
      // real failure if the model turns out not to exist after all.
      const isCloud = wanted.endsWith("-cloud") || wanted.endsWith(":cloud");

      // Everything installed, plus the configured cloud model if it is one —
      // it will not be in the tags list but is just as selectable.
      const models = [...new Set([...(isCloud ? [wanted] : []), ...names.filter(Boolean)])];

      return {
        ...base,
        reachable: true,
        models,
        ...(present || isCloud
          ? {}
          : {
              configured: false,
              reason: `Ollama is running but model "${wanted}" is not pulled. Run: ollama pull ${wanted}`,
            }),
      };
    } catch {
      return {
        ...base,
        reachable: false,
        configured: false,
        reason: `No Ollama at ${config.ollamaBaseUrl}. Start it with \`ollama serve\`, or change OLLAMA_BASE_URL.`,
      };
    }
  },

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.model || config.ollamaModel,
          messages,
          stream: false,
          options: { temperature: 0.7 },
        }),
      });
    } catch (cause) {
      throw new ProviderError(
        "ollama",
        `Could not reach Ollama at ${config.ollamaBaseUrl}. Is \`ollama serve\` running? (${String(cause)})`,
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        "ollama",
        `Ollama returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const text = body.message?.content?.trim();
    if (!text) throw new ProviderError("ollama", "Ollama returned an empty response.");
    return text;
  },
};
