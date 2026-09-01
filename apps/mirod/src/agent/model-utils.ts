import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Extracted from agent/index.ts as a leaf module (no dependency on anything that could import it
// back) — extensions/learn-agent.ts needs resolveApiKey/runTurn too, and agent/index.ts ->
// agent/learn-tools.ts -> extensions/learn.ts -> extensions/learn-agent.ts -> agent/index.ts would
// otherwise be a real circular import, same class of issue Stage C slice 1 avoided by having
// operations/engine.ts depend only on memory/store.ts, never agent/worker.ts. agent/index.ts
// re-exports these so no other existing import site needs to change.

// ponytail: a curated 4-provider list (matches plan §17's example), not the full 15+ pi-ai
// supports. Add more here if asked — the /provider flow and pickDefaultModel both read this list.
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

// pi-agent-core doesn't throw on a provider error (bad key, rate limit, ...) — it produces an
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

/** Runs one full turn (including any tool round-trips) and returns the final assistant text. */
export async function runTurn(agent: Agent, text: string, onActivity?: (label: string) => void): Promise<string> {
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === "tool_execution_start" && onActivity) {
      // Looked up from the agent's own tool list (not a module-level constant) so this also finds
      // labels for tools that aren't in AGENT_TOOLS (operation/memory/extension/learn tools).
      const tool = (agent.state.tools as { name: string; label?: string }[]).find((t) => t.name === event.toolName);
      onActivity(tool?.label ?? event.toolName);
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
