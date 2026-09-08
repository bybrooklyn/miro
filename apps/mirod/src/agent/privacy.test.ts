import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { buildModel } from "@miro/model-catalog/build";
import { createModelRegistry } from "./models";
import { pickDefaultModel } from "./index";
import { isLocalOllamaModel } from "./ollama";
import { ensureEgressTable, recordEgress, recentEgress, EGRESS_LOG_ALL_SETTING, egressHooks } from "./egress-store";

// Private-by-default (PLAN.md private-by-default pillar): local-only mode means NOTHING leaves the
// box, and the egress trail is readable so the owner can see what did.

test("isLocalOllamaModel separates on-box tags from ollama.com-proxied *-cloud ids", () => {
  expect(isLocalOllamaModel("qwen2.5:7b")).toBe(true);
  expect(isLocalOllamaModel("llama3.2:3b-instruct-q4_K_M")).toBe(true);
  expect(isLocalOllamaModel("gemma4:31b-cloud")).toBe(false);
  expect(isLocalOllamaModel("deepseek-v3.1:671b-cloud")).toBe(false);
  expect(isLocalOllamaModel("qwen3-coder:480b-cloud")).toBe(false);
});

function withOllama(ids: string[]) {
  const models = createModelRegistry(() => null);
  models.addProvider(
    "ollama",
    ids.map((id) =>
      buildModel({
        id,
        name: id,
        api: "openai-completions",
        provider: "ollama",
        baseUrl: "http://localhost:11434/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      }),
    ),
    "ollama-local",
  );
  return models;
}

test("local-only routing ignores every keyed cloud provider", () => {
  const models = withOllama(["qwen2.5:7b"]);
  const keyed = (p: string) => (p === "anthropic" || p === "openai" ? "fake-key" : null);
  // Open mode: keyed cloud providers ARE candidates ("best" proves it - a free local model can never
  // be the most expensive one). Local-only must drop them all.
  expect(pickDefaultModel(models, keyed, "best")!.provider).not.toBe("ollama");
  expect(pickDefaultModel(models, keyed, "best", { localOnly: true })!.provider).toBe("ollama");
  const local = pickDefaultModel(models, keyed, "cheapest", { localOnly: true })!;
  expect(local.provider).toBe("ollama");
  expect(local.id).toBe("qwen2.5:7b");
});

test("local-only refuses a *-cloud Ollama id rather than treating it as local", () => {
  const models = withOllama(["gemma4:31b-cloud", "deepseek-v3.1:671b-cloud"]);
  // Every registered model leaves the box -> honest null, never a silent cloud fallback.
  expect(pickDefaultModel(models, () => "fake-key", "cheapest", { localOnly: true })).toBeNull();
  // Same registry, open mode: the proxied models are fine candidates.
  expect(pickDefaultModel(models, () => null, "cheapest")).not.toBeNull();
});

test("recentEgress reads the trail back newest-first, without ever holding content", () => {
  const db = new Database(":memory:");
  ensureEgressTable(db);
  expect(recentEgress(db)).toEqual([]);
  recordEgress(db, { provider: "anthropic", trust: "internal", contentTier: "internal", secretRedacted: true, infraRedacted: 2, redactedTypes: ["ip", "hostname"] });
  recordEgress(db, { provider: "llm7", trust: "public", contentTier: "public", secretRedacted: false, infraRedacted: 0, redactedTypes: [] });
  const rows = recentEgress(db);
  expect(rows.map((r) => r.provider)).toEqual(["llm7", "anthropic"]);
  expect(rows[1]).toMatchObject({ trust: "internal", contentTier: "internal", secretRedacted: true, infraRedacted: 2, redactedTypes: ["ip", "hostname"] });
  expect(rows[0]!.secretRedacted).toBe(false);
  expect(recentEgress(db, 1)).toHaveLength(1);
  // No column can carry the prompt itself.
  const cols = (db.query("PRAGMA table_info(egress_audit)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toEqual(["id", "at", "provider", "trust", "content_tier", "secret_redacted", "infra_redacted", "redacted_types"]);
});

test("egress.log_all records even a wholly public, nothing-redacted egress", () => {
  const publicContext = { messages: [{ role: "user" as const, content: "hello" }] };
  const model = { provider: "llm7", id: "x" } as never;
  const run = (logAll: boolean) => {
    const db = new Database(":memory:");
    ensureEgressTable(db);
    const hooks = egressHooks({ db, getSetting: (k) => (k === EGRESS_LOG_ALL_SETTING && logAll ? "true" : null) });
    hooks.transformProviderContext(publicContext as never, model);
    return recentEgress(db).length;
  };
  expect(run(false)).toBe(0);
  expect(run(true)).toBe(1);
});
