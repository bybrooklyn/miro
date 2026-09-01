import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { AGENT_TOOLS } from "./tools";
import { resolveApiKey, runTurn } from "./index";

const WORKER_SYSTEM_PROMPT = `You are a narrow investigation worker spawned by Miro (plan §21).
You have one goal and a small set of tools. Investigate using only those tools, then report what
you found in a few sentences. You do not make changes and you do not talk to the user directly —
your only output is the evidence you return.`;

export interface WorkerToolCall {
  name: string;
  args: unknown;
}

export interface WorkerResult {
  goal: string;
  text: string;
  toolCalls: WorkerToolCall[];
}

/**
 * Spawns a narrow, time/tool-budgeted, read-only worker (plan §21).
 *
 * Workers get only the tools they're allowed, run for at most `maxTurns` assistant turns, and
 * return structured evidence rather than acting — the main agent stays the one that decides and
 * mutates. ponytail: no recursive worker swarms (plan explicitly rules this out for v1), and no
 * standing pool — one Agent per call, thrown away when done.
 *
 * `models` must be the caller's own registry, not a fresh builtinModels() — live-tested finding:
 * a freshly-built registry doesn't know about dynamically-registered providers (e.g. Ollama, only
 * added via registerOllamaIfReachable on the daemon's one shared registry), so `model.provider`
 * resolves to "Unknown provider" even though the exact same model works fine everywhere else.
 */
export async function spawnWorker(
  goal: string,
  allowedToolNames: string[],
  models: ReturnType<typeof builtinModels>,
  model: Model<any>,
  getStoredKey: (provider: string) => string | null,
  maxTurns = 4,
): Promise<WorkerResult> {
  const tools = AGENT_TOOLS.filter((t) => allowedToolNames.includes(t.name));
  const toolCalls: WorkerToolCall[] = [];
  let turns = 0;

  const agent = new Agent({
    initialState: { systemPrompt: WORKER_SYSTEM_PROMPT, model, tools: tools as AgentTool<any>[] },
    streamFn: (m, context, options) => models.streamSimple(m, context, options),
    getApiKey: async (provider) => resolveApiKey(provider, getStoredKey),
    shouldStopAfterTurn: () => ++turns >= maxTurns,
  });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") toolCalls.push({ name: event.toolName, args: event.args });
  });

  const text = await runTurn(agent, goal);
  return { goal, text, toolCalls };
}
