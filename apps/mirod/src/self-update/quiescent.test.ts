import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { isQuiescent } from "./index";
import { ensureOperationsTable, createOperation, setPhase } from "../operations/store";

function db(): Database {
  const d = new Database(":memory:");
  ensureOperationsTable(d);
  return d;
}

test("isQuiescent: an active turn is never quiescent", () => {
  expect(isQuiescent(db(), true)).toBe(false);
});

test("isQuiescent: no turn and no applying op -> quiescent", () => {
  expect(isQuiescent(db(), false)).toBe(true);
});

test("isQuiescent: an operation mid-apply blocks quiescence", () => {
  const d = db();
  createOperation(d, "op1", "test.kind", "do a thing", "{}");
  setPhase(d, "op1", "applying");
  expect(isQuiescent(d, false)).toBe(false);
  // once it commits, the box is quiescent again
  setPhase(d, "op1", "committed");
  expect(isQuiescent(d, false)).toBe(true);
});
