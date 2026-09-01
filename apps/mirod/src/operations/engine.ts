import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import * as store from "./store";
import * as memory from "../memory/store";
import type { CommandClass } from "./classify";

export interface OperationPlan {
  summary: string;
  autoApprove: boolean;
  details?: Record<string, unknown>;
  /** From the classifier or the kind's own judgement (PLAN.md §5.7). `destructive` and `lifeline`
   * never auto-approve — the engine enforces that below, whatever the kind asked for. */
  class?: CommandClass;
  /** The sandbox scope this operation runs under: declared writable roots and whether the network
   * is shared. Shown to the user in the plan, enforced by the kernel (operations/sandbox.ts). */
  writes?: string[];
  network?: boolean;
  /** No rollback is possible (e.g. completing a setup wizard). Always confirmed, with a warning. */
  irreversible?: boolean;
  warning?: string;
}

/** The engine's own rule, independent of what a kind says: anything that destroys data, can lock
 * the user out, or cannot be rolled back is confirmed by a human every time. Learned preferences
 * and per-app maturity can widen autonomy for `mutate` only (Part 1's authority principle). */
export function effectiveAutoApprove(plan: OperationPlan): boolean {
  if (plan.class === "destructive" || plan.class === "lifeline" || plan.class === "forbidden" || plan.irreversible) return false;
  return plan.autoApprove;
}

/** Fires when a repeated-failure pattern justifies a real (budgeted) LLM reflection pass, as
 * opposed to the cheap mechanical incident write that happens on every terminal operation. */
export interface ReflectionTrigger {
  kind: string;
  goal: string;
  outcome: "committed" | "rolledback";
  message: string;
  repeatFailureCount: number;
}

// No time window — counts all-time rollbacks for this kind.
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
  /** Best-effort — must not throw; reconciliation and runOperation both treat a rollback failure
   * as "already in the worst case we can detect," not something to retry. */
  rollback(params: P, captured: S): Promise<void>;
}

export interface OperationToolContext {
  db: Database;
  send: (event: ServerEvent) => void;
  waitForAnswer: (id: string) => Promise<string>;
  /** Secret resolution for kinds that inject a credential by reference at apply time (never in a
   * plan, never in model-visible output) — e.g. http_mutation's auth header. */
  getSecret?: (ref: string) => string | null;
  /** How long a `lifeline` operation waits for the user to confirm they are still reachable
   * before rolling itself back. Injectable for tests; defaults to LIFELINE_CONFIRM_MS. */
  lifelineConfirmMs?: number;
  /** Optional: triggers a budgeted LLM reflection pass (plan §36-37). Fire-and-forget — never
   * awaited by the caller, never blocks the user-facing operation_result. */
  reflect?: (trigger: ReflectionTrigger) => void;
}

export async function runOperation<P, S>(
  ctx: OperationToolContext,
  kind: OperationKind<P, S>,
  goal: string,
  params: P,
): Promise<{ outcome: "committed" | "rolledback"; message: string }> {
  const { db, send, waitForAnswer, reflect } = ctx;
  const id = crypto.randomUUID();
  store.createOperation(db, id, kind.kind, goal, JSON.stringify(params));

  // Mechanical incident write on every terminal outcome that actually touched the server (i.e.
  // not user-cancellation, which never got past describe()). A real LLM reflection pass only
  // fires when a repeat-failure pattern justifies the cost (plan §36's Reflexion grounding).
  function onTerminal(outcome: "committed" | "rolledback", message: string) {
    memory.recordIncident(db, { kind: kind.kind, goal, phase: outcome, error: outcome === "rolledback" ? message : null });
    if (outcome === "rolledback") {
      const repeatFailureCount = store.countByKindAndPhase(db, kind.kind, "rolledback");
      if (repeatFailureCount >= REPEAT_FAILURE_THRESHOLD) {
        reflect?.({ kind: kind.kind, goal, outcome, message, repeatFailureCount });
      }
    }
  }

  const plan = await kind.describe(params);
  const autoApprove = effectiveAutoApprove(plan);
  store.setPlan(db, id, JSON.stringify(plan), autoApprove);
  // Scope and class ride in `details` so the client-facing protocol is unchanged.
  const details: Record<string, unknown> = { ...(plan.details ?? {}) };
  if (plan.class) details.class = plan.class;
  if (plan.writes) details.writes = plan.writes;
  if (plan.network !== undefined) details.network = plan.network;
  if (plan.irreversible) details.irreversible = true;
  if (plan.warning) details.warning = plan.warning;
  send({ type: "operation_plan", id, goal, summary: plan.summary, autoApprove, details: Object.keys(details).length > 0 ? details : null });

  if (!autoApprove) {
    const notes = [plan.warning, plan.irreversible ? "cannot be rolled back" : undefined].filter(Boolean).join(" — ");
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
      const message = "Cancelled — nothing was changed.";
      send({ type: "operation_result", id, outcome: "rolledback", message });
      return { outcome: "rolledback", message };
    }
  }

  store.setPhase(db, id, "capturing");
  send({ type: "operation_progress", id, phase: "capturing" });
  const captured = await kind.captureState(params);
  store.setCapturedAndApplying(db, id, JSON.stringify(captured), JSON.stringify(captured));

  send({ type: "operation_progress", id, phase: "applying" });
  try {
    await kind.apply(params);
  } catch (err) {
    // apply() may have partially succeeded (e.g. stopped but didn't restart) — attempt to restore
    // the captured state rather than leaving the system in whatever state the failure left it.
    await kind.rollback(params, captured).catch((rollbackErr) => console.error("[mirod] rollback failed", rollbackErr));
    store.setPhase(db, id, "rolledback", String(err));
    const message = `Failed to apply — ${goal}: ${String(err)}`;
    onTerminal("rolledback", message);
    send({ type: "operation_result", id, outcome: "rolledback", message });
    return { outcome: "rolledback", message };
  }

  store.setPhase(db, id, "verifying");
  send({ type: "operation_progress", id, phase: "verifying" });
  const ok = await kind.verify(params);

  if (ok) {
    // Lifeline (§39, PLAN.md §5.7 F3): a change that could lock the user out is only committed
    // once a human proves they can still reach Miro afterwards. No answer within the window —
    // because the connection died, or because nobody was there to say so — means roll back.
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
          { label: "Still here — keep it", value: "keep" },
          { label: "Roll back", value: "rollback" },
        ],
        timeoutMs: windowMs,
      });
      const answer = await Promise.race([waitForAnswer(`lifeline_confirm:${id}`), Bun.sleep(windowMs).then(() => "timeout" as const)]);
      if (answer !== "keep") {
        await kind.rollback(params, captured).catch((err) => console.error("[mirod] rollback failed", err));
        const why = answer === "timeout" ? "no reachability confirmation within the window" : "rolled back at the user's request";
        store.setPhase(db, id, "rolledback", why);
        const message = `Rolled back — ${goal}: ${why}.`;
        onTerminal("rolledback", message);
        send({ type: "operation_result", id, outcome: "rolledback", message });
        return { outcome: "rolledback", message };
      }
    }
    store.setPhase(db, id, "committed");
    const message = `Done — ${goal}, verified.`;
    onTerminal("committed", message);
    send({ type: "operation_result", id, outcome: "committed", message });
    return { outcome: "committed", message };
  }

  await kind.rollback(params, captured).catch((err) => console.error("[mirod] rollback failed", err));
  store.setPhase(db, id, "rolledback", "verification failed");
  const message = `Verification failed — ${goal}, rolled back.`;
  onTerminal("rolledback", message);
  send({ type: "operation_result", id, outcome: "rolledback", message });
  return { outcome: "rolledback", message };
}

/** 90s: long enough to read the prompt and click, short enough that a lost connection does not
 * leave a lockout in place for long. ponytail: fixed, like every other engine threshold. */
export const LIFELINE_CONFIRM_MS = 90_000;

/** Run once at boot (§47). Never retries apply() — an unknown crash point makes blind retry itself
 * dangerous; re-checking real state and rolling back to known-good is the conservative default. */
export async function reconcileOperations(db: Database, kinds: Record<string, OperationKind<any, any>>): Promise<void> {
  store.ensureOperationsTable(db);
  memory.ensureMemoryTable(db);

  for (const op of store.listByPhases(db, ["planning", "awaiting_confirmation", "capturing"])) {
    store.setPhase(db, op.id, "rolledback", "interrupted before any change was made");
    // No incident write here — nothing touched the server yet, same reasoning as user-cancellation
    // in runOperation.
  }

  for (const op of store.listByPhases(db, ["applying", "verifying"])) {
    const kind = kinds[op.kind];
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
        store.setPhase(db, op.id, "committed");
        memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "committed", error: null });
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
