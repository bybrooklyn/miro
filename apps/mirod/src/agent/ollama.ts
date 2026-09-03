import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { builtinModels } from "@earendil-works/pi-ai/providers/all";

// Ollama (plan §17's provider list) needs no API key at all - it's a local server, so
// "connected" means "reachable", not "has a stored/env credential" like the other four.
export const OLLAMA_PROVIDER = "ollama";
const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export async function isOllamaReachable(baseUrl: string = OLLAMA_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function ollamaModel(id: string, name: string, contextWindow: number, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name,
    api: "openai-completions",
    provider: OLLAMA_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8192,
    // Ollama's OpenAI-compat layer doesn't understand the `developer` role (pi-ai README, "OpenAI
    // Compatibility Settings" - this "commonly applies to Ollama, vLLM, SGLang").
    compat: { supportsDeveloperRole: false },
  };
}

/** Registers Ollama's models onto an existing Models registry if the local server is reachable. */
export async function registerOllamaIfReachable(
  models: ReturnType<typeof builtinModels>,
  baseUrl: string = OLLAMA_BASE_URL,
): Promise<boolean> {
  if (!(await isOllamaReachable(baseUrl))) return false;
  models.setProvider(
    createProvider({
      id: OLLAMA_PROVIDER,
      name: "Ollama",
      baseUrl,
      // openai-completions.ts's getClientApiKey() throws unless apiKey is non-empty (or an
      // authorization header is set) - Ollama's server ignores the token's value entirely, so
      // any non-empty placeholder satisfies that check without representing a real credential.
      auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: { apiKey: "ollama-local" } }) } },
      // ponytail: hardcoded, not discovered from Ollama's own /api/tags - good enough while this
      // project only ever runs against one dev machine's known set. Add a genuinely local (not
      // ollama.com-proxied) model here whenever the cloud models' shared usage quota blocks live
      // testing, matching qwen2.5:7b's addition (needed live for Stage C slice 2's self-extension
      // verification, since the 3 cloud models all share one quota that exhausts fast under real use).
      models: [
        ollamaModel("gemma4:31b-cloud", "Gemma 4 31B (Ollama Cloud)", 262144, baseUrl),
        ollamaModel("deepseek-v4-flash:cloud", "DeepSeek V4 Flash (Ollama Cloud)", 1048576, baseUrl),
        ollamaModel("glm-5.2:cloud", "GLM 5.2 (Ollama Cloud)", 1000000, baseUrl),
        ollamaModel("qwen2.5:7b", "Qwen 2.5 7B (local)", 32768, baseUrl),
      ],
      api: openAICompletionsApi(),
    }),
  );
  return true;
}
