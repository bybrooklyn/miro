import { createHash } from "node:crypto";

// The agent-level undo-then-retry loop (PLAN.md §5.15 A, STRATUS): the engine already restores
// s_pre on every failure; what STRATUS measured is that retrying the SAME plan from that state digs
// the hole deeper (23% mitigation with naive retry vs 69% with undo-and-retry-differently), so a
// plan is hashed and an identical retry is refused outright, and after the cap the agent must stop
// and hand the trajectory to the user instead of trying a fourth thing. One ledger per agent turn -
// agent/turn-guard.ts resets it when a prompt starts.

export interface RetryLedger {
  /** null = go ahead; otherwise the refusal to hand back to the model, nothing planned or run. */
  check(kind: string, params: unknown): string | null;
  /** A real rollback of this plan (never a user cancellation - nothing was tried). */
  record(kind: string, params: unknown, message: string): void;
  reset(): void;
}

/** Key-order-independent, so `{a,b}` and `{b,a}` are the same plan. */
export function planHash(kind: string, params: unknown): string {
  return createHash("sha256").update(`${kind}\n${stableStringify(params)}`).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function createRetryLedger(maxFailures: number): RetryLedger {
  const failed = new Map<string, { kind: string; message: string }>();
  return {
    check(kind, params) {
      const prior = failed.get(planHash(kind, params));
      if (prior) {
        return `Refused - this exact plan already failed this turn (${prior.message}). Retrying it from the restored state will fail the same way: change the plan (different command, parameters or approach), or report what is blocking you.`;
      }
      if (failed.size >= maxFailures) {
        const trajectory = [...failed.values()].map((f, i) => `${i + 1}. ${f.kind}: ${f.message}`).join("\n");
        return `Refused - ${failed.size} different plans have failed this turn, which is the limit. Stop retrying and tell the user exactly what was tried and what you need from them:\n${trajectory}`;
      }
      return null;
    },
    record(kind, params, message) {
      failed.set(planHash(kind, params), { kind, message });
    },
    reset() {
      failed.clear();
    },
  };
}
