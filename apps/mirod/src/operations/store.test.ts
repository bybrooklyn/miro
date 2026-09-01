import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureOperationsTable,
  createOperation,
  setPlan,
  setCapturedAndApplying,
  setPhase,
  getOperation,
  listByPhases,
} from "./store";

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  return db;
}

test("createOperation starts in the planning phase", () => {
  const db = freshDb();
  createOperation(db, "op1", "systemd.restart", "restart jellyfin.service", JSON.stringify({ unit: "jellyfin.service" }));
  const op = getOperation(db, "op1");
  expect(op?.phase).toBe("planning");
  expect(op?.autoApprove).toBe(false);
  expect(op?.capturedState).toBeNull();
});

test("setPlan moves to awaiting_confirmation and stores auto_approve", () => {
  const db = freshDb();
  createOperation(db, "op1", "systemd.restart", "restart x", "{}");
  setPlan(db, "op1", JSON.stringify({ summary: "restart x", autoApprove: true }), true);
  const op = getOperation(db, "op1");
  expect(op?.phase).toBe("awaiting_confirmation");
  expect(op?.autoApprove).toBe(true);
  expect(op?.plan).toContain("restart x");
});

test("setCapturedAndApplying is one atomic transition — capturing never partially persists", () => {
  const db = freshDb();
  createOperation(db, "op1", "systemd.restart", "restart x", "{}");
  setCapturedAndApplying(db, "op1", JSON.stringify({ active: true }), JSON.stringify({ active: true }));
  const op = getOperation(db, "op1");
  expect(op?.phase).toBe("applying");
  expect(op?.capturedState).toBe(JSON.stringify({ active: true }));
  expect(op?.rollback).toBe(JSON.stringify({ active: true }));
});

test("setPhase records terminal phase and error", () => {
  const db = freshDb();
  createOperation(db, "op1", "systemd.restart", "restart x", "{}");
  setPhase(db, "op1", "rolledback", "verification failed");
  const op = getOperation(db, "op1");
  expect(op?.phase).toBe("rolledback");
  expect(op?.error).toBe("verification failed");
});

test("listByPhases filters to only the requested phases", () => {
  const db = freshDb();
  createOperation(db, "op1", "systemd.restart", "a", "{}");
  createOperation(db, "op2", "systemd.restart", "b", "{}");
  createOperation(db, "op3", "systemd.restart", "c", "{}");
  setCapturedAndApplying(db, "op2", "{}", "{}"); // -> applying
  setPhase(db, "op3", "committed");

  const inFlight = listByPhases(db, ["planning", "awaiting_confirmation", "capturing"]);
  expect(inFlight.map((o) => o.id)).toEqual(["op1"]);

  const applying = listByPhases(db, ["applying", "verifying"]);
  expect(applying.map((o) => o.id)).toEqual(["op2"]);
});

test("getOperation returns null for an unknown id", () => {
  const db = freshDb();
  expect(getOperation(db, "nope")).toBeNull();
});
