import type { Database } from "bun:sqlite";
import type { Context, Model, AssistantMessage } from "@miro/model-client";
import { gateEgress, restoreText, type EgressAudit } from "./egress";

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

/** When "true", EVERY egress is recorded, not only the sensitivity-bearing ones - the full trail the
 * owner needs to answer "show me exactly what left" (PLAN.md private-by-default pillar). */
export const EGRESS_LOG_ALL_SETTING = "egress.log_all";

export interface EgressRow {
  at: number;
  provider: string;
  trust: string;
  contentTier: string;
  secretRedacted: boolean;
  infraRedacted: number;
  redactedTypes: string[];
}

/** The audit trail, newest first - the read side the table never had (it was write-only). Never holds
 * content, only what left, to whom, at what trust, and what was scrubbed. */
export function recentEgress(db: Database, limit = 50): EgressRow[] {
  const rows = db.query("SELECT at, provider, trust, content_tier, secret_redacted, infra_redacted, redacted_types FROM egress_audit ORDER BY id DESC LIMIT ?").all(limit) as {
    at: number;
    provider: string;
    trust: string;
    content_tier: string;
    secret_redacted: number;
    infra_redacted: number;
    redacted_types: string;
  }[];
  return rows.map((r) => ({
    at: r.at,
    provider: r.provider,
    trust: r.trust,
    contentTier: r.content_tier,
    secretRedacted: r.secret_redacted === 1,
    infraRedacted: r.infra_redacted,
    redactedTypes: ((): string[] => {
      try {
        return JSON.parse(r.redacted_types);
      } catch {
        return [];
      }
    })(),
  }));
}

export interface EgressGateDeps {
  db?: Database;
  getSetting?: (k: string) => string | null;
}

export interface EgressHooks {
  /** Scrub the outbound context before every provider stream (agent-core `transformProviderContext`). */
  transformProviderContext: (context: Context, model: Model) => Context;
  /** De-anonymise the model's finalized reply (agent-core `transformAssistantMessage`) - the round-trip's
   * return leg. Mutates in place, before the reply reaches context/UI/tool dispatch. */
  transformAssistantMessage: (message: AssistantMessage) => void;
}

/** Build both egress hooks agent-core calls, sharing one round-trip map. The outbound hook scrubs the
 * context to the provider's tier (reversible tokens for a public provider), records sensitivity-bearing
 * egresses (a purely public egress with nothing redacted is not logged - ponytail: flip to log-all for a
 * full trail), and may THROW to refuse (strict block mode). The response hook restores the tokens. Shared
 * by the chat, worker, and learn agents. A missing db/getSetting still scrubs, with defaults. */
export function egressHooks(deps: EgressGateDeps | undefined): EgressHooks {
  const getSetting = deps?.getSetting ?? (() => null);
  const db = deps?.db;
  // Populated by the outbound hook, consumed by the response hook. The per-Agent loop is sequential
  // (outbound -> response), so replacing it on each outbound is collision-free; a side-request that
  // shares only the outbound hook is cleaned up by the next outbound's replacement.
  let restore: Map<string, string> | null = null;
  return {
    transformProviderContext: (context, model) => {
      const { context: scrubbed, audit, restore: r } = gateEgress(context, model, getSetting, { roundTrip: true });
      restore = r && r.size ? r : null;
      const logAll = getSetting(EGRESS_LOG_ALL_SETTING) === "true";
      if (db && (logAll || audit.secretRedacted || audit.infraRedacted > 0 || audit.contentTier !== "public")) recordEgress(db, audit);
      return scrubbed;
    },
    transformAssistantMessage: (message) => {
      if (restore) restoreInMessage(message, restore);
    },
  };
}

/** Restore reversible tokens back to identifiers in a finalized assistant reply, in place. */
function restoreInMessage(message: AssistantMessage, restore: Map<string, string>): void {
  const m = message as { content: unknown };
  if (typeof m.content === "string") {
    m.content = restoreText(m.content, restore);
    return;
  }
  if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
        (p as { text: string }).text = restoreText((p as { text: string }).text, restore);
      }
    }
  }
}
