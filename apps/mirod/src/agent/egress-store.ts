import type { Database } from "bun:sqlite";
import type { Context, Model } from "@miro/model-client";
import { gateEgress, type EgressAudit } from "./egress";

// The egress audit trail (PLAN.md §2367): what sensitivity left for which provider, and what was
// redacted - never the content itself. Plain bun:sqlite in the operations/store.ts shape.

export function ensureEgressTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS egress_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    trust TEXT NOT NULL,
    content_tier TEXT NOT NULL,
    secret_redacted INTEGER NOT NULL,
    infra_redacted INTEGER NOT NULL,
    redacted_types TEXT NOT NULL
  )`);
}

// ponytail: a bounded trail - keep the last CAP rows, pruned on insert (id is the PK, so the delete
// is an index range). Raise it, or archive off, if a longer audit history is ever needed.
const CAP = 5000;

export function recordEgress(db: Database, a: EgressAudit): void {
  db.run(
    "INSERT INTO egress_audit (at, provider, trust, content_tier, secret_redacted, infra_redacted, redacted_types) VALUES (?,?,?,?,?,?,?)",
    [Date.now(), a.provider, a.trust, a.contentTier, a.secretRedacted ? 1 : 0, a.infraRedacted, JSON.stringify(a.redactedTypes)],
  );
  db.run("DELETE FROM egress_audit WHERE id <= (SELECT MAX(id) - ? FROM egress_audit)", [CAP]);
}

export interface EgressGateDeps {
  db?: Database;
  getSetting?: (k: string) => string | null;
}

/** Build the transformProviderContext hook agent-core calls before every provider stream: scrub the
 * outbound context to the provider's tier and record the sensitivity-bearing egresses (a purely
 * public egress with nothing redacted is not logged - ponytail: flip to log-all for a full trail).
 * Shared by the chat, worker, and learn agents. A missing db/getSetting still scrubs, with defaults. */
export function egressGate(deps: EgressGateDeps | undefined): (context: Context, model: Model) => Context {
  const getSetting = deps?.getSetting ?? (() => null);
  const db = deps?.db;
  return (context, model) => {
    const { context: scrubbed, audit } = gateEgress(context, model, getSetting);
    if (db && (audit.secretRedacted || audit.infraRedacted > 0 || audit.contentTier !== "public")) recordEgress(db, audit);
    return scrubbed;
  };
}
