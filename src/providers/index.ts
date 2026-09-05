import { config } from "../config.ts";
import { claudeCodeProvider } from "./claudeCode.ts";
import { ollamaProvider } from "./ollama.ts";
import { openaiProvider } from "./openai.ts";
import type { DraftProvider, ProviderId, ProviderStatus } from "./types.ts";

export const PROVIDERS: Record<ProviderId, DraftProvider> = {
  ollama: ollamaProvider,
  openai: openaiProvider,
  "claude-code": claudeCodeProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

/**
 * Resolves the provider to use. An explicit id wins over DRAFT_PROVIDER, so the
 * extension can switch per request without rewriting .env.
 */
export function getProvider(id?: string): DraftProvider {
  const wanted = id ?? config.draftProvider;
  if (!isProviderId(wanted)) {
    throw new Error(
      `Unknown draft provider "${wanted}". Supported: ${PROVIDER_IDS.join(", ")}.`,
    );
  }
  return PROVIDERS[wanted];
}

/** Probes every provider in parallel. Used by the extension's settings panel. */
export async function listProviderStatuses(): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDER_IDS.map((id) => PROVIDERS[id].probe()));
}

export type { DraftProvider, ProviderId, ProviderStatus } from "./types.ts";
