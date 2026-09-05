import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureNotificationsTable, insertNotification, listUndelivered, markDelivered, recentByTitle } from "./store";

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureNotificationsTable(db);
  return db;
}

function seed(db: Database, id: string, tier: "routine" | "worth_knowing" | "needs_attention", title: string, createdAt: number) {
  insertNotification(db, { id, tier, title, body: "", source: "test", createdAt, tuiDeliveredAt: null });
}

test("listUndelivered: worth_knowing+ only, undelivered only, oldest first", () => {
  const db = freshDb();
  seed(db, "a", "worth_knowing", "second", 2000);
  seed(db, "b", "needs_attention", "first", 1000);
  seed(db, "c", "routine", "routine noise", 1500); // never replays
  const pending = listUndelivered(db);
  expect(pending.map((p) => p.id)).toEqual(["b", "a"]); // created_at ascending, routine excluded
});

test("markDelivered removes a row from the undelivered set", () => {
  const db = freshDb();
  seed(db, "a", "worth_knowing", "x", 1000);
  seed(db, "b", "needs_attention", "y", 2000);
  markDelivered(db, ["a"]);
  expect(listUndelivered(db).map((p) => p.id)).toEqual(["b"]);
  markDelivered(db, []); // empty is a no-op, never a malformed query
  expect(listUndelivered(db).map((p) => p.id)).toEqual(["b"]);
});

test("recentByTitle: the dedup backstop sees a same-title notification inside the window, not outside", () => {
  const db = freshDb();
  insertNotification(db, { id: "a", tier: "needs_attention", title: "Gave up repairing gotify - disabled", body: "", source: "repair", createdAt: Date.now() - 60_000, tuiDeliveredAt: null });
  expect(recentByTitle(db, "Gave up repairing gotify - disabled", 12 * 60 * 60_000)).toBe(true);
  expect(recentByTitle(db, "Gave up repairing gotify - disabled", 30_000)).toBe(false); // older than a 30s window
  expect(recentByTitle(db, "a different title", 12 * 60 * 60_000)).toBe(false);
});
