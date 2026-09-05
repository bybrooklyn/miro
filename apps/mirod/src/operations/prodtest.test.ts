import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { runOperation, type OperationKind, type OperationToolContext } from "./engine";
import { ensureOperationsTable } from "./store";
import { ensureMemoryTable, listAll } from "../memory/store";
import { reverifyCommitted } from "./prodtest";

// Real engine, real :memory: DB: operations are committed through runOperation, then re-verified
// exactly as Dreaming's idle pass would. The kind's `verify` answers from a mutable table so a
// check can be made to fail AFTER commit - that is what drift is.

function ctx(db: Database): OperationToolContext {
  const events: ServerEvent[] = [];
  return { db, send: (e) => events.push(e), waitForAnswer: async () => "approve", computeSeverity: async () => 0 };
}

function targetKind(healthy: Set<string>): OperationKind<{ target: string; note?: string }, null> {
  return {
    kind: "test.target",
    async describe(p) {
      return { summary: `touch ${p.target}`, autoApprove: true };
    },
    async captureState() {
      return null;
    },
    async apply() {},
    async verify(p) {
      return healthy.has(p.target);
    },
    async rollback() {},
    prodtest: (p) => p.target,
  };
}

test("re-verifies only the latest committed operation per target, records drift as a reinforced incident, never re-applies", async () => {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  ensureMemoryTable(db);
  const healthy = new Set(["a", "b"]);
  const kind = targetKind(healthy);
  let applied = 0;
  kind.apply = async () => {
    applied++;
  };
  expect((await runOperation(ctx(db), kind, "set up a (old)", { target: "a", note: "old" })).outcome).toBe("committed");
  expect((await runOperation(ctx(db), kind, "set up a", { target: "a", note: "new" })).outcome).toBe("committed");
  expect((await runOperation(ctx(db), kind, "set up b", { target: "b" })).outcome).toBe("committed");
  expect(applied).toBe(3);

  const fine = await reverifyCommitted(db, { [kind.kind]: kind });
  expect(fine).toEqual({ checked: 2, drifted: [] }); // a (latest only) + b

  healthy.delete("b"); // something undid b after Miro set it up
  const drift = await reverifyCommitted(db, { [kind.kind]: kind });
  expect(drift.checked).toBe(2);
  expect(drift.drifted.map((d) => d.goal)).toEqual(["set up b"]);
  expect(applied).toBe(3); // escalation, not a retry

  const incident = listAll(db, 50).find((m) => m.key === "incident.test.target.set_up_b")!;
  expect(incident.value).toMatch(/set up b - drift: no longer verifies/);
  await reverifyCommitted(db, { [kind.kind]: kind });
  // One incident per goal: the commit wrote it (1), each drift pass reinforces it (2, 3) and its
  // value is the latest status - so the agent's context reads "seen 3 times", the recurrence signal.
  expect(listAll(db, 50).find((m) => m.key === "incident.test.target.set_up_b")!.occurrenceCount).toBe(3);
});

test("a target key is shared across kinds: a later write of a trashed path supersedes the delete instead of drifting forever", async () => {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  ensureMemoryTable(db);
  const present = new Set(["/etc/app.conf"]);
  // file.delete-shaped: verify = the path is GONE; file.write-shaped: verify = the path is THERE.
  const del: OperationKind<{ target: string }, null> = { ...targetKind(new Set()), kind: "test.delete", verify: async (p) => !present.has(p.target) };
  const write: OperationKind<{ target: string }, null> = { ...targetKind(new Set()), kind: "test.write", verify: async (p) => present.has(p.target) };
  present.delete("/etc/app.conf");
  expect((await runOperation(ctx(db), del, "trash it", { target: "/etc/app.conf" })).outcome).toBe("committed");
  present.add("/etc/app.conf");
  expect((await runOperation(ctx(db), write, "write it again", { target: "/etc/app.conf" })).outcome).toBe("committed");
  // Keyed by kind as well this was two checks, and the delete's failed every sweep (audit A14).
  expect(await reverifyCommitted(db, { [del.kind]: del, [write.kind]: write })).toEqual({ checked: 1, drifted: [] });
});

test("an operation with nothing re-runnable (prodtest null), an unknown kind, and a throwing verify", async () => {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  ensureMemoryTable(db);
  const kind = targetKind(new Set(["x"]));
  kind.prodtest = (p) => (p.note === "no-verify" ? null : p.target);
  await runOperation(ctx(db), kind, "verifiable", { target: "x" });
  await runOperation(ctx(db), kind, "not verifiable", { target: "y", note: "no-verify" });
  expect(await reverifyCommitted(db, { [kind.kind]: kind })).toEqual({ checked: 1, drifted: [] });
  expect(await reverifyCommitted(db, {})).toEqual({ checked: 0, drifted: [] }); // kind no longer registered: skipped, not crashed
  kind.verify = async () => {
    throw new Error("systemctl gone");
  };
  expect((await reverifyCommitted(db, { [kind.kind]: kind })).drifted).toHaveLength(1);
});
