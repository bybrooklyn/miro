import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { runOperation, reconcileOperations, type OperationKind, type OperationToolContext, type ReflectionTrigger } from "./engine";
import { createOperation, setCapturedAndApplying, setPlan, getOperation, ensureOperationsTable } from "./store";
import { ensureMemoryTable, listAll } from "../memory/store";
import { createRetryLedger } from "./retry-ledger";

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
      // Deterministic and free of real subprocess calls - the real severity oracle would depend on
      // this machine's actual systemd/docker/disk state, which is neither.
      computeSeverity: async () => 0,
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

// Undo-then-retry (PLAN.md §5.15 A): the engine restores s_pre on failure; the ledger refuses the
// SAME plan again this turn before it is even described, and a different plan runs.
test("runOperation: an identical plan that already rolled back this turn is refused before it is planned; a different one runs", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  ctx.retries = createRetryLedger(3);
  const kind = fakeKind({ verifyResult: false });
  expect((await runOperation(ctx, kind, "do", { x: 1 })).outcome).toBe("rolledback");
  const callsAfterFirst = kind.calls.length;
  const again = await runOperation(ctx, kind, "do", { x: 1 });
  expect(again.outcome).toBe("rolledback");
  expect(again.message).toMatch(/exact plan already failed this turn/);
  expect(kind.calls.length).toBe(callsAfterFirst); // not described, not captured, not applied
  expect((db.query("SELECT COUNT(*) AS n FROM operations").get() as { n: number }).n).toBe(1); // no row for a refusal
  await runOperation(ctx, kind, "do", { x: 2 });
  expect(kind.calls.length).toBeGreaterThan(callsAfterFirst);
});

test("runOperation: a user cancellation is not a failed plan - the same plan may be asked again", async () => {
  const db = freshDb();
  const ledger = createRetryLedger(3);
  const cancelled = fakeCtx(db, "cancel");
  cancelled.ctx.retries = ledger;
  const kind = fakeKind({ autoApprove: false });
  expect((await runOperation(cancelled.ctx, kind, "do", { x: 1 })).message).toBe("Cancelled - nothing was changed.");
  const approved = fakeCtx(db, "approve");
  approved.ctx.retries = ledger;
  expect((await runOperation(approved.ctx, kind, "do", { x: 1 })).outcome).toBe("committed");
});

test("runOperation: destructive/lifeline/irreversible plans never auto-approve, whatever the kind says", async () => {
  for (const plan of [{ class: "destructive" as const }, { class: "lifeline" as const }, { irreversible: true }]) {
    const db = freshDb();
    const { ctx, events } = fakeCtx(db, "cancel");
    const kind = fakeKind({ autoApprove: true });
    kind.describe = async () => ({ summary: "risky", autoApprove: true, warning: "careful", ...plan });
    const result = await runOperation(ctx, kind, "risky", { x: 1 });
    expect(result.outcome).toBe("rolledback"); // cancelled - it asked
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
  const ctx: OperationToolContext = { db, send: (e) => events.push(e), waitForAnswer: async () => answers.shift() ?? "keep", lifelineConfirmMs: 5_000, computeSeverity: async () => 0 };
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
    computeSeverity: async () => 0,
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
  const ctx: OperationToolContext = { db, send: () => {}, waitForAnswer: async () => answers.shift() ?? "keep", lifelineConfirmMs: 5_000, computeSeverity: async () => 0 };
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
  // A kind that declares no dryRunFidelity is shown as "none" - effect unknown - never as exact.
  expect(planEvent.details).toEqual({ class: "mutate", writes: ["/opt/x"], network: false, dryRunFidelity: "none" });
});

test("repair contract: expects/rollbackWhen/scopeEvidence/dryRunFidelity ride in the plan event's details", async () => {
  const db = freshDb();
  const { ctx, events } = fakeCtx(db);
  const kind = fakeKind();
  kind.describe = async () => ({
    summary: "restart nginx",
    autoApprove: true,
    writes: ["/run/systemd"],
    expects: "nginx is active after the restart",
    rollbackWhen: "the unit is not active afterwards",
    scopeEvidence: "systemd's runtime directories only",
    dryRunFidelity: "exact",
  });
  await runOperation(ctx, kind, "restart nginx", { x: 1 });
  const planEvent = events.find((e) => e.type === "operation_plan") as Extract<ServerEvent, { type: "operation_plan" }>;
  expect(planEvent.details).toMatchObject({
    expects: "nginx is active after the restart",
    rollbackWhen: "the unit is not active afterwards",
    scopeEvidence: "systemd's runtime directories only",
    dryRunFidelity: "exact",
  });
});

test("runOperation: auto-approved, verify succeeds -> committed, no rollback called", async () => {
  const db = freshDb();
  const { ctx, events } = fakeCtx(db);
  const kind = fakeKind();

  const result = await runOperation(ctx, kind, "do the thing", { x: 1 });

  expect(result.outcome).toBe("committed");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify"]);
  expect(events.map((e) => e.type)).toEqual(["operation_plan", "operation_progress", "operation_progress", "operation_progress", "operation_result"]);
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

test("reconcileOperations: irreversible + verify fails -> committed, NOT a false rollback (audit E1)", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "create admin", JSON.stringify({ x: 1 }));
  setPlan(db, "op1", JSON.stringify({ summary: "POST /Startup/User", autoApprove: false, irreversible: true }), false);
  setCapturedAndApplying(db, "op1", JSON.stringify({ was: true }), JSON.stringify({ was: true }));
  const kind = fakeKind({ verifyResult: false }); // the wizard-step case: applied but verify can't confirm

  await reconcileOperations(db, { "test.kind": kind });

  expect(kind.calls).not.toContain("rollback"); // never claim an undo that did not happen
  expect(getOperation(db, "op1")!.phase).toBe("committed");
});

test("reconcileOperations: irreversible with no recovery data -> committed, not the old rollback branch (E1)", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "create admin", JSON.stringify({ x: 1 }));
  setPlan(db, "op1", JSON.stringify({ summary: "POST", autoApprove: false, irreversible: true }), false);
  // left in 'applying' with no captured_state/rollback (an http POST with no undo)
  const db2 = db;
  db2.run("UPDATE operations SET phase = 'applying' WHERE id = 'op1'");
  const kind = fakeKind({ verifyResult: true });

  await reconcileOperations(db, { "test.kind": kind });

  expect(getOperation(db, "op1")!.phase).toBe("committed");
});

test("reconcileOperations: lifeline + verify passes -> rolled back, gate not bypassed (audit E2)", async () => {
  const db = freshDb();
  createOperation(db, "op1", "test.kind", "tighten firewall", JSON.stringify({ x: 1 }));
  setPlan(db, "op1", JSON.stringify({ summary: "ufw deny", autoApprove: false, class: "lifeline" }), false);
  setCapturedAndApplying(db, "op1", JSON.stringify({ was: true }), JSON.stringify({ was: true }));
  const kind = fakeKind({ verifyResult: true });

  await reconcileOperations(db, { "test.kind": kind });

  // The reachability handshake cannot happen at boot, so a possible lockout is reverted, never committed.
  expect(kind.calls).toContain("rollback");
  expect(getOperation(db, "op1")!.phase).toBe("rolledback");
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
  expect(reflections1).toEqual([]); // 1st failure - below threshold

  const { ctx: ctx2, reflections: reflections2 } = fakeCtx(db);
  await runOperation(ctx2, fakeKind({ verifyResult: false }), "do the thing", { x: 1 });
  expect(reflections2).toHaveLength(1); // 2nd failure - threshold crossed
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

// --- Blast-radius guards (PLAN.md §5.15 A): write mutex, rate limit + cooldown, selector sanity ---
import { badWriteScope, MAX_UNATTENDED_OPS_PER_HOUR } from "./engine";
import { setPhase } from "./store";

test("write mutex: a second mutating operation waits until the first reaches its terminal outcome", async () => {
  const db = freshDb();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve));
  const first = fakeKind();
  first.apply = async () => {
    log.push("first:apply");
    await firstMayFinish; // holds the lock mid-apply
  };
  const second = fakeKind();
  second.captureState = async () => {
    log.push("second:capture");
    return { was: false };
  };
  const { ctx } = fakeCtx(db);
  const p1 = runOperation(ctx, first, "one", { x: 1 });
  const p2 = runOperation(ctx, second, "two", { x: 2 });
  await Bun.sleep(30); // both are past describe/confirm; the second must be parked at the lock
  expect(log).toEqual(["first:apply"]);
  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  expect([r1.outcome, r2.outcome]).toEqual(["committed", "committed"]);
  expect(log).toEqual(["first:apply", "second:capture"]);
});

test("rate limit: past the unattended budget an auto-approvable operation asks a human instead of running alone", async () => {
  const db = freshDb();
  for (let i = 0; i < MAX_UNATTENDED_OPS_PER_HOUR; i++) {
    createOperation(db, `auto${i}`, "test.kind", "g", "{}");
    setPlan(db, `auto${i}`, "{}", true); // ran unattended, this hour
    setPhase(db, `auto${i}`, "committed");
  }
  const { ctx, events } = fakeCtx(db, "approve");
  const result = await runOperation(ctx, fakeKind({ autoApprove: true }), "one more", { x: 1 });
  const planEvent = events.find((e) => e.type === "operation_plan") as Extract<ServerEvent, { type: "operation_plan" }>;
  expect(planEvent.autoApprove).toBe(false); // downgraded to a human decision, not refused
  const q = events.find((e) => e.type === "question") as Extract<ServerEvent, { type: "question" }>;
  expect(q.prompt).toContain("unattended-operation limit");
  expect(result.outcome).toBe("committed"); // the human approved, so it ran
});

test("cooldown: a recent real rollback makes the next auto-approvable operation ask a human", async () => {
  const db = freshDb();
  createOperation(db, "r1", "test.kind", "g", "{}");
  setPhase(db, "r1", "rolledback", "verification failed"); // a change was made and undone, just now
  const { ctx, events } = fakeCtx(db, "approve");
  await runOperation(ctx, fakeKind({ autoApprove: true }), "next", { x: 1 });
  const q = events.find((e) => e.type === "question") as Extract<ServerEvent, { type: "question" }>;
  expect(q.prompt).toContain("cooling down");
});

test("cooldown: a user cancellation is not a rollback and does not trip it", async () => {
  const db = freshDb();
  createOperation(db, "c1", "test.kind", "g", "{}");
  setPhase(db, "c1", "rolledback", "cancelled by user");
  const { ctx, events } = fakeCtx(db);
  await runOperation(ctx, fakeKind({ autoApprove: true }), "next", { x: 1 });
  expect(events.some((e) => e.type === "question")).toBe(false); // still ran unattended
});

test("selector sanity: badWriteScope flags empty, root, and glob roots only", () => {
  expect(badWriteScope(["/opt/x", "/etc/nginx"])).toBeNull();
  expect(badWriteScope(undefined)).toBeNull();
  expect(badWriteScope(["/"])).toBe("/");
  expect(badWriteScope([" "])).toBe(" ");
  expect(badWriteScope(["/opt/*"])).toBe("/opt/*");
});

// --- Severity oracle (PLAN.md §5.15 A / severity.ts): commit requires kind.verify() AND μ not worse ---

test("severity oracle: a narrowly-passing verify is still rolled back if the box got worse overall", async () => {
  const db = freshDb();
  const { ctx, events } = fakeCtx(db);
  let call = 0;
  ctx.computeSeverity = async () => (++call === 1 ? 0 : 3); // clean before, worse after - verify() itself passes
  const kind = fakeKind({ verifyResult: true });
  const result = await runOperation(ctx, kind, "restart nginx", { x: 1 });
  expect(result.outcome).toBe("rolledback");
  expect(result.message).toContain("Regressed");
  expect(result.message).toContain("severity 0 -> 3");
  expect(kind.calls).toEqual(["describe", "captureState", "apply", "verify", "rollback"]);
  const resultEvent = events.find((e) => e.type === "operation_result") as Extract<ServerEvent, { type: "operation_result" }>;
  expect(resultEvent.outcome).toBe("rolledback");
});

test("severity oracle: equal or improved severity does not block a commit", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  let call = 0;
  ctx.computeSeverity = async () => (++call === 1 ? 5 : 5); // unchanged - not a regression
  const kind = fakeKind({ verifyResult: true });
  const result = await runOperation(ctx, kind, "restart nginx", { x: 1 });
  expect(result.outcome).toBe("committed");
});

test("severity oracle: a failing kind.verify still rolls back even if severity improved", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  let call = 0;
  ctx.computeSeverity = async () => (++call === 1 ? 5 : 0); // severity improved, but the kind itself failed
  const kind = fakeKind({ verifyResult: false });
  const result = await runOperation(ctx, kind, "restart nginx", { x: 1 });
  expect(result.outcome).toBe("rolledback");
  expect(result.message).toContain("Verification failed"); // kind failure names itself, not severity
});

test("severity oracle: an irreversible op that regresses reports applied_unverified, not a false rollback", async () => {
  const db = freshDb();
  const { ctx } = fakeCtx(db);
  let call = 0;
  ctx.computeSeverity = async () => (++call === 1 ? 0 : 2);
  const kind = fakeKind({ verifyResult: true });
  kind.describe = async () => ({ summary: "wizard step", autoApprove: true, irreversible: true });
  const result = await runOperation(ctx, kind, "wizard step", { x: 1 });
  expect(result.outcome).toBe("applied_unverified");
  expect(result.message).toContain("severity 0 -> 2");
});

test("selector sanity: a root write scope is refused before anything is planned, asked, or touched", async () => {
  const db = freshDb();
  const { ctx, events } = fakeCtx(db);
  const kind = fakeKind();
  kind.describe = async () => {
    kind.calls.push("describe");
    return { summary: "wipe", autoApprove: true, writes: ["/"] };
  };
  const result = await runOperation(ctx, kind, "wipe", { x: 1 });
  expect(result.outcome).toBe("rolledback");
  expect(result.message).toContain("Refused");
  expect(kind.calls).toEqual(["describe"]);
  expect(events.map((e) => e.type)).toEqual(["operation_result"]); // no plan event, no question
  expect(listAll(db)).toEqual([]); // no incident - nothing touched
});
