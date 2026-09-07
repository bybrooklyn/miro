import { buildModel } from "@miro/model-catalog/build";
import type { Model, ModelSpec } from "@miro/model-client";
import type { ModelRegistry } from "./models";

// llm7.io (PLAN.md §2377-2378): an anonymous, keyless, OpenAI-compatible endpoint - the $0 last-resort
// FLOOR so Miro's agent loop runs with zero setup when nothing else is connected. It sits behind Codex,
// a paid key, and Ollama, and is NEVER a pickDefaultModel candidate: a cost:0 model would beat every
// paid provider under the default `cheapest` policy (the §2378 "keyless last resort, not the default"
// rule). Only its free, tool-capable models are registered - the agent needs tool calling, and the
// anonymous tier is rate-limited (~10 RPM / 500k tok/day).
export const LLM7_PROVIDER = "llm7";
const LLM7_BASE_URL = "https://api.llm7.io/v1";

export async function isLlm7Reachable(baseUrl: string = LLM7_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function llm7Model(id: string, name: string, contextWindow: number, baseUrl: string): Model<"openai-completions"> {
  const spec: ModelSpec<"openai-completions"> = {
    id,
    name,
    api: "openai-completions",
    provider: LLM7_PROVIDER,
    baseUrl,
    // Conservative for a generic proxy: don't send reasoning params or the `developer` role that a
    // vanilla OpenAI-compat server may reject (same choice ollama.ts makes).
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
    compat: { supportsDeveloperRole: false },
  };
  return buildModel(spec);
}

/** Registers llm7's free, tool-capable models onto the shared registry if the endpoint is reachable.
 * Keyless - the bearer is a placeholder llm7 ignores for anonymous access (the ollama-local pattern).
 * The model ids are llm7's current free+tools set (verified against GET /v1/models). */
export async function registerLlm7IfReachable(models: ModelRegistry, baseUrl: string = LLM7_BASE_URL): Promise<boolean> {
  if (!(await isLlm7Reachable(baseUrl))) return false;
  models.addProvider(
    LLM7_PROVIDER,
    [
      llm7Model("gpt-oss", "GPT-OSS (llm7 free)", 131072, baseUrl),
      llm7Model("minimax-m2.7", "MiniMax M2.7 (llm7 free)", 180000, baseUrl),
    ],
    "unused",
  );
  return true;
}
