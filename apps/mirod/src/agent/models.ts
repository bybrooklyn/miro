import { getBundledModels, type GeneratedProvider } from "@miro/model-catalog";
import type { Model } from "@miro/model-client";
import { resolveApiKey } from "./model-utils";

// The one shared model registry (PLAN.md §5.17): the vendored catalog is a static per-provider
// lookup with no registry object and no runtime "add a provider" API, so this is the minimal
// Miro-owned replacement for what pi-ai's builtinModels() used to hand out - bundled models, plus a
// provider discovered at runtime (Ollama), plus the per-request credential lookup every Agent
// needs. One instance per daemon; workers and learning agents must be handed THIS one, not a fresh
// registry, or a runtime-added provider is unknown to them (found live in Stage C slice 1).

export interface ModelRegistry {
  getModels(provider: string): Model[];
  /** A provider discovered at runtime, with the fixed credential (if any) its requests carry. */
  addProvider(provider: string, models: Model[], apiKey?: string): void;
  /** Re-resolved on every request (not once at Agent construction), so a key added via /provider
   * after the daemon started takes effect on the very next turn. */
  getApiKey(model: Model): Promise<string | undefined>;
}

export function createModelRegistry(
  getStoredKey: (provider: string) => string | null,
  /** An OAuth access token for a logged-in provider (agent/codex-auth.ts); undefined otherwise. */
  oauthAccessToken: (provider: string) => Promise<string | undefined> = async () => undefined,
): ModelRegistry {
  const runtime = new Map<string, { models: Model[]; apiKey?: string }>();
  return {
    getModels: (provider) => runtime.get(provider)?.models ?? getBundledModels(provider as GeneratedProvider),
    addProvider: (provider, models, apiKey) => {
      runtime.set(provider, { models, apiKey });
    },
    getApiKey: async (model) => {
      const added = runtime.get(model.provider);
      if (added) return added.apiKey;
      return resolveApiKey(model.provider, getStoredKey) ?? (await oauthAccessToken(model.provider));
    },
  };
}
