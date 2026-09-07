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
  /**
   * Models this provider can be asked for, when it can enumerate them. The UI
   * offers these; `complete()` accepts any of them via `options.model`.
   */
  models?: string[];
};

export type CompleteOptions = {
  /** Overrides the provider's configured default for this one call. */
  model?: string;
};

export interface DraftProvider {
  readonly id: ProviderId;
  readonly label: string;
  status(): ProviderStatus;
  /** Reachability check for the settings UI. Never throws. */
  probe(): Promise<ProviderStatus>;
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>;
}

export class ProviderError extends Error {
  provider: ProviderId;
  constructor(provider: ProviderId, message: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
  }
}
