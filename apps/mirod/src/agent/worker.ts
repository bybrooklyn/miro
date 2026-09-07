import { Agent, type AgentTool } from "@miro/agent-core";
import type { Model } from "@miro/model-client";
import { AGENT_TOOLS } from "./tools";
import { limitTurns, runTurn } from "./model-utils";
import { egressGate } from "./egress-store";
import type { ModelRegistry } from "./models";

const WORKER_SYSTEM_PROMPT = `You are a narrow investigation worker spawned by Miro (plan §21).
You have one goal and a small set of tools. Investigate using only those tools, then report what
you found in a few sentences. You do not make changes and you do not talk to the user directly -
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
 * Spawns a narrow, tool-budgeted, read-only worker (plan §21).
 *
 * Workers get only the tools they're allowed, run for at most `maxTurns` model calls, and
 * return structured evidence rather than acting - the main agent stays the one that decides and
 * mutates. The budget is in model calls, not wall-clock time: a hung provider stream hangs the
 * worker until the provider's own timeout (audit R4 - the old comment claimed a time budget; a
 * deadline via agent.abort() is the upgrade path if one is ever needed). ponytail: no recursive
 * worker swarms (plan explicitly rules this out for v1), and no standing pool - one Agent per
 * call, thrown away when done.
 *
 * `models` must be the daemon's one shared registry (agent/models.ts), never a fresh one - live-
 * tested finding: a provider registered at runtime (Ollama) is unknown to any other registry, so
 * the exact same model that works everywhere else has no credential and no provider here.
 */
export async function spawnWorker(
  goal: string,
  allowedToolNames: string[],
  models: ModelRegistry,
  model: Model<any>,
  maxTurns = 4,
): Promise<WorkerResult> {
  const tools = AGENT_TOOLS.filter((t) => allowedToolNames.includes(t.name));
  const toolCalls: WorkerToolCall[] = [];

  const agent = new Agent({
    initialState: { systemPrompt: [WORKER_SYSTEM_PROMPT], model, tools: tools as AgentTool<any>[] },
    getApiKey: (m) => models.getApiKey(m),
    // Investigation reads carry infra topology; scrub before egress. No db here, so default tiers,
    // no audit - a fail-safe scrub, not the configured/logged path the chat agent gets.
    transformProviderContext: egressGate(undefined),
  });
  limitTurns(agent, maxTurns);

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") toolCalls.push({ name: event.toolName, args: event.args });
  });

  const text = await runTurn(agent, goal);
  return { goal, text, toolCalls };
}
