import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { AGENT_TOOLS } from "./tools";
import { OLLAMA_PROVIDER } from "./ollama";
import { buildOperationTools } from "./operation-tools";
import { buildReadTools } from "./read-tools";
import { buildInteractionTools } from "./interaction-tools";
import { buildMemoryTools } from "./memory-tools";
import { buildExtensionTools, buildToolsForExtension } from "./extension-tools";
import { buildLearnTools, type LearnToolContext } from "./learn-tools";
import type { OperationToolContext } from "../operations/engine";
import { getByKey, buildSummary } from "../memory/store";
import { getExtension } from "../extensions/store";
import { PROVIDER_CATALOG, resolveApiKey, runTurn } from "./model-utils";

// Re-exported so no existing import site (apps/mirod/src/index.ts, agent/worker.ts) needs to
// change — see model-utils.ts's own comment for why these moved out of this file.
export { PROVIDER_CATALOG, resolveApiKey, runTurn };

const BASE_SYSTEM_PROMPT = `You are Miro, an AI server-management partner living on one self-hosted Linux server. You are
talking to its owner, an experienced self-hoster. Be concise and transparent about what you check.

You are given OUTCOMES, not instructions. For anything beyond a quick question, work the loop:
1. INSPECT FIRST. Use your tools to see what is actually here — containers, services, storage,
   network, existing configuration — before saying or asking anything. Facts from the machine beat
   assumptions and beat documentation.
2. INFER. Decide everything you can from what exists: paths, ports, networks, which components fit.
   Existing, working software wins — reuse and adapt it rather than replacing it with a favourite.
3. ASK ONLY FOR INTENT, in one batch (ask_user): genuine preferences (movies or TV? torrent or
   Usenet?), credentials that live outside this machine, tradeoffs that matter to them, irreversible
   choices. Never ask about ports, networks, subnets, paths you can inspect, or which tool to use —
   those are your job. If the machine already answers a question, do not ask it.
4. ARCHITECT. Before the first write of any setup, install, or configure request — even for a
   single app — show a system_plan: findings, components (reuse vs install), steps, how you will
   verify. Wait for the one approval, then proceed without re-asking for routine steps.
5. EXECUTE. Read with shell_inspect/read_file/http_get and the ext_* tools; change things only
   through operations (shell_command, file_write, file_delete, http_mutation, ext_* operations),
   which are shown to the user, sandboxed to the scope you declare, verified, and rolled back on
   failure. rm and friends are refused by design: deletion is file_delete (trash).
6. ACQUIRE CAPABILITY WHEN YOU HIT SOMETHING UNKNOWN. If a request involves an app you have no
   ext_* tools for, call app_learn for it — it inspects, researches, generates and validates tools,
   and they become available to you in this same task. Then continue the original request with
   them. Learning can recurse into dependencies on its own.
7. VERIFY THE ARCHITECTURE, not liveness. "The container started" is not done. Check the data
   path end to end; for anything network-shaped (VPN, proxies, isolated services) check routes,
   DNS, exit IP, and what happens when the tunnel is down.
8. RETAIN. Record what you built and learned (memory_remember, category "capability") so the next
   request is a single tool call, not another investigation.

Back every conclusion with evidence from your tools. When an app needs a new password or token,
call credential_create — never ask the user to invent one, and never repeat a value you were
shown. When a tool refuses something, do what its alternative says.`;

// Personality changes wording only (plan §4) — never autonomy, permissions, or accuracy, so this
// only ever touches the prompt's tone line, nothing else about how the agent is built.
const PERSONALITY_TONE = {
  casual: "Talk casually: short, relaxed, direct, with context-aware humor when it fits.",
  professional: "Talk professionally: short, direct, neutral.",
} as const;

/** `learnedStyle` adapts the existing personality's delivery (plan §37) — one system, not a
 * separate layer. `memorySummary` is the MemGPT-style always-on core-memory block (plan §37). */
export function systemPrompt(
  personality: keyof typeof PERSONALITY_TONE,
  learnedStyle: string | null = null,
  memorySummary = "",
): string {
  const tone = learnedStyle ? `${PERSONALITY_TONE[personality]} Also: ${learnedStyle}` : PERSONALITY_TONE[personality];
  return `${BASE_SYSTEM_PROMPT}\n${tone}${memorySummary ? `\n\n${memorySummary}` : ""}`;
}

// Matches plan §17's routing selector exactly.
export const ROUTING_POLICIES = ["cheapest", "balanced", "best"] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

function totalCost(model: Model<any>): number {
  if (!model.cost) return 0;
  return model.cost.input + model.cost.output;
}

/**
 * Real cost-based routing (plan §17) over every tool-capable model on every *connected* provider
 * (a key in the secret store or the environment) — not a hardcoded per-provider pick. "cheapest"
 * and "best" are the true min/max by combined input+output cost; "balanced" is the sorted midpoint.
 * ponytail: cost as the only signal, no quality/latency data — good enough until routing decisions
 * actually need more than "cheap" vs "expensive" to be useful.
 */
export function pickDefaultModel(
  models: ReturnType<typeof builtinModels>,
  getStoredKey: (provider: string) => string | null,
  policy: RoutingPolicy = "cheapest",
): Model<any> | null {
  const candidates: Model<any>[] = [];
  for (const { provider } of PROVIDER_CATALOG) {
    if (!resolveApiKey(provider, getStoredKey)) continue;
    for (const model of models.getModels(provider) ?? []) {
      // Excludes sentinel/dynamic entries like openrouter's "auto" (negative placeholder cost).
      if (model.cost && totalCost(model) >= 0) candidates.push(model);
    }
  }
  // Ollama needs no key — being registered on `models` at all (done once at startup, only if the
  // local server was reachable) already means "connected", no separate credential check needed.
  candidates.push(...(models.getModels(OLLAMA_PROVIDER) ?? []));
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => totalCost(a) - totalCost(b));
  if (policy === "cheapest") return sorted[0];
  if (policy === "best") return sorted[sorted.length - 1];
  return sorted[Math.floor(sorted.length / 2)];
}

export function createMiroAgent(
  models: ReturnType<typeof builtinModels>,
  model: Model<any>,
  getStoredKey: (provider: string) => string | null,
  personality: keyof typeof PERSONALITY_TONE = "casual",
  operationCtx?: OperationToolContext,
  learnCtx?: Omit<LearnToolContext, "db" | "send" | "models" | "getStoredKey" | "onPromoted">,
  /** Reasoning effort for models that support it — e.g. Codex logins always run at "medium". */
  reasoning?: ThinkingLevel,
): Agent {
  const getSecret = learnCtx?.getSecret ?? operationCtx?.getSecret;
  // Hot-load (PLAN.md §5.4 D): after app_learn promotes an extension, swap its tools into THIS
  // running agent so the same task continues with them — pi-agent-core's state.tools is a setter
  // and a tool result's addedToolNames marks them usable from that transcript point on.
  let agent: Agent | null = null;
  const onPromoted = (app: string): string[] => {
    if (!agent || !operationCtx || !learnCtx) return [];
    const row = getExtension(operationCtx.db, app);
    if (!row || row.state !== "enabled") return [];
    const fresh = buildToolsForExtension(row, operationCtx.db, learnCtx.hostMgr, learnCtx.getSecret, learnCtx.repair, operationCtx);
    const names = new Set(fresh.map((t) => t.name));
    agent.state.tools = [...agent.state.tools.filter((t) => !names.has(t.name)), ...(fresh as AgentTool<any>[])];
    return [...names];
  };
  const tools = [
    ...AGENT_TOOLS,
    ...(getSecret ? buildReadTools({ getSecret }) : []),
    ...(operationCtx && learnCtx
      ? buildInteractionTools({ send: operationCtx.send, waitForAnswer: operationCtx.waitForAnswer, setSecret: learnCtx.setSecret })
      : []),
    ...(operationCtx ? buildOperationTools(operationCtx) : []),
    ...(operationCtx ? buildMemoryTools(operationCtx.db) : []),
    ...(operationCtx && learnCtx ? buildExtensionTools(operationCtx.db, learnCtx.hostMgr, learnCtx.getSecret, learnCtx.repair, operationCtx) : []),
    ...(operationCtx && learnCtx
      ? buildLearnTools({
          db: operationCtx.db,
          send: operationCtx.send,
          models,
          getStoredKey,
          hostMgr: learnCtx.hostMgr,
          setSecret: learnCtx.setSecret,
          getSecret: learnCtx.getSecret,
          resolveCodegenModel: learnCtx.resolveCodegenModel,
          waitForAnswer: learnCtx.waitForAnswer,
          operationCtx: learnCtx.operationCtx,
          repair: learnCtx.repair,
          onPromoted,
        })
      : []),
  ];
  const learnedStyle = operationCtx ? (getByKey(operationCtx.db, "preference", "reply_style")?.value ?? null) : null;
  const memorySummary = operationCtx ? buildSummary(operationCtx.db) : "";
  agent = new Agent({
    // Heterogeneous per-tool parameter schemas can't unify into one array type without erasure —
    // this is how pi-agent-core's own AgentState.tools is typed.
    initialState: { systemPrompt: systemPrompt(personality, learnedStyle, memorySummary), model, tools: tools as AgentTool<any>[] },
    streamFn: (m, context, options) => models.streamSimple(m, context, reasoning ? { ...options, reasoning } : options),
    // Re-resolved on every request (not just once at Agent construction), so a key added via
    // /provider after the daemon started takes effect on the very next turn.
    getApiKey: async (provider) => resolveApiKey(provider, getStoredKey),
  });
  return agent;
}
