import { buildModel } from "@miro/model-catalog/build";
import type { Model, ModelSpec } from "@miro/model-client";
import type { ModelRegistry } from "./models";

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
  // buildModel materializes the catalog-derived fields (identity, resolved compat) a Model now
  // carries beyond what a hand-written spec states.
  const spec: ModelSpec<"openai-completions"> = {
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
    // Ollama's OpenAI-compat layer doesn't understand the `developer` role ("OpenAI Compatibility
    // Settings" - this "commonly applies to Ollama, vLLM, SGLang").
    compat: { supportsDeveloperRole: false },
  };
  return buildModel(spec);
}

/** True for a model that runs ON THIS BOX. Ollama also proxies ollama.com-hosted models, whose ids
 * carry a `cloud` suffix - those leave the machine, so the privacy posture must not treat them as
 * local (PLAN.md private-by-default). */
export function isLocalOllamaModel(id: string): boolean {
  return !/[:-]cloud\b/i.test(id);
}

/** The models Ollama actually has pulled, from its native /api/tags (the OpenAI-compat base URL ends
 * in /v1; tags lives beside it). Empty on any failure - the caller falls back to the known set. */
export async function listOllamaModels(baseUrl: string = OLLAMA_BASE_URL): Promise<string[]> {
  try {
    const root = baseUrl.replace(/\/v1\/?$/, "");
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

/** Registers Ollama's models onto the daemon's one shared registry if the local server is reachable.
 * Prefers what the server actually has pulled (/api/tags) so a genuinely-local setup is first-class;
 * falls back to the known set when discovery yields nothing.
 * ponytail: a discovered model's context window is not in /api/tags, so it gets a 32k default - raise
 * per-model via /api/show if a long-context local model ever needs its real window. */
export async function registerOllamaIfReachable(models: ModelRegistry, baseUrl: string = OLLAMA_BASE_URL): Promise<boolean> {
  if (!(await isOllamaReachable(baseUrl))) return false;
  const discovered = await listOllamaModels(baseUrl);
  if (discovered.length > 0) {
    models.addProvider(
      OLLAMA_PROVIDER,
      discovered.map((id) => ollamaModel(id, isLocalOllamaModel(id) ? `${id} (local)` : `${id} (Ollama Cloud)`, 32768, baseUrl)),
      "ollama-local",
    );
    return true;
  }
  models.addProvider(
    OLLAMA_PROVIDER,
    // ponytail: hardcoded, not discovered from Ollama's own /api/tags - good enough while this
    // project only ever runs against one dev machine's known set. Add a genuinely local (not
    // ollama.com-proxied) model here whenever the cloud models' shared usage quota blocks live
    // testing, matching qwen2.5:7b's addition (needed live for Stage C slice 2's self-extension
    // verification, since the 3 cloud models all share one quota that exhausts fast under real use).
    [
      ollamaModel("gemma4:31b-cloud", "Gemma 4 31B (Ollama Cloud)", 262144, baseUrl),
      ollamaModel("deepseek-v4-flash:cloud", "DeepSeek V4 Flash (Ollama Cloud)", 1048576, baseUrl),
      ollamaModel("glm-5.2:cloud", "GLM 5.2 (Ollama Cloud)", 1000000, baseUrl),
      ollamaModel("qwen2.5:7b", "Qwen 2.5 7B (local)", 32768, baseUrl),
    ],
    // The OpenAI-completions client sends whatever bearer it is given and Ollama's server ignores
    // the token's value entirely, so a non-empty placeholder stands in without representing a real
    // credential.
    "ollama-local",
  );
  return true;
}
