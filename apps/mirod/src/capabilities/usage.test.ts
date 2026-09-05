import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createUsageStore, FAILURE_COOLDOWN_AFTER, FAILURE_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MS } from "./usage";

const T0 = 1_800_000_000_000;

test("an untried provider has an even prior; successes and failures move its score", () => {
  const usage = createUsageStore(new Database(":memory:"));
  expect(usage.score("a", T0)).toBe(0.5);
  usage.record("a", { ok: true, ms: 100 }, T0);
  usage.record("a", { ok: true, ms: 100 }, T0);
  usage.record("b", { ok: true, ms: 100 }, T0);
  usage.record("b", { ok: false, ms: 100 }, T0);
  expect(usage.score("a", T0)).toBeGreaterThan(usage.score("b", T0));
  // Slower wins less: same success rate, 4x the latency.
  usage.record("c", { ok: true, ms: 4000 }, T0);
  expect(usage.score("c", T0)).toBeLessThan(usage.score("a", T0));
  expect(usage.get("a")).toMatchObject({ requests: 2, failures: 0, consecutiveFailures: 0, remaining: { value: null, confidence: "unknown" } });
});

test("a 429 cools the provider until the reset it announced, else the default; an ok clears it", () => {
  const usage = createUsageStore(new Database(":memory:"));
  usage.record("x", { ok: false, ms: 50, status: 429, resetAt: T0 + 60_000 }, T0);
  expect(usage.inCooldown("x", T0 + 30_000)).toBe(true);
  expect(usage.inCooldown("x", T0 + 61_000)).toBe(false);
  expect(usage.get("x")!.last429At).toBe(T0);
  usage.record("y", { ok: false, ms: 50, status: 429 }, T0);
  expect(usage.get("y")!.cooldownUntil).toBe(T0 + RATE_LIMIT_COOLDOWN_MS);
  usage.record("y", { ok: true, ms: 50 }, T0 + 1000);
  expect(usage.inCooldown("y", T0 + 1000)).toBe(false);
});

test("repeated failures cool a provider briefly; one below the threshold does not", () => {
  const usage = createUsageStore(new Database(":memory:"));
  for (let i = 1; i < FAILURE_COOLDOWN_AFTER; i++) usage.record("z", { ok: false, ms: 10 }, T0);
  expect(usage.inCooldown("z", T0)).toBe(false);
  usage.record("z", { ok: false, ms: 10 }, T0);
  expect(usage.get("z")!.cooldownUntil).toBe(T0 + FAILURE_COOLDOWN_MS);
  expect(usage.inCooldown("z", T0 + FAILURE_COOLDOWN_MS - 1)).toBe(true);
});

test("a provider-reported remaining quota is recorded as known; counters persist across store instances", () => {
  const db = new Database(":memory:");
  createUsageStore(db).record("q", { ok: true, ms: 10, remaining: 42 }, T0);
  const again = createUsageStore(db);
  expect(again.get("q")).toMatchObject({ requests: 1, remaining: { value: 42, confidence: "known" } });
  expect(again.list().map((r) => r.provider)).toEqual(["q"]);
});
