import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureMemoryTable,
  remember,
  getByKey,
  query,
  listAll,
  topFacts,
  buildSummary,
  recordIncident,
  forget,
  formatForDisplay,
  confidenceLabel,
  bumpHelpful,
  bumpHarmful,
} from "./store";

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureMemoryTable(db);
  return db;
}

test("remember creates a new row with occurrence_count 1", () => {
  const db = freshDb();
  const rec = remember(db, "preference", "reply_style", "prefers short replies", "agent_tool");
  expect(rec.occurrenceCount).toBe(1);
  expect(rec.value).toBe("prefers short replies");
});

test("remember redacts a credential-shaped value but leaves a secret ref intact (audit L5)", () => {
  const db = freshDb();
  const leaked = remember(db, "server_fact", "jf", "the admin password=hunter2-very-secret works", "agent_tool");
  expect(leaked.value).not.toContain("hunter2-very-secret");
  expect(leaked.value).toContain("[redacted]");
  const ref = remember(db, "capability", "jellyfin", "authenticates via {{secret:extension.jellyfin.admin_password}}", "learn");
  expect(ref.value).toContain("extension.jellyfin.admin_password"); // a ref is not a value
});

test("remember on the same (category, key) reinforces instead of duplicating", () => {
  const db = freshDb();
  const first = remember(db, "preference", "reply_style", "prefers short replies", "agent_tool");
  const second = remember(db, "preference", "reply_style", "prefers very short replies", "reflection");
  expect(second.id).toBe(first.id);
  expect(second.occurrenceCount).toBe(2);
  expect(second.value).toBe("prefers very short replies");
  expect(query(db, { category: "preference" })).toHaveLength(1);
});

test("confidenceLabel thresholds", () => {
  expect(confidenceLabel(1)).toBe("tentative");
  expect(confidenceLabel(2)).toBe("noted a few times");
  expect(confidenceLabel(3)).toBe("noted a few times");
  expect(confidenceLabel(4)).toBe("confirmed");
});

test("getByKey returns null for an unknown key", () => {
  const db = freshDb();
  expect(getByKey(db, "server_fact", "nope")).toBeNull();
});

test("query filters by category and keyword", () => {
  const db = freshDb();
  remember(db, "server_fact", "postgres_port", "postgres runs on port 5433", "agent_tool");
  remember(db, "preference", "reply_style", "prefers short replies", "agent_tool");
  expect(query(db, { category: "server_fact" }).map((r) => r.key)).toEqual(["postgres_port"]);
  expect(query(db, { keyword: "postgres" }).map((r) => r.key)).toEqual(["postgres_port"]);
  expect(query(db, { keyword: "nonexistent" })).toEqual([]);
});

test("listAll returns everything, ordered by category", () => {
  const db = freshDb();
  remember(db, "preference", "a", "pref a", "agent_tool");
  remember(db, "server_fact", "b", "fact b", "agent_tool");
  expect(listAll(db)).toHaveLength(2);
});

test("topFacts excludes reply_style and incidents, is bounded by limit", () => {
  const db = freshDb();
  remember(db, "preference", "reply_style", "terse", "agent_tool");
  remember(db, "server_fact", "postgres_port", "port 5433", "agent_tool");
  recordIncident(db, { kind: "systemd.restart", goal: "restart jellyfin.service", phase: "committed", error: null });
  const facts = topFacts(db, 8);
  expect(facts.map((r) => r.key)).toEqual(["postgres_port"]);
});

test("buildSummary is empty with no facts, otherwise lists confidence-qualified bullets", () => {
  const db = freshDb();
  expect(buildSummary(db)).toBe("");
  remember(db, "server_fact", "postgres_port", "postgres runs on port 5433", "agent_tool");
  expect(buildSummary(db)).toContain("postgres runs on port 5433 (tentative)");
});

test("recordIncident writes a mechanical fact keyed by kind+goal, reinforcing on repeat", () => {
  const db = freshDb();
  const first = recordIncident(db, { kind: "systemd.restart", goal: "restart jellyfin.service", phase: "rolledback", error: "verification failed" });
  expect(first.source).toBe("mechanical:systemd.restart");
  expect(first.value).toContain("rolledback: verification failed");
  const second = recordIncident(db, { kind: "systemd.restart", goal: "restart jellyfin.service", phase: "committed", error: null });
  expect(second.id).toBe(first.id);
  expect(second.occurrenceCount).toBe(2);
});

test("forget deletes by exact id or id prefix", () => {
  const db = freshDb();
  const rec = remember(db, "preference", "reply_style", "terse", "agent_tool");
  expect(forget(db, "nonexistent")).toBe(0);
  expect(forget(db, rec.id.slice(0, 8))).toBe(1);
  expect(getByKey(db, "preference", "reply_style")).toBeNull();
});

test("forget never wildcard-wipes: %, _, and empty match nothing (audit D1)", () => {
  const db = freshDb();
  remember(db, "preference", "reply_style", "terse", "agent_tool");
  remember(db, "capability", "jellyfin", "operational model", "learn");
  remember(db, "server_fact", "os", "Debian 13", "agent_tool");
  expect(forget(db, "%")).toBe(0); // the LIKE-wildcard wipe that would delete everything
  expect(forget(db, "")).toBe(0);
  expect(forget(db, "   ")).toBe(0);
  expect(forget(db, "_")).toBe(0);
  expect(query(db, {}).length).toBe(3); // all three survive
});

test("formatForDisplay groups by category and includes short ids", () => {
  const db = freshDb();
  expect(formatForDisplay([])).toBe("Nothing remembered yet.");
  const rec = remember(db, "preference", "reply_style", "prefers short replies", "agent_tool");
  const text = formatForDisplay([rec]);
  expect(text).toContain("Preferences:");
  expect(text).toContain(rec.id.slice(0, 8));
  expect(text).toContain("/memory forget");
});

// --- Provenance + outcome-feedback columns (PLAN.md §5.15 B) ---

test("remember: new provenance fields default to null, matching every pre-existing call site", () => {
  const db = freshDb();
  const rec = remember(db, "server_fact", "server.containers", "runs 3 containers", "discovery");
  expect(rec.helpfulCount).toBe(0);
  expect(rec.harmfulCount).toBe(0);
  expect(rec.expiresAt).toBeNull();
  expect(rec.observedAt).toBeNull();
  expect(rec.appVersion).toBeNull();
  expect(rec.supersededBy).toBeNull();
});

test("remember: expiresAt/observedAt/appVersion round-trip through getByKey", () => {
  const db = freshDb();
  const observedAt = Date.now() - 1000;
  const expiresAt = Date.now() + 100_000;
  remember(db, "capability", "jellyfin", "media server", "learning_agent", null, { expiresAt, observedAt, appVersion: "10.11.11" });
  const rec = getByKey(db, "capability", "jellyfin")!;
  expect(rec.expiresAt).toBe(expiresAt);
  expect(rec.observedAt).toBe(observedAt);
  expect(rec.appVersion).toBe("10.11.11");
});

test("remember: re-remembering with no opts clears a previously-set expiry, matching value's own overwrite behavior", () => {
  const db = freshDb();
  remember(db, "server_fact", "k", "v1", "discovery", null, { expiresAt: Date.now() + 100_000 });
  remember(db, "server_fact", "k", "v2", "discovery"); // no opts - defaults to null
  expect(getByKey(db, "server_fact", "k")!.expiresAt).toBeNull();
});

test("bumpHelpful / bumpHarmful increment independently of occurrence_count", () => {
  const db = freshDb();
  const rec = remember(db, "capability", "jellyfin", "media server", "learning_agent");
  bumpHelpful(db, rec.id);
  bumpHelpful(db, rec.id);
  bumpHarmful(db, rec.id);
  const after = getByKey(db, "capability", "jellyfin")!;
  expect(after.helpfulCount).toBe(2);
  expect(after.harmfulCount).toBe(1);
  expect(after.occurrenceCount).toBe(1); // unaffected - "seen again" is a separate signal from "worked again"
});

test("query/listAll/topFacts exclude an expired row by default, but query can opt back in", () => {
  const db = freshDb();
  remember(db, "server_fact", "fresh", "still true", "discovery", null, { expiresAt: Date.now() + 100_000 });
  remember(db, "server_fact", "stale", "no longer true", "discovery", null, { expiresAt: Date.now() - 1000 });
  const fresh = query(db, { category: "server_fact" });
  expect(fresh.map((r) => r.key)).toEqual(["fresh"]);
  const all = listAll(db);
  expect(all.map((r) => r.key)).toEqual(["fresh"]);
  const facts = topFacts(db);
  expect(facts.map((r) => r.key)).toEqual(["fresh"]);
  const withExpired = query(db, { category: "server_fact", includeExpired: true });
  expect(withExpired.map((r) => r.key).sort()).toEqual(["fresh", "stale"]);
});

test("ensureMemoryTable is idempotent across the real upgrade path - a second boot doesn't error on duplicate columns", () => {
  const db = new Database(":memory:");
  ensureMemoryTable(db); // simulates the first boot after this change, adding the new columns
  remember(db, "server_fact", "k", "v", "discovery");
  expect(() => ensureMemoryTable(db)).not.toThrow(); // every boot after that
  expect(getByKey(db, "server_fact", "k")!.value).toBe("v"); // data survived
});

test("a row with no expiry set is never excluded (the default for every existing call site)", () => {
  const db = freshDb();
  remember(db, "server_fact", "k", "v", "discovery"); // no expiresAt at all
  expect(query(db, { category: "server_fact" })).toHaveLength(1);
});
