import type { Agent, AgentEvent } from "@miro/agent-core";
import type { AssistantMessage } from "@miro/model-client";

// Extracted from agent/index.ts as a leaf module (no dependency on anything that could import it
// back) - extensions/learn-agent.ts needs resolveApiKey/runTurn too, and agent/index.ts ->
// agent/learn-tools.ts -> extensions/learn.ts -> extensions/learn-agent.ts -> agent/index.ts would
// otherwise be a real circular import, same class of issue Stage C slice 1 avoided by having
// operations/engine.ts depend only on memory/store.ts, never agent/worker.ts. agent/index.ts
// re-exports these so no other existing import site needs to change.

// ponytail: a curated 4-provider list (matches plan §17's example), not the full 15+ pi-ai
// supports. Add more here if asked - the /provider flow and pickDefaultModel both read this list.
export const PROVIDER_CATALOG = [
  { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  { provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { provider: "google", label: "Google Gemini", envVar: "GEMINI_API_KEY" },
  { provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
] as const;

/** A key stored via /provider takes precedence over one already in the environment. */
export function resolveApiKey(provider: string, getStoredKey: (provider: string) => string | null): string | undefined {
  const stored = getStoredKey(provider);
  if (stored) return stored;
  const entry = PROVIDER_CATALOG.find((p) => p.provider === provider);
  return entry ? process.env[entry.envVar] : undefined;
}

/** Caps a worker/learning agent at `maxTurns` model calls. The vendored agent-core dropped
 * pi-agent-core's shouldStopAfterTurn option in favour of a pre-model-call gate; same budget - call
 * maxTurns+1 is refused and the loop ends cleanly (no open turn, nothing billed). */
export function limitTurns(agent: Agent, maxTurns: number): void {
  let calls = 0;
  agent.setBeforeModelCall(() => (++calls > maxTurns ? { stop: true, reason: `turn budget (${maxTurns}) spent` } : undefined));
}

// agent-core doesn't throw on a provider error (bad key, rate limit, ...) - it produces an
// assistant message with stopReason "error", empty content, and the detail in errorMessage.
// Surface that instead of silently returning empty text, which would read as Miro ignoring you.
function textOf(message: AssistantMessage | undefined): string {
  if (!message) return "";
  if (message.stopReason === "error") {
    return `That request failed: ${message.errorMessage ?? "unknown error"}`;
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface ActivityNode {
  id: string;
  parentId?: string;
  label: string;
  status: "running" | "done" | "failed";
  detail?: string;
}

export interface TurnHooks {
  /** A tool call started (status running) or finished (done/failed) - the client renders a tree. */
  onActivity?: (node: ActivityNode) => void;
  /** A fragment of the assistant's visible text, in order - for streaming replies. */
  onDelta?: (text: string) => void;
  /** Nests this turn's tool calls under a parent call (a learning agent under its app_learn). */
  parentActivityId?: string;
}

/** Describe a JSON result instead of quoting it. The protocol says an activity's `detail` is "short
 * outcome text - never a full payload", but truncating JSON to 120 characters is still a payload, just a
 * broken one: the web client showed `{ "interfaces": [ { "name": "lo0", "address"…` in the transcript.
 * A count or a field list says more in less space. */
function describeJson(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Prefer the fields that actually say what happened, when a tool provides them.
    for (const key of ["message", "note", "error", "outcome", "status", "summary"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v.trim().length > 120 ? `${v.trim().slice(0, 117)}…` : v.trim();
    }
    if (typeof o.ok === "boolean") return o.ok ? "ok" : "failed";
    const keys = Object.keys(o);
    if (keys.length === 0) return "nothing";
    const shown = keys.slice(0, 4).join(", ");
    return keys.length > 4 ? `${shown}, +${keys.length - 4} more` : shown;
  }
  return String(value);
}

function summarizeResult(result: unknown, isError: boolean): string | undefined {
  const text = typeof result === "string" ? result : (result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
  if (!text) return isError ? "failed" : undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return isError ? "failed" : undefined;
  if (/^[[{]/.test(line)) {
    try {
      return describeJson(JSON.parse(text));
    } catch {
      // not JSON after all - fall through and treat it as prose
    }
  }
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export { describeJson, summarizeResult };

/** Runs one full turn (including any tool round-trips) and returns the final assistant text. */
export async function runTurn(agent: Agent, text: string, hooks: TurnHooks | ((label: string) => void) = {}): Promise<string> {
  const h: TurnHooks = typeof hooks === "function" ? { onActivity: (n) => hooks(n.label) } : hooks;
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === "tool_execution_start" && h.onActivity) {
      // Looked up from the agent's own tool list (not a module-level constant) so this also finds
      // labels for tools that aren't in AGENT_TOOLS (operation/memory/extension/learn tools).
      const tool = (agent.state.tools as { name: string; label?: string }[]).find((t) => t.name === event.toolName);
      h.onActivity({ id: event.toolCallId, parentId: h.parentActivityId, label: tool?.label ?? event.toolName, status: "running" });
    } else if (event.type === "tool_execution_end" && h.onActivity) {
      const tool = (agent.state.tools as { name: string; label?: string }[]).find((t) => t.name === event.toolName);
      h.onActivity({
        id: event.toolCallId,
        parentId: h.parentActivityId,
        label: tool?.label ?? event.toolName,
        status: event.isError ? "failed" : "done",
        detail: summarizeResult(event.result, event.isError ?? false),
      });
    } else if (event.type === "message_update" && h.onDelta && event.assistantMessageEvent.type === "text_delta") {
      h.onDelta(event.assistantMessageEvent.delta);
    }
  });
  try {
    await agent.prompt(text);
    await agent.waitForIdle();
    const messages = agent.state.messages;
    const last = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
    return textOf(last);
  } finally {
    unsubscribe();
  }
}
