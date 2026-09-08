import { Agent, type AgentTool } from "@miro/agent-core";
import { streamSimple, type Effort, type Model } from "@miro/model-client";
import type { ModelRegistry } from "./models";
import { AGENT_TOOLS, buildStatusTool, buildStackListTool } from "./tools";
import { OLLAMA_PROVIDER } from "./ollama";
import { buildOperationTools } from "./operation-tools";
import { buildReadTools } from "./read-tools";
import { buildInteractionTools } from "./interaction-tools";
import { buildCapabilitiesTool } from "./context";
import { buildMemoryTools } from "./memory-tools";
import { buildExtensionTools, buildToolsForExtension } from "./extension-tools";
import { buildLearnTools, type LearnToolContext } from "./learn-tools";
import type { OperationToolContext } from "../operations/engine";
import { getByKey, buildSummary } from "../memory/store";
import { getExtension } from "../extensions/store";
import { PROVIDER_CATALOG, resolveApiKey, runTurn } from "./model-utils";
import { createTurnGuard, limitsFor, modelTier } from "./turn-guard";
import { egressHooks } from "./egress-store";

// Re-exported so no existing import site (apps/mirod/src/index.ts, agent/worker.ts) needs to
// change - see model-utils.ts's own comment for why these moved out of this file.
export { PROVIDER_CATALOG, resolveApiKey, runTurn };

const BASE_SYSTEM_PROMPT = `You are Miro, an AI server-management partner living on one self-hosted Linux server. You are
talking to its owner, an experienced self-hoster. Be concise and transparent about what you check.

You are given OUTCOMES, not instructions. For anything beyond a quick question, work the loop:
1. INSPECT FIRST. Use your tools to see what is actually here - containers, services, storage,
   network, existing configuration - before saying or asking anything. Facts from the machine beat
   assumptions and beat documentation.
2. INFER. Decide everything you can from what exists: paths, ports, networks, which components fit.
   Existing, working software wins - reuse and adapt it rather than replacing it with a favourite.
3. ASK ONLY FOR INTENT, in one batch, through the ask_user tool - never as questions in your
   reply. Ending a turn with "tell me X" is a failure: call ask_user, get the answers, keep going.
   Genuine intent means preferences (movies or TV? torrent or Usenet?), credentials that live
   outside this machine, tradeoffs that matter to them, irreversible choices. Never ask about
   ports, networks, subnets, paths you can inspect, or which tool to use - those are your job. If
   the machine already answers a question, do not ask it. A request to set something up is not
   finished until it is set up and verified, or the user cancelled.
4. ARCHITECT. Before the first write of any setup, install, or configure request - even for a
   single app - show a system_plan: findings, components (reuse vs install), steps, how you will
   verify. Wait for the one approval, then proceed without re-asking for routine steps.
5. EXECUTE. Read with shell_inspect/read_file/http_get and the ext_* tools; change things only
   through operations (shell_command, file_edit for an existing file - anchored edits, never a
   retyped config - file_write to create one, file_delete, http_mutation, service_restart,
   service_control for start/stop/enable/disable/daemon-reload, ext_* operations),
   which are shown to the user, sandboxed to the scope you declare, verified, and rolled back on
   failure. rm and friends are refused by design: deletion is file_delete (trash). Before a
   container writes a host directory, check the directory's owner against the container's user
   (PUID/PGID) and fix ownership as an operation first - a root folder that is not writable by the
   app is rejected, not created. A container's real writes are its bind-mounted host paths and the
   docker socket - declare those, never /var/lib/docker.
6. ACQUIRE CAPABILITY WHEN YOU HIT SOMETHING UNKNOWN. To INSTALL/run an app, deploy it as a managed
   compose stack with deploy_stack (write the full compose, researching the app if needed) - Miro owns
   it, verifies it, and can later update/edit/remove it (stack_control, stack_list); never stand an app
   up with ad-hoc file_write + a raw docker compose up. THEN, if the request needs to control the app's own
   API and you have no ext_* tools for it, call app_learn - it inspects, researches, generates and
   validates tools, available in this same task. Learning can recurse into dependencies on its own.
7. VERIFY THE ARCHITECTURE, not liveness. "The container started" is not done. Check the data
   path end to end; for anything network-shaped (VPN, proxies, isolated services) check routes,
   DNS, exit IP, and what happens when the tunnel is down.
8. RETAIN. Record what you built and learned (memory_remember, category "capability") so the next
   request is a single tool call, not another investigation.

REACH THE OWNER PROACTIVELY when something happens outside a reply they are reading - a job you
finished, something you noticed, a problem you handled or could not. Use the notify tool and pick the
tier by how much it warrants their attention: needs_attention pushes to their phone; worth_knowing
shows in their terminal (now or on their next connect); routine is logged and invisible. You decide
what is worth it - quiet competence means most of what you do stays invisible, so do not narrate
routine work, but never sit on something that needs them. If no notification channel is configured
(your context says), offer to set one up with notify_configure.

PROPOSE THE BASELINE. When your context lists well-run-server baseline gaps (backup, notifications,
UPS monitoring), proactively OFFER to close them as ONE system_plan the owner can approve-all / pick /
skip - offer once, never nag or re-offer something declined. This is the magic: a sysadmin that shows
up, assesses the box, and proposes - not one that waits to be told every step.

Back every conclusion with evidence from your tools. When an app needs a new password or token,
call credential_create - never ask the user to invent one, and never repeat a value you were
shown. A credential the machine itself produced - a first-start password an app printed to its
log, a key in its config file, a session cookie a login returns - is never something to ask the
user for: capture it by reference with credential_capture (log or file, one regex group) or
http_mutation's storeResponseField (body field, header:<name>, cookie:<name>); read tools show
"[redacted]" in its place on purpose. For a secret only the OWNER holds (a VPN key, a paid API token,
a GitHub token), use request_secret (a masked prompt, stored by ref) - or paste_config for a whole
config blob - never a plain ask_user question and never ask them to paste it into ordinary chat. When
a tool refuses something, do what its alternative says.`;

// Personality changes wording only (plan §4) - never autonomy, permissions, or accuracy, so this
// only ever touches the prompt's tone line, nothing else about how the agent is built.
const PERSONALITY_TONE = {
  casual: "Talk casually: short, relaxed, direct, with context-aware humor when it fits.",
  professional: "Talk professionally: short, direct, neutral.",
} as const;

/** `learnedStyle` adapts the existing personality's delivery (plan §37) - one system, not a
 * separate layer. `memorySummary` is the MemGPT-style always-on core-memory block (plan §37). */
export function systemPrompt(
  personality: keyof typeof PERSONALITY_TONE,
  learnedStyle: string | null = null,
  memorySummary = "",
  contextBlock = "",
): string {
  const tone = learnedStyle ? `${PERSONALITY_TONE[personality]} Also: ${learnedStyle}` : PERSONALITY_TONE[personality];
  return `${BASE_SYSTEM_PROMPT}\n${tone}${contextBlock ? `\n\n${contextBlock}` : ""}${memorySummary ? `\n\n${memorySummary}` : ""}`;
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
 * (a key in the secret store or the environment) - not a hardcoded per-provider pick. "cheapest"
 * and "best" are the true min/max by combined input+output cost; "balanced" is the sorted midpoint.
 * ponytail: cost as the only signal, no quality/latency data - good enough until routing decisions
 * actually need more than "cheap" vs "expensive" to be useful.
 */
export function pickDefaultModel(
  models: ModelRegistry,
  getStoredKey: (provider: string) => string | null,
  policy: RoutingPolicy = "cheapest",
): Model<any> | null {
  const candidates: Model<any>[] = [];
  for (const { provider } of PROVIDER_CATALOG) {
    if (!resolveApiKey(provider, getStoredKey)) continue;
    for (const model of models.getModels(provider)) {
      // Excludes sentinel/dynamic entries like openrouter's "auto" (negative placeholder cost).
      if (model.cost && totalCost(model) >= 0) candidates.push(model);
    }
  }
  // Ollama needs no key - being registered on `models` at all (done once at startup, only if the
  // local server was reachable) already means "connected", no separate credential check needed.
  candidates.push(...models.getModels(OLLAMA_PROVIDER));
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => totalCost(a) - totalCost(b));
  if (policy === "cheapest") return sorted[0];
  if (policy === "best") return sorted[sorted.length - 1];
  return sorted[Math.floor(sorted.length / 2)];
}

export function createMiroAgent(
  models: ModelRegistry,
  model: Model<any>,
  getStoredKey: (provider: string) => string | null,
  personality: keyof typeof PERSONALITY_TONE = "casual",
  operationCtx?: OperationToolContext,
  learnCtx?: Omit<LearnToolContext, "db" | "send" | "models" | "getStoredKey" | "onPromoted">,
  /** Reasoning effort for models that support it - e.g. Codex logins always run at "medium". */
  reasoning?: Effort,
  /** The assembled per-turn context (agent/context.ts): server snapshot, operated systems, refusals. */
  contextBlock = "",
): Agent {
  const getSecret = learnCtx?.getSecret ?? operationCtx?.getSecret;
  // Hot-load (PLAN.md §5.4 D): after app_learn promotes an extension, swap its tools into THIS
  // running agent so the same task continues with them - agent-core re-reads state.tools before
  // every model call, so tools set mid-turn are callable from the very next call on.
  let agent: Agent | null = null;
  const onPromoted = (app: string): string[] => {
    if (!agent || !operationCtx || !learnCtx) return [];
    const row = getExtension(operationCtx.db, app);
    if (!row || row.state !== "enabled") return [];
    const fresh = buildToolsForExtension(row, operationCtx.db, learnCtx.hostMgr, learnCtx.getSecret, learnCtx.repair, operationCtx);
    const names = new Set(fresh.map((t) => t.name));
    agent.setTools([...agent.state.tools.filter((t) => !names.has(t.name)), ...(fresh as AgentTool<any>[])]);
    return [...names];
  };
  const tools = [
    ...AGENT_TOOLS,
    ...(getSecret ? buildReadTools({ getSecret }) : []),
    ...(operationCtx ? [buildCapabilitiesTool(operationCtx.db), buildStatusTool(operationCtx.db), buildStackListTool(operationCtx.db)] : []),
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
  // The loop's own stop hooks (agent/turn-guard.ts), sized by the model's tier: thrash blocking,
  // the done-without-commit gate, and the undo-then-retry ledger the engine consults. The ledger
  // rides on the operation context so extension operations and the learning agent's operations
  // (same context, same task) count toward the same turn.
  const guard = createTurnGuard(limitsFor(modelTier(model)));
  if (operationCtx) operationCtx.retries = guard.retries;
  const egress = egressHooks(operationCtx);
  agent = new Agent({
    // Heterogeneous per-tool parameter schemas can't unify into one array type without erasure -
    // this is how agent-core's own AgentState.tools is typed.
    initialState: { systemPrompt: [systemPrompt(personality, learnedStyle, memorySummary, contextBlock)], model, tools: tools as AgentTool<any>[] },
    streamFn: (m, context, options) => streamSimple(m, context, reasoning ? { ...options, reasoning } : options),
    getApiKey: (m) => models.getApiKey(m),
    beforeToolCall: guard.beforeToolCall,
    transformProviderContext: egress.transformProviderContext,
    transformAssistantMessage: egress.transformAssistantMessage,
  });
  guard.attach(agent);
  return agent;
}
