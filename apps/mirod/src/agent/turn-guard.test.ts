import { test, expect } from "bun:test";
import { Agent, type AgentTool } from "@miro/agent-core";
import { createMockModel, registerMockApi, type MockResponse } from "@miro/model-client";
import { getBundledModels } from "@miro/model-catalog";
import { Type } from "@miro/schema-engine/typebox";
import { AGENT_TOOLS } from "./tools";
import { runTurn } from "./model-utils";
import { createTurnGuard, limitsFor, modelTier } from "./turn-guard";

// A real Agent over a scripted model, with the real host_info tool and a real (test-local)
// operation-shaped tool. No mocking of the guard or the loop - the scripts are the only fixture.

registerMockApi();

const hostInfo: MockResponse = { content: [{ type: "toolCall", name: "host_info", arguments: {} }] };

function textOf(message: { content: unknown }): string {
  const content = message.content as { type: string; text?: string }[] | string;
  return typeof content === "string" ? content : content.map((b) => b.text ?? "").join("");
}

function agentWith(tools: AgentTool<any>[], responses: MockResponse[], limits = limitsFor("strong")) {
  const model = createMockModel({ responses });
  const guard = createTurnGuard(limits);
  const agent = new Agent({ initialState: { systemPrompt: ["test"], model, tools }, beforeToolCall: guard.beforeToolCall });
  guard.attach(agent);
  return { model, guard, agent };
}

test("modelTier: local/free is weak, billed is strong; weak gets tighter limits", () => {
  expect(modelTier({ provider: "ollama", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBe("weak");
  expect(modelTier({ provider: "openrouter", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBe("weak");
  expect(modelTier(getBundledModels("anthropic")[0]!)).toBe("strong");
  expect(limitsFor("weak").identicalCalls).toBeLessThan(limitsFor("strong").identicalCalls);
});

test("the third identical tool call in a turn is blocked with a reason; the model sees it as a tool error", async () => {
  const tools = AGENT_TOOLS.filter((t) => t.name === "host_info") as AgentTool<any>[];
  const { model, agent } = agentWith(tools, [hostInfo, hostInfo, hostInfo, { content: ["fine, giving up"] }]);
  const text = await runTurn(agent, "check the host forever");
  expect(text).toBe("fine, giving up");
  const results = agent.state.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult");
  expect(results.map((r) => r.isError)).toEqual([false, false, true]);
  expect(textOf(results[2]!)).toContain("already called host_info with these exact arguments 2 time(s)");
  expect(model.calls).toHaveLength(4);
});

test("the count is per turn: the same call is allowed again on the next prompt", async () => {
  const tools = AGENT_TOOLS.filter((t) => t.name === "host_info") as AgentTool<any>[];
  const { agent } = agentWith(tools, [hostInfo, hostInfo, hostInfo, { content: ["stop"] }, hostInfo, { content: ["again"] }]);
  await runTurn(agent, "first");
  await runTurn(agent, "second");
  const results = agent.state.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult");
  expect(results.map((r) => r.isError)).toEqual([false, false, true, false]);
});

function operationTool(name: string, outcome: "committed" | "rolledback"): AgentTool<any> {
  return {
    name,
    label: name,
    description: "an operation-shaped tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: outcome }], details: { outcome, message: `${outcome === "rolledback" ? "Verification failed" : "Done"} - ${name}` } }),
  };
}

test("a turn that attempted operations and committed none gets one follow-up demanding a different plan or an honest report", async () => {
  const flaky = operationTool("flaky_op", "rolledback");
  const { model, agent } = agentWith(
    [flaky],
    [{ content: [{ type: "toolCall", name: "flaky_op", arguments: {} }] }, { content: ["All done!"] }, { content: ["Understood - it did not work; the verify step failed."] }],
  );
  const text = await runTurn(agent, "do the thing");
  expect(text).toBe("Understood - it did not work; the verify step failed.");
  expect(model.calls).toHaveLength(3);
  // The third model call saw the gate's follow-up as the latest user message, with the trajectory.
  const lastUser = [...model.calls[2]!.context.messages].reverse().find((m) => m.role === "user")!;
  expect(textOf(lastUser)).toContain("1 operation(s) were attempted this turn and none committed");
  expect(textOf(lastUser)).toContain("flaky_op: Verification failed - flaky_op");
  expect(textOf(lastUser)).toContain("Do not tell the user the task is done");
});

test("a committed operation, or a turn with no operations, never triggers the gate", async () => {
  const good = operationTool("good_op", "committed");
  const { model, agent } = agentWith([good], [{ content: [{ type: "toolCall", name: "good_op", arguments: {} }] }, { content: ["Done."] }, { content: ["Just an answer."] }]);
  expect(await runTurn(agent, "do it")).toBe("Done.");
  expect(model.calls).toHaveLength(2);
  expect(await runTurn(agent, "what is 2+2")).toBe("Just an answer.");
  expect(model.calls).toHaveLength(3);
});

test("the retry ledger is reset with the turn", () => {
  const guard = createTurnGuard(limitsFor("weak"));
  guard.retries.record("shell.command", { command: "a" }, "a failed");
  expect(guard.retries.check("shell.command", { command: "a" })).not.toBeNull();
  const agent = new Agent({ initialState: { systemPrompt: ["t"], model: createMockModel({ responses: [{ content: ["x"] }] }), tools: [] } });
  guard.attach(agent);
  agent.emitExternalEvent({ type: "agent_start" });
  expect(guard.retries.check("shell.command", { command: "a" })).toBeNull();
});
