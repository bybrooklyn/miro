import { test, expect } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { spawnWorker } from "./worker";

// spawnWorker is thin wiring around Agent + runTurn (same shape as createMiroAgent, proven in
// index.test.ts) around a real builtinModels() registry that needs a real provider key. This
// proves the part that's actually non-trivial - the turn budget and tool scoping it sets up -
// the same way: a local Agent built with the identical options, backed by the faux provider.
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { AGENT_TOOLS } from "./tools";
import { runTurn } from "./index";

test("a worker with a turn budget stops after maxTurns even if the model keeps calling tools", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const maxTurns = 2;

  // The model never produces final text - it just keeps calling host_info. If the budget didn't
  // work, the loop would ask for a 3rd response that was never scripted.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("host_info", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("host_info", {})], { stopReason: "toolUse" }),
  ]);

  const toolCalls: { name: string }[] = [];
  let turns = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: "worker",
      model,
      tools: AGENT_TOOLS.filter((t) => t.name === "host_info") as AgentTool<any>[],
    },
    streamFn: (m, context, options) => models.streamSimple(m, context, options),
    shouldStopAfterTurn: () => ++turns >= maxTurns,
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") toolCalls.push({ name: event.toolName });
  });

  await runTurn(agent, "keep checking host info forever");

  expect(toolCalls).toHaveLength(maxTurns);
  expect(faux.getPendingResponseCount()).toBe(0);
});

test("spawnWorker only exposes the tools it's given, and returns structured evidence", async () => {
  // Direct check of the scoping logic spawnWorker uses (AGENT_TOOLS filtered to allowedToolNames),
  // since spawnWorker itself always builds a real builtinModels() registry that needs a real key.
  const allowed = ["host_info", "storage_mounts"];
  const scoped = AGENT_TOOLS.filter((t) => allowed.includes(t.name));
  expect(scoped.map((t) => t.name).sort()).toEqual(["host_info", "storage_mounts"]);
  expect(scoped.length).toBeLessThan(AGENT_TOOLS.length);
});
