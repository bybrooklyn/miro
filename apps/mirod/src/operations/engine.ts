import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import * as store from "./store";
import * as memory from "../memory/store";
import type { CommandClass } from "./classify";
import { computeSeverity as computeSeverityLive } from "./severity";
import type { RetryLedger } from "./retry-ledger";

export interface OperationPlan {
  summary: string;
  autoApprove: boolean;
  details?: Record<string, unknown>;
  /** From the classifier or the kind's own judgement (PLAN.md §5.7). `destructive` and `lifeline`
   * never auto-approve - the engine enforces that below, whatever the kind asked for. */
  class?: CommandClass;
  /** The sandbox scope this operation runs under: declared writable roots and whether the network
   * is shared. Shown to the user in the plan, enforced by the kernel (operations/sandbox.ts). */
  writes?: string[];
  network?: boolean;
  /** No rollback is possible (e.g. completing a setup wizard). Always confirmed, with a warning. */
  irreversible?: boolean;
  warning?: string;
  /** The repair contract (PLAN.md §5.15 A, after DBA-Bench: 80% of unsafe repairs were unscoped
   * or unsafeguarded, not deletions). Declared BEFORE apply, shown in the plan:
   * - `expects`: the state transition verify() will check.
   * - `rollbackWhen`: the condition under which rollback fires (or "never" for the irreversible).
   * - `scopeEvidence`: why exactly these writable roots.
   * - `dryRunFidelity`: how faithfully describe() predicts the effect. The Ansible lesson - a
   *   dry-run that says "no changes" when it means "unknown" is worse than none - so a kind that
   *   does not declare one is shown as "none" (effect unknown), never silently as exact. */
  expects?: string;
  rollbackWhen?: string;
  scopeEvidence?: string;
  dryRunFidelity?: "exact" | "partial" | "none";
}

/** The engine's own rule, independent of what a kind says: anything that destroys data, can lock
 * the user out, or cannot be rolled back is confirmed by a human every time. Learned preferences
 * and per-app maturity can widen autonomy for `mutate` only (Part 1's authority principle). */
export function effectiveAutoApprove(plan: OperationPlan): boolean {
  if (plan.class === "destructive" || plan.class === "lifeline" || plan.class === "forbidden" || plan.irreversible) return false;
  return plan.autoApprove;
}

/** A tracked operation's terminal outcome. `applied_unverified` is the honest third state: the
 * change reached the server (apply succeeded) but verify could not confirm it AND the operation
 * is irreversible, so nothing was rolled back - reporting "rolledback" there is a lie that made
 * the agent re-fight steps the server had already accepted (found live, run #6). */
export type OperationOutcome = "committed" | "rolledback" | "applied_unverified";

/** Fires when a repeated-failure pattern justifies a real (budgeted) LLM reflection pass, as
 * opposed to the cheap mechanical incident write that happens on every terminal operation. */
export interface ReflectionTrigger {
  kind: string;
  goal: string;
  outcome: OperationOutcome;
  message: string;
  repeatFailureCount: number;
}

// No time window - counts all-time rollbacks for this kind.
// ponytail: an old, long-resolved incident stays in the tally forever; add a sinceMs window if
// stale incidents start triggering reflection unnecessarily.
const REPEAT_FAILURE_THRESHOLD = 2;

// goal -> plan -> capture state -> prepare recovery -> apply -> verify -> commit or rollback (§38).
export interface OperationKind<P = any, S = any> {
  kind: string;
  describe(params: P): Promise<OperationPlan>;
  captureState(params: P): Promise<S>;
  apply(params: P): Promise<void>;
  verify(params: P): Promise<boolean>;
  /** Best-effort - must not throw; reconciliation and runOperation both treat a rollback failure
   * as "already in the worst case we can detect," not something to retry. */
  rollback(params: P, captured: S): Promise<void>;
  /** Prodtest (PLAN.md §5.15 A, operations/prodtest.ts): what this operation's `verify` keeps
   * checking after commit - a target key (a path, a unit, a URL) so only the LATEST committed
   * operation per target is re-verified, or null when there is nothing re-runnable (a shell
   * command with no verify). Absent: every commit is its own target. */
  prodtest?(params: P): string | null;
}

export interface OperationToolContext {
  db: Database;
  send: (event: ServerEvent) => void;
  waitForAnswer: (id: string) => Promise<string>;
  /** Secret resolution for kinds that inject a credential by reference at apply time (never in a
   * plan, never in model-visible output) - e.g. http_mutation's auth header. */
  getSecret?: (ref: string) => string | null;
  /** Secret retention for kinds that keep a value a response returns (http_mutation's
   * storeResponseField) - the value goes store-ward only, never into model-visible output. */
  setSecret?: (ref: string, value: string) => void;
  /** How long a `lifeline` operation waits for the user to confirm they are still reachable
   * before rolling itself back. Injectable for tests; defaults to LIFELINE_CONFIRM_MS. */
  lifelineConfirmMs?: number;
  /** The severity oracle (PLAN.md §5.15 A / severity.ts). Injectable for tests, which would
   * otherwise depend on this machine's real, non-deterministic systemd/docker/disk state;
   * defaults to the real live gather. */
  computeSeverity?: (db: Database) => Promise<number>;
  /** Optional: triggers a budgeted LLM reflection pass (plan §36-37). Fire-and-forget - never
   * awaited by the caller, never blocks the user-facing operation_result. */
  reflect?: (trigger: ReflectionTrigger) => void;
  /** The agent's undo-then-retry ledger (operations/retry-ledger.ts, reset per turn by
   * agent/turn-guard.ts): a plan that already rolled back this turn is refused before anything is
   * planned, and past the cap every plan is, with the trajectory to report. */
  retries?: RetryLedger;
}

export async function runOperation<P, S>(
  ctx: OperationToolContext,
  kind: OperationKind<P, S>,
  goal: string,
  params: P,
): Promise<{ outcome: OperationOutcome; message: string }> {
  const { db, send, waitForAnswer, reflect } = ctx;
  // Undo-then-retry (PLAN.md §5.15 A): an identical plan that already rolled back this turn, or
  // any plan past the turn's failure cap, is refused here - nothing planned, asked, or recorded.
  const refusal = ctx.retries?.check(kind.kind, params);
  if (refusal) return { outcome: "rolledback", message: refusal };
  const id = crypto.randomUUID();
  store.createOperation(db, id, kind.kind, goal, JSON.stringify(params));

  // Mechanical incident write on every terminal outcome that actually touched the server (i.e.
  // not user-cancellation, which never got past describe()). A real LLM reflection pass only
  // fires when a repeat-failure pattern justifies the cost (plan §36's Reflexion grounding).
  function onTerminal(outcome: "committed" | "rolledback", message: string) {
    memory.recordIncident(db, { kind: kind.kind, goal, phase: outcome, error: outcome === "rolledback" ? message : null });
    if (outcome === "rolledback") {
      ctx.retries?.record(kind.kind, params, message);
      const repeatFailureCount = store.countByKindAndPhase(db, kind.kind, "rolledback");
      if (repeatFailureCount >= REPEAT_FAILURE_THRESHOLD) {
        reflect?.({ kind: kind.kind, goal, outcome, message, repeatFailureCount });
      }
    }
  }

  const plan = await kind.describe(params);
  // Selector sanity before anything else (PLAN.md §5.15 A): a declared write scope that means
  // "everything" is refused outright - nothing planned, asked, or touched. Google's Diskerase
  // erased a CDN fleet because an empty selector was read as "all".
  const bad = badWriteScope(plan.writes);
  if (bad !== null) {
    store.setPhase(db, id, "rolledback", `refused: write scope ${JSON.stringify(bad)}`);
    const message = `Refused - ${goal}: declared write scope ${JSON.stringify(bad)} is empty, the root, or a glob; an operation must name the exact roots it writes.`;
    send({ type: "operation_result", id, outcome: "rolledback", message });
    return { outcome: "rolledback", message };
  }
  // Blast-radius gate: past the unattended budget, or right after a rollback, an otherwise
  // auto-approvable operation is downgraded to "a human must approve" - never refused.
  const gate = unattendedGate(db);
  const downgraded = effectiveAutoApprove(plan) && gate !== null;
  const autoApprove = effectiveAutoApprove(plan) && gate === null;
  store.setPlan(db, id, JSON.stringify(plan), autoApprove);
  // Scope and class ride in `details` so the client-facing protocol is unchanged.
  const details: Record<string, unknown> = { ...(plan.details ?? {}) };
  if (plan.class) details.class = plan.class;
  if (plan.writes) details.writes = plan.writes;
  if (plan.network !== undefined) details.network = plan.network;
  if (plan.irreversible) details.irreversible = true;
  if (plan.warning) details.warning = plan.warning;
  // The repair contract rides along; an undeclared fidelity is "none" - effect unknown - on purpose.
  if (plan.expects) details.expects = plan.expects;
  if (plan.rollbackWhen) details.rollbackWhen = plan.rollbackWhen;
  if (plan.scopeEvidence) details.scopeEvidence = plan.scopeEvidence;
  details.dryRunFidelity = plan.dryRunFidelity ?? "none";
  send({ type: "operation_plan", id, goal, summary: plan.summary, autoApprove, details });

  if (!autoApprove) {
    const notes = [plan.warning, plan.irreversible ? "cannot be rolled back" : undefined, downgraded ? `${gate} - a human must approve` : undefined]
      .filter(Boolean)
      .join(" - ");
    send({
      type: "question",
      id: `op_confirm:${id}`,
      prompt: `Approve: ${plan.summary}?${notes ? ` (${notes})` : ""}`,
      options: [
        { label: "Approve", value: "approve" },
        { label: "Cancel", value: "cancel" },
      ],
    });
    const answer = await waitForAnswer(`op_confirm:${id}`);
    if (answer !== "approve") {
      store.setPhase(db, id, "rolledback", "cancelled by user");
      const message = "Cancelled - nothing was changed.";
      send({ type: "operation_result", id, outcome: "rolledback", message });
      return { outcome: "rolledback", message };
    }
  }

  // From here on the operation mutates the server: hold the daemon-wide write lock until the
  // terminal outcome (writer exclusivity), including a lifeline's reachability wait - no other
  // change is stacked on top of an unconfirmed lockout-risk change.
  return withWriteLock(async () => {
    // Severity oracle (PLAN.md §5.15 A, STRATUS's TNR commit rule): the box's health just before
    // this operation touches anything - the baseline μ_post is judged against below.
    const computeSeverity = ctx.computeSeverity ?? computeSeverityLive;
    const severityBefore = await computeSeverity(db).catch(() => 0);

    store.setPhase(db, id, "capturing");
    send({ type: "operation_progress", id, phase: "capturing" });
    const captured = await kind.captureState(params);
    store.setCapturedAndApplying(db, id, JSON.stringify(captured), JSON.stringify(captured));

    send({ type: "operation_progress", id, phase: "applying" });
    try {
      await kind.apply(params);
    } catch (err) {
      // apply() may have partially succeeded (e.g. stopped but didn't restart) - attempt to restore
      // the captured state rather than leaving the system in whatever state the failure left it.
      await kind.rollback(params, captured).catch((rollbackErr) => console.error("[mirod] rollback failed", rollbackErr));
      store.setPhase(db, id, "rolledback", String(err));
      const message = `Failed to apply - ${goal}: ${String(err)}`;
      onTerminal("rolledback", message);
      send({ type: "operation_result", id, outcome: "rolledback", message });
      return { outcome: "rolledback" as const, message };
    }

    store.setPhase(db, id, "verifying");
    send({ type: "operation_progress", id, phase: "verifying" });
    const kindVerified = await kind.verify(params);
    // TNR's commit rule: a kind's own verify() can be narrowly correct (this one unit is active)
    // while missing a wider regression the same action caused elsewhere. Commit requires BOTH.
    const severityAfter = kindVerified ? await computeSeverity(db).catch(() => severityBefore) : severityBefore;
    const severityRegressed = severityAfter > severityBefore;
    const ok = kindVerified && !severityRegressed;

    if (ok) {
      // Lifeline (§39, PLAN.md §5.7 F3): a change that could lock the user out is only committed
      // once a human proves they can still reach Miro afterwards. No answer within the window -
      // because the connection died, or because nobody was there to say so - means roll back.
      // This is the classic "apply the firewall rule, then require an ack or revert" pattern; the
      // ack travels over the very path the change could have broken.
      if (plan.class === "lifeline") {
        const windowMs = ctx.lifelineConfirmMs ?? LIFELINE_CONFIRM_MS;
        send({ type: "operation_progress", id, phase: "awaiting_reachability" });
        send({
          type: "question",
          id: `lifeline_confirm:${id}`,
          prompt: `${plan.summary} applied. Are you still connected? Confirm within ${Math.round(windowMs / 1000)}s or it will be rolled back automatically.`,
          options: [
            { label: "Still here - keep it", value: "keep" },
            { label: "Roll back", value: "rollback" },
          ],
          timeoutMs: windowMs,
        });
        const answer = await Promise.race([waitForAnswer(`lifeline_confirm:${id}`), Bun.sleep(windowMs).then(() => "timeout" as const)]);
        if (answer !== "keep") {
          await kind.rollback(params, captured).catch((err) => console.error("[mirod] rollback failed", err));
          const why = answer === "timeout" ? "no reachability confirmation within the window" : "rolled back at the user's request";
          store.setPhase(db, id, "rolledback", why);
          const message = `Rolled back - ${goal}: ${why}.`;
          onTerminal("rolledback", message);
          send({ type: "operation_result", id, outcome: "rolledback", message });
          return { outcome: "rolledback" as const, message };
        }
      }
      store.setPhase(db, id, "committed");
      const message = `Done - ${goal}, verified.`;
      onTerminal("committed", message);
      send({ type: "operation_result", id, outcome: "committed", message });
      return { outcome: "committed" as const, message };
    }

    // Verify failed - either the kind's own check, or the severity oracle caught a wider
    // regression a narrowly-correct kind verify() missed (STRATUS's TNR commit rule). A reversible
    // op is restored to its captured state and honestly called "rolledback". An irreversible one
    // (a POST with no undo, a completed wizard step) already changed the server and cannot be
    // undone - its rollback() is a no-op, so "rolled back" would be a lie. Report applied_unverified
    // so the agent re-inspects instead of blindly retrying a step the server may already have
    // accepted (found live, run #6: the config and admin writes had landed, yet each was reported
    // rolled back, and the agent fought them for minutes).
    const why = !kindVerified
      ? "verification failed"
      : `the server got worse during this operation (severity ${severityBefore} -> ${severityAfter})`;
    if (!plan.irreversible) {
      await kind.rollback(params, captured).catch((err) => console.error("[mirod] rollback failed", err));
      store.setPhase(db, id, "rolledback", why);
      const message = `${!kindVerified ? "Verification failed" : "Regressed"} - ${goal}, rolled back${!kindVerified ? "" : ` (${why})`}.`;
      onTerminal("rolledback", message);
      send({ type: "operation_result", id, outcome: "rolledback", message });
      return { outcome: "rolledback" as const, message };
    }
    store.setPhase(db, id, "committed"); // it did apply; there is nothing to reconcile back
    const message = `Applied - ${goal}, but ${why} and it cannot be rolled back. Inspect the current state before retrying - the change may already be in effect.`;
    onTerminal("committed", message); // recorded as applied, not a rollback; does not trip repeat-failure
    send({ type: "operation_result", id, outcome: "applied_unverified", message });
    return { outcome: "applied_unverified" as const, message };
  });
}

/** Blast-radius limits (PLAN.md §5.15 A). Automation stays inside a budget a human can reason
 * about - Google's Diskerase and Facebook's FBAR both failed for want of exactly these. Reaching
 * a limit never refuses an operation; it downgrades it to "a human must approve" (FBAR's
 * automation → human escalation), so autonomy degrades gracefully instead of stopping dead.
 * ponytail: fixed thresholds, like every other engine constant. */
export const MAX_UNATTENDED_OPS_PER_HOUR = 10;
export const ROLLBACK_COOLDOWN_MS = 5 * 60_000;

/** Why an otherwise auto-approvable operation must ask a human right now, or null. */
function unattendedGate(db: Database): string | null {
  if (store.countAutoApprovedSince(db, Date.now() - 3_600_000) >= MAX_UNATTENDED_OPS_PER_HOUR) {
    return `unattended-operation limit reached (${MAX_UNATTENDED_OPS_PER_HOUR}/hour)`;
  }
  const last = store.lastRollbackAt(db);
  if (last !== null && Date.now() - last < ROLLBACK_COOLDOWN_MS) return "cooling down after a recent rollback";
  return null;
}

/** A declared write scope that means "everything" is never accepted: an empty entry, the root, or
 * a glob. Returns the offending entry, or null. Exported so a kind can refuse in describe() too. */
export function badWriteScope(writes: string[] | undefined): string | null {
  for (const w of writes ?? []) {
    const t = w.trim();
    if (t === "" || t === "/" || /[*?[]/.test(t)) return w;
  }
  return null;
}

/** Writer exclusivity (STRATUS's A1): one mutating operation in flight daemon-wide, from
 * captureState through its terminal outcome. The human-confirm wait stays OUTSIDE the lock, so a
 * plan awaiting approval never blocks another operation's mutation. No kind re-enters the engine
 * (verified: every call site is a top-level tool), so a non-reentrant lock cannot self-deadlock.
 * ponytail: one global lock for one server; per-resource locks only if concurrency ever matters. */
let writeLock: Promise<void> = Promise.resolve();
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 90s: long enough to read the prompt and click, short enough that a lost connection does not
 * leave a lockout in place for long. ponytail: fixed, like every other engine threshold. */
export const LIFELINE_CONFIRM_MS = 90_000;

/** Run once at boot (§47). Never retries apply() - an unknown crash point makes blind retry itself
 * dangerous; re-checking real state and rolling back to known-good is the conservative default. */
export async function reconcileOperations(db: Database, kinds: Record<string, OperationKind<any, any>>): Promise<void> {
  store.ensureOperationsTable(db);
  memory.ensureMemoryTable(db);

  for (const op of store.listByPhases(db, ["planning", "awaiting_confirmation", "capturing"])) {
    store.setPhase(db, op.id, "rolledback", "interrupted before any change was made");
    // No incident write here - nothing touched the server yet, same reasoning as user-cancellation
    // in runOperation.
  }

  for (const op of store.listByPhases(db, ["applying", "verifying"])) {
    const kind = kinds[op.kind];
    // The plan was persisted at confirm time (store.setPlan) but reconcile used to ignore it, so
    // the crash path could not honour irreversible or lifeline - the exact guarantees the durable
    // engine exists to keep (audit E1, E2).
    let plan: OperationPlan | null = null;
    try { plan = op.plan ? (JSON.parse(op.plan) as OperationPlan) : null; } catch { plan = null; }

    // Irreversible (a completed wizard step, a create with no undo): the change may have applied
    // before the crash and cannot be undone. Reporting "rolled back" is the false-rollback the
    // applied_unverified outcome was built to kill - and this op often has no rollback data, so it
    // used to fall into the rollback branch below. Mark it applied, never claim an undo (E1).
    if (plan?.irreversible) {
      let verified = false;
      try { if (kind && op.params) verified = await kind.verify(JSON.parse(op.params)); } catch { /* inconclusive */ }
      store.setPhase(db, op.id, "committed");
      memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "committed", error: null });
      if (!verified) console.warn(`[mirod] reconciled ${op.kind} (${op.goal}) as applied-unverified - irreversible, could not confirm; inspect`);
      continue;
    }

    if (!kind || !op.capturedState || !op.rollback) {
      const error = "reconciled after crash: no known kind/recovery data";
      store.setPhase(db, op.id, "rolledback", error);
      memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "rolledback", error });
      continue;
    }
    const params = JSON.parse(op.params);
    const captured = JSON.parse(op.capturedState);
    try {
      if (await kind.verify(params)) {
        // A lifeline change (a firewall/SSH edit that could lock the user out) is only committed
        // once a human confirms they can still reach Miro. That handshake cannot happen at boot, so
        // the contract-consistent action is to revert, never headless-commit a possible lockout (E2).
        if (plan?.class === "lifeline") {
          await kind.rollback(params, captured).catch(() => {});
          const error = "reconciled after crash: lifeline reachability could not be confirmed";
          store.setPhase(db, op.id, "rolledback", error);
          memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "rolledback", error });
        } else {
          store.setPhase(db, op.id, "committed");
          memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "committed", error: null });
        }
      } else {
        await kind.rollback(params, captured).catch(() => {});
        const error = "reconciled after crash: verification failed";
        store.setPhase(db, op.id, "rolledback", error);
        memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "rolledback", error });
      }
    } catch (err) {
      await kind.rollback(params, captured).catch(() => {});
      const error = `reconciled after crash: ${String(err)}`;
      store.setPhase(db, op.id, "rolledback", error);
      memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "rolledback", error });
    }
  }
}
