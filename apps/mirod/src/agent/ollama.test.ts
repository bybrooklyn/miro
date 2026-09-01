import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { isOllamaReachable, registerOllamaIfReachable, OLLAMA_PROVIDER } from "./ollama";

test("isOllamaReachable is false for a port nothing is listening on (no real service touched)", async () => {
  expect(await isOllamaReachable("http://127.0.0.1:1")).toBe(false);
});

test("registerOllamaIfReachable is a no-op against an unreachable server", async () => {
  const models = createModels();
  const registered = await registerOllamaIfReachable(models, "http://127.0.0.1:1");
  expect(registered).toBe(false);
  expect(models.getModels(OLLAMA_PROVIDER) ?? []).toEqual([]);
});

test(
  "isOllamaReachable / registerOllamaIfReachable work against the real local Ollama on this dev box",
  async () => {
    // This machine has Ollama actually running (confirmed manually) — proves the real fetch and
    // provider registration path, not just the unreachable branch.
    const reachable = await isOllamaReachable();
    if (!reachable) return; // don't fail elsewhere if Ollama isn't running on whatever box runs this
    const models = createModels();
    expect(await registerOllamaIfReachable(models)).toBe(true);
    const registered = models.getModels(OLLAMA_PROVIDER) ?? [];
    expect(registered.some((m) => m.id === "gemma4:31b-cloud")).toBe(true);
    expect(registered[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  },
  { timeout: 10000, retry: 2 },
);
