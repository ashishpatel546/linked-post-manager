export type ProviderId = "ollama" | "openai" | "claude-code";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  /** Whether the provider has everything it needs to be called. */
  configured: boolean;
  /** Why it is not configured, when it is not. */
  reason?: string;
  model: string;
  endpoint: string;
  /** True when the provider costs money per call. */
  metered: boolean;
  /** Populated only by an explicit reachability probe. */
  reachable?: boolean;
};

export interface DraftProvider {
  readonly id: ProviderId;
  readonly label: string;
  status(): ProviderStatus;
  /** Reachability check for the settings UI. Never throws. */
  probe(): Promise<ProviderStatus>;
  complete(messages: ChatMessage[]): Promise<string>;
}

export class ProviderError extends Error {
  provider: ProviderId;
  constructor(provider: ProviderId, message: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
  }
}
