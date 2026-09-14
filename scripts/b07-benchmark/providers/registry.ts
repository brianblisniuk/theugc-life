import type { ProviderId } from "../config/candidates";
import { anthropicAdapter } from "./anthropic";
import { googleAdapter } from "./google";
import { openaiAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
};

/** `local` (the deterministic baseline) has no adapter by design. */
export function adapterFor(providerId: ProviderId): ProviderAdapter | null {
  return ADAPTERS[providerId] ?? null;
}

export { openaiAdapter, anthropicAdapter, googleAdapter };
