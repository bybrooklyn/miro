import { test, expect } from "bun:test";
import { createModelRegistry } from "./models";
import { isLlm7Reachable, registerLlm7IfReachable, LLM7_PROVIDER } from "./llm7";
import { pickDefaultModel } from "./index";

test("isLlm7Reachable is false for a port nothing is listening on (no real service touched)", async () => {
  expect(await isLlm7Reachable("http://127.0.0.1:1")).toBe(false);
});

test("registerLlm7IfReachable is a no-op against an unreachable endpoint", async () => {
  const models = createModelRegistry(() => null);
  expect(await registerLlm7IfReachable(models, "http://127.0.0.1:1")).toBe(false);
  expect(models.getModels(LLM7_PROVIDER)).toEqual([]);
});

test("llm7 is NEVER a pickDefaultModel candidate - even as the only registered provider (the cost:0 trap)", () => {
  const catalog = createModelRegistry(() => null);
  const anthropic0 = catalog.getModels("anthropic")[0]!;
  const registry = createModelRegistry(() => null);
  // A cost:0 llm7 model - if it leaked into pickDefaultModel, `cheapest` would always pick it over
  // every paid provider (the §2378 trap the terminal-fallback design avoids).
  registry.addProvider(
    LLM7_PROVIDER,
    [{ ...anthropic0, id: "gpt-oss", provider: LLM7_PROVIDER, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    "unused",
  );
  // Nothing keyed connected -> null, despite llm7 being registered.
  expect(pickDefaultModel(registry, () => null, "cheapest")).toBeNull();
  // With a paid provider connected, `cheapest` still ignores the cost:0 llm7 model.
  const picked = pickDefaultModel(registry, (p) => (p === "anthropic" ? "fake-key" : null), "cheapest");
  expect(picked?.provider).toBe("anthropic");
});

test(
  "registerLlm7IfReachable registers free tool-capable models against the real llm7 endpoint",
  async () => {
    if (!(await isLlm7Reachable())) return; // network-guarded, like ollama's real-service test
    const models = createModelRegistry(() => null);
    expect(await registerLlm7IfReachable(models)).toBe(true);
    const registered = models.getModels(LLM7_PROVIDER);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered[0]!.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // The registry supplies llm7's keyless placeholder bearer, not a stored key.
    expect(await models.getApiKey(registered[0]!)).toBe("unused");
  },
  { timeout: 10000, retry: 2 },
);
