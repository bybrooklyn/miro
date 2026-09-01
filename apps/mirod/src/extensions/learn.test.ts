import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runLearnFlow, MAX_LEARN_DEPTH } from "./learn";
import { ensureExtensionsTable } from "./store";

// The parts of the learn flow that are pure control logic: recursion depth cap and the cycle
// guard. Everything below them spawns a real model-driven agent and is live-verified instead.

function opts(overrides: Partial<Parameters<typeof runLearnFlow>[0]> = {}) {
  const db = new Database(":memory:");
  ensureExtensionsTable(db);
  return {
    app: "radarr",
    db,
    hostMgr: {} as any,
    setSecret: () => {},
    getSecret: () => null,
    models: {} as any,
    resolveCodegenModel: async () => null, // no model → returns before any agent could spawn
    getStoredKey: () => null,
    send: () => {},
    ...overrides,
  };
}

test("depth cap stops recursion with an instruction to finish with what exists", async () => {
  const r = await runLearnFlow(opts({ depth: MAX_LEARN_DEPTH }));
  expect(r.promoted).toBe(false);
  expect(r.text).toContain("depth limit");
});

test("no model connected is reported, not thrown", async () => {
  const r = await runLearnFlow(opts());
  expect(r.promoted).toBe(false);
  expect(r.text).toContain("/provider");
});

test("app names normalise (trim + lowercase) and the in-progress guard clears afterwards", async () => {
  const r1 = await runLearnFlow(opts({ app: "  Jellyfin " }));
  expect(r1.text).toContain("/provider");
  const r2 = await runLearnFlow(opts({ app: "jellyfin" })); // not stuck as in-progress
  expect(r2.text).toContain("/provider");
});
