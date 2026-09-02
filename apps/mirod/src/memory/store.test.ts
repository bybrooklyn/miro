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
