import { test, expect } from "bun:test";
import { createMockModel, registerMockApi } from "@miro/model-client";
import { spawnWorker } from "./worker";
import { createModelRegistry } from "./models";
import { AGENT_TOOLS } from "./tools";

registerMockApi();

test("a worker with a turn budget stops after maxTurns even if the model keeps calling tools", async () => {
  const maxTurns = 2;
  // The model never produces final text - it just keeps calling host_info. If the budget didn't
  // work, the loop would ask for a 3rd response that was never scripted (and the mock would reject).
  const call = { content: [{ type: "toolCall" as const, name: "host_info", arguments: {} }] };
  const model = createMockModel({ responses: [call, call] });

  const result = await spawnWorker("keep checking host info forever", ["host_info"], createModelRegistry(() => null), model, maxTurns);

  expect(result.toolCalls.map((c) => c.name)).toEqual(["host_info", "host_info"]);
  // The budget refused the 3rd model call outright - it was never attempted, not attempted-and-failed.
  expect(model.calls).toHaveLength(maxTurns);
});

test("spawnWorker only exposes the tools it's given, and returns structured evidence", async () => {
  const model = createMockModel({
    responses: [
      { content: [{ type: "toolCall", name: "storage_mounts", arguments: {} }] },
      { content: ["Two mounts, both under 50% used."] },
    ],
  });
  const result = await spawnWorker("check the disks", ["host_info", "storage_mounts"], createModelRegistry(() => null), model);

  expect(result.goal).toBe("check the disks");
  expect(result.text).toBe("Two mounts, both under 50% used.");
  expect(result.toolCalls).toEqual([{ name: "storage_mounts", args: {} }]);
  // Only the allowed tools were advertised to the model - not the whole read-only set.
  const advertised = (model.calls[0]!.context.tools ?? []).map((t) => t.name).sort();
  expect(advertised).toEqual(["host_info", "storage_mounts"]);
  expect(advertised.length).toBeLessThan(AGENT_TOOLS.length);
});
