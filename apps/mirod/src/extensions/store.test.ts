import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureExtensionsTable, promote, recordFailure, recordSuccess, incrementRepairAttempts, disable, getExtension, listEnabled } from "./store";

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureExtensionsTable(db);
  return db;
}

test("promote creates an enabled row with zeroed counters", () => {
  const db = freshDb();
  promote(db, "gotify", JSON.stringify({ app: "gotify" }), 1, "http://localhost:8080");
  const rec = getExtension(db, "gotify");
  expect(rec?.state).toBe("enabled");
  expect(rec?.version).toBe(1);
  expect(rec?.consecutiveFailures).toBe(0);
  expect(rec?.repairAttempts).toBe(0);
});

test("promote on an existing app resets both counters even if they were nonzero", () => {
  const db = freshDb();
  promote(db, "gotify", "{}", 1, "http://localhost:8080");
  recordFailure(db, "gotify", "boom");
  recordFailure(db, "gotify", "boom again");
  incrementRepairAttempts(db, "gotify");

  promote(db, "gotify", JSON.stringify({ v: 2 }), 2, "http://localhost:8080");

  const rec = getExtension(db, "gotify");
  expect(rec?.version).toBe(2);
  expect(rec?.consecutiveFailures).toBe(0);
  expect(rec?.repairAttempts).toBe(0);
  expect(rec?.state).toBe("enabled");
});

test("recordFailure increments consecutive_failures and records the error", () => {
  const db = freshDb();
  promote(db, "gotify", "{}", 1, "http://localhost:8080");
  expect(recordFailure(db, "gotify", "first failure")).toBe(1);
  expect(recordFailure(db, "gotify", "second failure")).toBe(2);
  const rec = getExtension(db, "gotify");
  expect(rec?.lastError).toBe("second failure");
});

test("recordSuccess resets consecutive_failures to 0", () => {
  const db = freshDb();
  promote(db, "gotify", "{}", 1, "http://localhost:8080");
  recordFailure(db, "gotify", "boom");
  recordFailure(db, "gotify", "boom");
  recordSuccess(db, "gotify");
  expect(getExtension(db, "gotify")?.consecutiveFailures).toBe(0);
});

test("incrementRepairAttempts is independent of consecutive_failures", () => {
  const db = freshDb();
  promote(db, "gotify", "{}", 1, "http://localhost:8080");
  recordFailure(db, "gotify", "boom");
  expect(incrementRepairAttempts(db, "gotify")).toBe(1);
  expect(incrementRepairAttempts(db, "gotify")).toBe(2);
  expect(getExtension(db, "gotify")?.consecutiveFailures).toBe(1);
});

test("disable sets state to disabled and records the reason", () => {
  const db = freshDb();
  promote(db, "gotify", "{}", 1, "http://localhost:8080");
  disable(db, "gotify", "exceeded max repair attempts");
  const rec = getExtension(db, "gotify");
  expect(rec?.state).toBe("disabled");
  expect(rec?.lastError).toBe("exceeded max repair attempts");
});

test("listEnabled only returns enabled extensions", () => {
  const db = freshDb();
  promote(db, "gotify", "{}", 1, "http://localhost:8080");
  promote(db, "freshrss", "{}", 1, "http://localhost:8081");
  disable(db, "freshrss", "broken");
  expect(listEnabled(db).map((r) => r.app)).toEqual(["gotify"]);
});

test("getExtension returns null for an unknown app", () => {
  const db = freshDb();
  expect(getExtension(db, "nope")).toBeNull();
});
