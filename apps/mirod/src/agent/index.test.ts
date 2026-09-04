import { test, expect } from "bun:test";
import { hostname } from "node:os";
import { createMockModel, registerMockApi } from "@miro/model-client";
import { Agent, type AgentTool } from "@miro/agent-core";
import { AGENT_TOOLS } from "./tools";
import { runTurn, systemPrompt } from "./index";

// The scripted "mock" API dispatches through the real streamSimple like every other provider.
registerMockApi();

// systemPrompt composes plan §37's two Memory-driven additions onto the base personality tone:
// learnedStyle (communication-style adaptation - one system, not a separate layer) and
// memorySummary (the MemGPT-style always-on core-memory block). Live-verified separately (real
// daemon, real model) that these actually get populated from real memory rows - this just proves
// the deterministic string composition, which nothing else covers directly.
test("systemPrompt with no learned style or summary is the base prompt plus the personality tone, nothing else", () => {
  const prompt = systemPrompt("casual");
  expect(prompt.startsWith("You are Miro, an AI server-management partner")).toBe(true);
  expect(prompt.endsWith("\nTalk casually: short, relaxed, direct, with context-aware humor when it fits.")).toBe(true);
  // The outcome loop's load-bearing disciplines are present (PLAN.md §5.4 A).
  for (const phrase of ["INSPECT FIRST", "ASK ONLY FOR INTENT", "system_plan", "app_learn", "VERIFY THE ARCHITECTURE", "RETAIN"]) {
    expect(prompt).toContain(phrase);
  }
  expect(prompt).not.toContain("What you've learned");
});

test("systemPrompt appends learnedStyle onto the personality tone line", () => {
  const prompt = systemPrompt("casual", "keep replies to one or two sentences");
  expect(prompt).toContain("Talk casually: short, relaxed, direct, with context-aware humor when it fits. Also: keep replies to one or two sentences");
});

test("systemPrompt appends the memory summary as its own trailing block", () => {
  const prompt = systemPrompt("professional", null, "What you've learned about this user and server so far:\n- runs Postgres on 5433 (confirmed)");
  expect(prompt.endsWith("\n\nWhat you've learned about this user and server so far:\n- runs Postgres on 5433 (confirmed)")).toBe(true);
});

// Proves the Agent + tool-calling mechanism end to end without needing a real provider API key:
// a scripted (mock) model calls the real `host_info` tool, which reads this machine's real state,
// then the model is scripted to summarize. No mocking of our own tool code.
test("runTurn executes a real tool call and returns the model's follow-up text", async () => {
  // responses is a FIFO queue: the first drives the initial request, the second drives the
  // automatic follow-up request the Agent loop makes after the tool result comes back.
  const model = createMockModel({
    responses: [
      { content: [{ type: "toolCall", name: "host_info", arguments: {} }] },
      { content: ["This server looks healthy."] },
    ],
  });

  const agent = new Agent({
    initialState: { systemPrompt: [systemPrompt("casual")], model, tools: AGENT_TOOLS as AgentTool<any>[] },
  });

  let activityLabel = "";
  const finalText = await runTurn(agent, "what's wrong with this server", (label) => {
    activityLabel = label;
  });

  expect(activityLabel).toBe("Host info");
  expect(finalText).toBe("This server looks healthy.");
  expect(model.calls).toHaveLength(2);

  const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
  expect(toolResult).toBeDefined();
  const resultText = (toolResult as any).content[0].text as string;
  // The tool actually ran against real system state - not a stub.
  expect(resultText).toContain(hostname());
});

// Regression test: agent-core doesn't throw on a provider error (e.g. a bad API key) - it
// produces an assistant message with stopReason "error" and empty content. A live smoke test with
// a fake Anthropic key first caught this returning "" and getting silently swapped for a canned
// personality reply, which would have misled the user into thinking Miro replied normally.
test("runTurn surfaces a provider error instead of returning empty text", async () => {
  const model = createMockModel({
    responses: [{ content: [], stopReason: "error", errorMessage: "401 API key is invalid." }],
  });

  const agent = new Agent({
    initialState: { systemPrompt: [systemPrompt("casual")], model, tools: AGENT_TOOLS as AgentTool<any>[] },
  });

  const finalText = await runTurn(agent, "hello");
  expect(finalText).toContain("401 API key is invalid.");
});
