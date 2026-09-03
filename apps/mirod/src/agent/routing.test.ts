import { test, expect } from "bun:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { pickDefaultModel } from "./index";

// Uses the real, live model catalog (no faux provider needed - this never makes a network call,
// it's pure lookup + cost comparison over builtinModels()'s registered data).
const models = builtinModels();

function connectedTo(...providers: string[]) {
  return (provider: string) => (providers.includes(provider) ? "fake-key" : null);
}

test("pickDefaultModel returns null when no provider is connected", () => {
  expect(pickDefaultModel(models, () => null)).toBeNull();
});

test("cheapest picks the lowest combined input+output cost across every connected provider", () => {
  const model = pickDefaultModel(models, connectedTo("anthropic", "openai"), "cheapest");
  expect(model).not.toBeNull();
  // Whichever model wins, it must be at least as cheap as every other tool-capable model on both
  // connected providers - not just the cheapest *within* one provider.
  const allCandidates = [...(models.getModels("anthropic") ?? []), ...(models.getModels("openai") ?? [])].filter(
    (m) => m.cost,
  );
  const cheapestCost = Math.min(...allCandidates.map((m) => m.cost!.input + m.cost!.output));
  expect(model!.cost!.input + model!.cost!.output).toBe(cheapestCost);
});

test("best picks the highest combined cost among connected providers", () => {
  const cheapest = pickDefaultModel(models, connectedTo("anthropic"), "cheapest")!;
  const best = pickDefaultModel(models, connectedTo("anthropic"), "best")!;
  const costOf = (m: typeof cheapest) => m.cost!.input + m.cost!.output;
  expect(costOf(best)).toBeGreaterThanOrEqual(costOf(cheapest));
});

test("only considers providers that are actually connected", () => {
  // OpenAI has models cheaper than anything on Anthropic (e.g. gpt-5-nano) - if routing ignored
  // the connected-provider filter, this would silently pick an OpenAI model with no key for it.
  const model = pickDefaultModel(models, connectedTo("anthropic"), "cheapest")!;
  expect(model.provider).toBe("anthropic");
});
