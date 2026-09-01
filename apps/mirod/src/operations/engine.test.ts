import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { runOperation, reconcileOperations, type OperationKind, type OperationToolContext, type ReflectionTrigger } from "./engine";
import { createOperation, setCapturedAndApplying, ensureOperationsTable } from "./store";
import { ensureMemoryTable, listAll } from "../memory/store";

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  ensureMemoryTable(db);
  return db;
}

function fakeCtx(db: Database, answer?: string): { ctx: OperationToolContext; events: ServerEvent[]; reflections: ReflectionTrigger[] } {
  const events: ServerEvent[] = [];
  const reflections: ReflectionTrigger[] = [];
  return {
    events,
    reflections,
    ctx: {
      db,
      send: (event) => events.push(event),
      waitForAnswer: async () => answer ?? "approve",
      reflect: (trigger) => reflections.push(trigger),
    },
  };
}

function fakeKind(behavior: { autoApprove?: boolean; verifyResult?: boolean; applyThrows?: string } = {}): OperationKind<
  { x: number },
  { was: boolean }
> & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: "test.kind",
    calls,
    async describe() {
      calls.push("describe");
      return { summary: "do the thing", autoApprove: behavior.autoApprove ?? true };
    },
    async captureState() {
      calls.push("captureState");
      return { was: false };
    },
    async apply() {
      calls.push("apply");
      if (behavior.applyThrows) throw new Error(behavior.applyThrows);
    },
    async verify() {
      calls.push("verify");
      return behavior.verifyResult ?? true;
    },
    async rollback() {
      calls.push("rollback");
    },
  };
}

test("runOperation: destructive/lifeline/irreversible plans never auto-approve, whatever the kind says", async () => {
  for (const plan of [{ class: "destructive" as const }, { class: "lifeline" as const }, { irreversible: true }]) {
    const db = freshDb();
    const { ctx, events } = fakeCtx(db, "cancel");
    const kind = fakeKind({ autoApprove: true });
    kind.describe = async () => ({ summary: "risky", autoApprove: true, warning: "careful", ...plan });
    const result = await runOperation(ctx, kind, "risky", { x: 1 });
    expect(result.outcome).toBe("rolledback"); // cancelled — it asked
    const planEvent = events.find((e) => e.type === "operation_plan") as Extract<ServerEvent, { type: "operation_plan" }>;
    expect(planEvent.autoApprove).toBe(false);
    expect(planEvent.details?.warning).toBe("careful");
    const q = events.find((e) => e.type === "question") as Extract<ServerEvent, { type: "question" }>;
    expect(q.prompt).toContain("careful");
  }
});

test("lifeline: committed only after the user confirms they are still reachable", async () => {
  const db = freshDb();
  const answers: string[] = ["approve", "keep"];
  const events: ServerEvent[] = [];
  const kind = fakeKind();
  kind.describe = async () => { kind.calls.push("describe"); return { summary: "change firewall", autoApprove: false, class: "lifeline" }; };
  const ctx: OperationToolContext = { db, send: (e) => events.push(e), waitForAnswer: async () => answers.shift() ?? "keep", lifelineConfirmMs: 5_000 };
  const result = await runOperation(ctx, kind, "change firewall", { x: 1 });
  expect(result.outcome).toBe("committed");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify"]);
  const questions = events.filter((e) => e.type === "question") as Extract<ServerEvent, { type: "question" }>[];
  expect(questions.map((q) => q.id.split(":")[0])).toEqual(["op_confirm", "lifeline_confirm"]);
  expect(questions[1].prompt).toContain("still connected");
});

test("lifeline: no confirmation within the window rolls back on its own", async () => {
  const db = freshDb();
  const events: ServerEvent[] = [];
  const kind = fakeKind();
  kind.describe = async () => { kind.calls.push("describe"); return { summary: "change firewall", autoApprove: false, class: "lifeline" }; };
  let asked = 0;
  const ctx: OperationToolContext = {
    db,
    send: (e) => events.push(e),
    // First answer approves; the reachability question is never answered (connection gone).
    waitForAnswer: (id) => (++asked === 1 ? Promise.resolve("approve") : new Promise(() => {})),
    lifelineConfirmMs: 200,
  };
  const result = await runOperation(ctx, kind, "change firewall", { x: 1 });
  expect(result.outcome).toBe("rolledback");
  expect(result.message).toContain("no reachability confirmation");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify", "rollback"]);
});

test("lifeline: an explicit 'roll back' answer rolls back", async () => {
  const db = freshDb();
  const answers = ["approve", "rollback"];
  const kind = fakeKind();
  kind.describe = async () => ({ summary: "change sshd", autoApprove: false, class: "lifeline" });
  const ctx: OperationToolContext = { db, send: () => {}, waitForAnswer: async () => answers.shift() ?? "keep", lifelineConfirmMs: 5_000 };
  const result = await runOperation(ctx, kind, "change sshd", { x: 1 });
  expect(result.outcome).toBe("rolledback");
  expect(kind.calls.at(-1)).toBe("rollback");
});

test("runOperation: scope (writes/network/class) rides in the plan event's details", async () => {
  const db = freshDb();
  const { ctx, events } = fakeCtx(db);
  const kind = fakeKind();
  kind.describe = async () => ({ summary: "s", autoApprove: true, class: "mutate", writes: ["/opt/x"], network: false });
  await runOperation(ctx, kind, "s", { x: 1 });
  const planEvent = events.find((e) => e.type === "operation_plan") as Extract<ServerEvent, { type: "operation_plan" }>;
  expect(planEvent.autoApprove).toBe(true);
  expect(planEvent.details).toEqual({ class: "mutate", writes: ["/opt/x"], network: false });
});

test("runOperation: auto-approved, verify succeeds -> committed, no rollback called", async () => {
  const db = freshDb();
  const { ctx, events } = fakeCtx(db);
  const kind = fakeKind();

  const result = await runOperation(ctx, kind, "do the thing", { x: 1 });

  expect(result.outcome).toBe("committed");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify"]);
  expect(events.map((e) => e.type)).toEqual(["operation_plan", "activity", "activity", "activity", "operation_result"]);
  const last = events[events.length - 1] as Extract<ServerEvent, { type: "operation_result" }>;
  expect(last.outcome).toBe("committed");
});

test("runOperation: verify fails -> rollback is called, outcome rolledback", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  const kind = fakeKind({ verifyResult: false });

  const result = await runOperation(ctx, kind, "do the thing", { x: 1 });

  expect(result.outcome).toBe("rolledback");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify", "rollback"]);
});

test("runOperation: apply() throws -> rollback is still attempted", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  const kind = fakeKind({ applyThrows: "systemctl exploded" });

  const result = await runOperation(ctx, kind, "do the thing", { x: 1 });

  expect(result.outcome).toBe("rolledback");
  expect(result.message).toContain("systemctl exploded");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "rollback"]);
});

test("runOperation: not auto-approved, user cancels -> nothing captured/applied", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db, "cancel");
  const kind = fakeKind({ autoApprove: false });

  const result = await runOperation(ctx, kind, "restart ssh", { x: 1 });

  expect(result.outcome).toBe("rolledback");
  expect(kind.calls).toEqual(["describe"]); // never captured, applied, or rolled back
});

test("runOperation: not auto-approved, user approves -> proceeds normally", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db, "approve");
  const kind = fakeKind({ autoApprove: false });

  const result = await runOperation(ctx, kind, "restart ssh", { x: 1 });

  expect(result.outcome).toBe("committed");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify"]);
});

test("reconcileOperations: interrupted before any apply -> rolled back, kind never called", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "goal", "{}"); // stuck in 'planning'
  const kind = fakeKind();

  await reconcileOperations(db, { "test.kind": kind });

  expect(kind.calls).toEqual([]);
});

test("reconcileOperations: mid-flight + verify passes -> committed", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "goal", JSON.stringify({ x: 1 }));
  setCapturedAndApplying(db, "op1", JSON.stringify({ was: true }), JSON.stringify({ was: true }));
  const kind = fakeKind({ verifyResult: true });

  await reconcileOperations(db, { "test.kind": kind });

  expect(kind.calls).toEqual(["verify"]);
});

test("reconcileOperations: mid-flight + verify fails -> rollback called", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "goal", JSON.stringify({ x: 1 }));
  setCapturedAndApplying(db, "op1", JSON.stringify({ was: true }), JSON.stringify({ was: true }));
  const kind = fakeKind({ verifyResult: false });

  await reconcileOperations(db, { "test.kind": kind });

  expect(kind.calls).toEqual(["verify", "rollback"]);
});

test("runOperation: committed -> mechanical incident memory written", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  const kind = fakeKind();

  await runOperation(ctx, kind, "do the thing", { x: 1 });

  const memories = listAll(db);
  expect(memories).toHaveLength(1);
  expect(memories[0].category).toBe("incident");
  expect(memories[0].source).toBe("mechanical:test.kind");
  expect(memories[0].value).toContain("committed");
});

test("runOperation: rolledback -> mechanical incident memory written with error", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  const kind = fakeKind({ verifyResult: false });

  await runOperation(ctx, kind, "do the thing", { x: 1 });

  const memories = listAll(db);
  expect(memories).toHaveLength(1);
  expect(memories[0].value).toContain("rolledback");
});

test("runOperation: user cancellation -> no incident memory written (nothing touched the server)", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db, "cancel");
  const kind = fakeKind({ autoApprove: false });

  await runOperation(ctx, kind, "restart ssh", { x: 1 });

  expect(listAll(db)).toEqual([]);
});

test("runOperation: reflect only fires once repeat failures cross the threshold", async () => {
  const db = freshDb();
  const { ctx: ctx1, reflections: reflections1 } = fakeCtx(db);
  await runOperation(ctx1, fakeKind({ verifyResult: false }), "do the thing", { x: 1 });
  expect(reflections1).toEqual([]); // 1st failure — below threshold

  const { ctx: ctx2, reflections: reflections2 } = fakeCtx(db);
  await runOperation(ctx2, fakeKind({ verifyResult: false }), "do the thing", { x: 1 });
  expect(reflections2).toHaveLength(1); // 2nd failure — threshold crossed
  expect(reflections2[0].repeatFailureCount).toBe(2);
});

test("runOperation: reflect never fires on a committed outcome", async () => {
  const db = freshDb();
  const { ctx, reflections } = fakeCtx(db);
  await runOperation(ctx, fakeKind(), "do the thing", { x: 1 });
  expect(reflections).toEqual([]);
});

test("reconcileOperations: mid-flight committed transition writes mechanical incident memory", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "goal a", JSON.stringify({ x: 1 }));
  setCapturedAndApplying(db, "op1", JSON.stringify({ was: true }), JSON.stringify({ was: true }));

  await reconcileOperations(db, { "test.kind": fakeKind({ verifyResult: true }) });

  const memories = listAll(db);
  expect(memories).toHaveLength(1);
  expect(memories[0].value).toContain("committed");
});

test("reconcileOperations: mid-flight rolledback transition writes mechanical incident memory", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "goal a", JSON.stringify({ x: 1 }));
  setCapturedAndApplying(db, "op1", JSON.stringify({ was: true }), JSON.stringify({ was: true }));

  await reconcileOperations(db, { "test.kind": fakeKind({ verifyResult: false }) });

  const memories = listAll(db);
  expect(memories).toHaveLength(1);
  expect(memories[0].value).toContain("rolledback");
});

test("reconcileOperations: interrupted-before-apply writes no incident memory", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "goal", "{}"); // stuck in 'planning'

  await reconcileOperations(db, { "test.kind": fakeKind() });

  expect(listAll(db)).toEqual([]);
});
