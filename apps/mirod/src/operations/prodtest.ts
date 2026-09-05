import type { Database } from "bun:sqlite";
import * as store from "./store";
import * as memory from "../memory/store";
import { isLifelinePath, LIFELINE_UNITS } from "./classify";
import { notify } from "../notifications";
import type { OperationKind } from "./engine";

// Prodtest per repair (PLAN.md §5.15 A, after Google's Prodtest: a test paired with an idempotent
// fix, because "automation dies when nobody keeps it in sync"). Every committed operation already
// carries a re-runnable, read-only `verify` - the exact check that proved it worked. Dreaming's idle
// pass re-runs the latest one per target; a check that no longer passes is DRIFT: something Miro
// set up has been undone or has decayed. Drift is surfaced as an incident (reinforced on every
// recurrence, so the agent sees "seen N times" in its context) and never re-applied on its own -
// escalation, not a retry, is the whole point.

export interface DriftReport {
  checked: number;
  drifted: { id: string; kind: string; goal: string }[];
}

/** Read-only by contract: every kind's verify observes, never changes (a shell verify runs in a
 * read-only sandbox). `limit` bounds how far back the scan looks. */
export async function reverifyCommitted(db: Database, kinds: Record<string, OperationKind<any, any>>, limit = 200): Promise<DriftReport> {
  const latestPerTarget = new Map<string, store.OperationRecord>();
  for (const op of store.listCommitted(db, limit)) {
    const kind = kinds[op.kind];
    if (!kind) continue;
    let params: unknown;
    try {
      params = JSON.parse(op.params);
    } catch {
      continue; // one unreadable row must not end the sweep for every other (audit B4)
    }
    // A target key is shared ACROSS kinds on purpose: file.write and file.delete of the same path,
    // or a restart and a stop of the same unit, describe one thing's latest intended state - the
    // newest wins. Keyed by kind as well, a trashed-then-rewritten path was a permanent false
    // drift (audit A14). A kind with no prodtest is its own target per operation.
    let key: string;
    if (kind.prodtest) {
      const target = kind.prodtest(params);
      if (target === null) continue;
      key = target;
    } else {
      key = `${op.kind} ${op.params}`;
    }
    if (!latestPerTarget.has(key)) latestPerTarget.set(key, op); // newest first, so first wins
  }

  const report: DriftReport = { checked: 0, drifted: [] };
  for (const op of latestPerTarget.values()) {
    report.checked++;
    const ok = await Promise.resolve()
      .then(() => kinds[op.kind]!.verify(JSON.parse(op.params)))
      .catch(() => false);
    if (ok) continue;
    report.drifted.push({ id: op.id, kind: op.kind, goal: op.goal });
    const incident = memory.recordIncident(db, { kind: op.kind, goal: op.goal, phase: "drift", error: `no longer verifies (committed ${new Date(op.updatedAt).toISOString().slice(0, 10)})` });
    // Notify only on the FIRST sighting of a given drift (occurrenceCount === 1); a recurring drift
    // reinforces the incident silently, so the phone is not buzzed every 24h sweep. Drift on a
    // lifeline target (SSH/firewall/network/Miro) needs attention; other drift is worth knowing.
    if (incident.occurrenceCount === 1) {
      notify({
        tier: driftTouchesLifeline(op.kind, op.params) ? "needs_attention" : "worth_knowing",
        title: `Drift: "${op.goal}" no longer holds`,
        body: "Something Miro set up has been undone or has decayed. It is not re-applied on its own.",
        source: "drift",
        at: Date.now(),
      });
    }
  }
  return report;
}

/** Whether a drifted operation touched a lifeline target - the SSH/firewall/network/Miro surfaces
 * whose decay the owner must hear about at once. Derived from the op's own params, the same fields
 * the systemd and file kinds carry. */
function driftTouchesLifeline(kind: string, paramsJson: string): boolean {
  try {
    const p = JSON.parse(paramsJson) as { unit?: string; path?: string };
    if (typeof p.unit === "string" && LIFELINE_UNITS.test(p.unit)) return true;
    if (typeof p.path === "string" && isLifelinePath(p.path)) return true;
  } catch {
    // unreadable params - treat as ordinary drift, the same conservative default reverify uses
  }
  return false;
}
