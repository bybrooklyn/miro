import type { Database } from "bun:sqlite";
import { redactSecretsInText } from "../operations/classify";

// Durable memory (plan §37). Structured facts Miro learns about the user and the server, written
// mechanically (incidents, straight from operation records) or via a real LLM reflection pass
// (preferences/patterns) - see dreaming.ts. Same conventions as operations/store.ts: plain
// bun:sqlite, no ORM, no migration framework.

export type MemoryCategory =
  | "preference"
  | "server_fact"
  | "incident"
  // Schema-ready, no write path yet - app/extension knowledge need self-extension (not built);
  // research findings need cached web search (not built).
  | "app_knowledge"
  | "extension_knowledge"
  | "research"
  // The durable operational model of a system Miro operates (PLAN.md §5.4 E): key = capability
  // or app name, value = a JSON document - summary, components, data flow, credentials by
  // reference, how to verify. What makes "Download Interstellar" a one-tool call a month later.
  | "capability";

export const WRITABLE_MEMORY_CATEGORIES = ["preference", "server_fact", "incident", "capability"] as const;

/** Shape of a `capability` memory's value (stored as JSON text). Kept loose on purpose - the
 * learn agent writes it, the main agent reads it; a graph store waits for a query this can't answer. */
export interface CapabilityDoc {
  summary: string;
  components?: { name: string; role: string; interface?: string; baseUrl?: string }[];
  dataFlow?: string[];
  credentials?: string[]; // secret refs, never values
  verify?: string[];
  notes?: string[];
}

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  source: string; // "agent_tool" | "reflection" | "mechanical:<opKind>" | "discovery" | ...
  versionApplicability: string | null;
  occurrenceCount: number;
  createdAt: number;
  lastSeenAt: number;
  lastVerifiedAt: number;
  /** Outcome feedback (PLAN.md §5.15 B, after "memory propagates errors unless outcomes feed back
   * as labels"): incremented when an operation/decision that relied on this fact/recipe committed
   * cleanly, or failed its verify. Neither is inferred automatically yet - see bumpHelpful/
   * bumpHarmful; the caller (an operation kind, a recipe consumer) decides which memory row it
   * actually used. Retrieval scoring stays occurrence-count-based; these are a signal for Dreaming
   * to demote a row whose harmful count wins, not (yet) folded into confidenceLabel. */
  helpfulCount: number;
  harmfulCount: number;
  /** When this row stops being surfaced by query()/listAll() (still queryable with
   * includeExpired). Null = never. No category has a default policy assigned yet - deliberately
   * deferred (PLAN.md §5.15 B names "incidents short-lived; facts/recipes tied to app_version" as
   * the intent, not yet a decided set of durations). */
  expiresAt: number | null;
  /** When the underlying fact was actually observed/verified against the real system - distinct
   * from createdAt/lastSeenAt, which track this ROW's own bookkeeping lifecycle, not the fact's
   * currency. Null when a writer hasn't supplied one (most callers today). */
  observedAt: number | null;
  /** The app/extension version this fact or capability was observed against, when known - lets a
   * reprobe recognize "this was true for v3, the app is now v4" instead of trusting stale facts
   * silently (PLAN.md §5.15 B's "verifier drift" finding). */
  appVersion: string | null;
  /** The id of a newer memory row that supersedes this one, when a contradiction was kept rather
   * than silently overwritten. Null for the normal case. Nothing writes this yet - the "is this
   * genuinely a contradiction or just a routine reinforcement of the same fact" judgment call is
   * deliberately not decided here; the column exists so that decision doesn't also require a schema
   * migration once it is made. */
  supersededBy: string | null;
}

interface Row {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  source: string;
  version_applicability: string | null;
  occurrence_count: number;
  created_at: number;
  last_seen_at: number;
  last_verified_at: number;
  helpful_count: number;
  harmful_count: number;
  expires_at: number | null;
  observed_at: number | null;
  app_version: string | null;
  superseded_by: string | null;
}

function fromRow(row: Row): MemoryRecord {
  return {
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    source: row.source,
    versionApplicability: row.version_applicability,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastVerifiedAt: row.last_verified_at,
    helpfulCount: row.helpful_count,
    harmfulCount: row.harmful_count,
    expiresAt: row.expires_at,
    observedAt: row.observed_at,
    appVersion: row.app_version,
    supersededBy: row.superseded_by,
  };
}

export function ensureMemoryTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL,
      version_applicability TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_verified_at INTEGER NOT NULL,
      UNIQUE(category, key)
    )
  `);
  // Added defensively for databases created before these columns existed (no migration framework
  // yet - PLAN.md §5.16 decided a real one, not built; this ad-hoc guard is today's established
  // convention, matching extensions/store.ts's successful_runs column).
  const cols = (db.query("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name);
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.run(`ALTER TABLE memories ADD COLUMN ${ddl}`);
  };
  addColumn("helpful_count", "helpful_count INTEGER NOT NULL DEFAULT 0");
  addColumn("harmful_count", "harmful_count INTEGER NOT NULL DEFAULT 0");
  addColumn("expires_at", "expires_at INTEGER");
  addColumn("observed_at", "observed_at INTEGER");
  addColumn("app_version", "app_version TEXT");
  addColumn("superseded_by", "superseded_by TEXT");
}

/** Derived at read time from occurrenceCount, not stored - one source of truth. */
export function confidenceLabel(occurrenceCount: number): "tentative" | "noted a few times" | "confirmed" {
  if (occurrenceCount >= 4) return "confirmed";
  if (occurrenceCount >= 2) return "noted a few times";
  return "tentative";
}

/** Write or reinforce a fact. Same (category, key) increments occurrence_count and updates value;
 * a new key creates a new row. `id` stays stable across reinforcements. `expiresAt`/`observedAt`/
 * `appVersion` are optional provenance (PLAN.md §5.15 B) - no category assigns a default policy
 * yet, so omitting them (every existing call site) preserves today's never-expires behavior
 * exactly. Re-remembering with `expiresAt: null` (the default) clears a previously-set expiry,
 * matching how `excluded.value` already overwrites on every reinforcement. */
export function remember(
  db: Database,
  category: MemoryCategory,
  key: string,
  value: string,
  source: string,
  versionApplicability: string | null = null,
  opts: { expiresAt?: number | null; observedAt?: number | null; appVersion?: string | null } = {},
): MemoryRecord {
  const now = Date.now();
  // Redaction choke point: every writer routes through here, so a credential-shaped value can
  // never be persisted as a fact and re-injected into every future turn's context (audit L5).
  // Refs like `extension.jellyfin.admin_password` carry no value and pass through untouched.
  const safeValue = redactSecretsInText(value);
  db.run(
    `INSERT INTO memories (id, category, key, value, source, version_applicability, occurrence_count, created_at, last_seen_at, last_verified_at, expires_at, observed_at, app_version)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(category, key) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       version_applicability = excluded.version_applicability,
       occurrence_count = occurrence_count + 1,
       last_seen_at = excluded.last_seen_at,
       last_verified_at = excluded.last_verified_at,
       expires_at = excluded.expires_at,
       observed_at = excluded.observed_at,
       app_version = excluded.app_version`,
    [
      crypto.randomUUID(),
      category,
      key,
      safeValue,
      source,
      versionApplicability,
      now,
      now,
      now,
      opts.expiresAt ?? null,
      opts.observedAt ?? null,
      opts.appVersion ?? null,
    ],
  );
  return getByKey(db, category, key)!;
}

/** Outcome feedback (PLAN.md §5.15 B): the caller decides which memory row a committed
 * operation/decision actually relied on - nothing infers this automatically yet. */
export function bumpHelpful(db: Database, id: string): void {
  db.run("UPDATE memories SET helpful_count = helpful_count + 1 WHERE id = ?", [id]);
}

/** Outcome feedback (PLAN.md §5.15 B): a verify() failure on a recipe/fact-guided operation
 * decrements confidence in the row that guided it, distinct from occurrence_count (which only
 * ever reinforces - it means "seen again", not "worked again"). */
export function bumpHarmful(db: Database, id: string): void {
  db.run("UPDATE memories SET harmful_count = harmful_count + 1 WHERE id = ?", [id]);
}

export function getByKey(db: Database, category: MemoryCategory, key: string): MemoryRecord | null {
  const row = db.query("SELECT * FROM memories WHERE category = ? AND key = ?").get(category, key) as Row | null;
  return row ? fromRow(row) : null;
}

/** A row past its expires_at is excluded by default (PLAN.md §5.15 B) - it stops being surfaced to
 * the model/UI without being deleted. `includeExpired` opts back in (a debug/audit view). Nothing
 * sets expires_at yet, so this clause is a no-op today and only takes effect once a category is
 * given a real policy. */
function notExpiredClause(now: number, includeExpired: boolean | undefined): { sql: string; param: number | null } {
  if (includeExpired) return { sql: "", param: null };
  return { sql: "(expires_at IS NULL OR expires_at > ?)", param: now };
}

export function query(
  db: Database,
  opts: { category?: MemoryCategory; keyword?: string; limit?: number; includeExpired?: boolean } = {},
): MemoryRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.category) {
    clauses.push("category = ?");
    params.push(opts.category);
  }
  if (opts.keyword) {
    clauses.push("(key LIKE ? OR value LIKE ?)");
    params.push(`%${opts.keyword}%`, `%${opts.keyword}%`);
  }
  const expiry = notExpiredClause(Date.now(), opts.includeExpired);
  if (expiry.sql) {
    clauses.push(expiry.sql);
    params.push(expiry.param!);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM memories ${where} ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ?`)
    .all(...params, opts.limit ?? 20) as Row[];
  return rows.map(fromRow);
}

export function listAll(db: Database, limit = 50): MemoryRecord[] {
  const expiry = notExpiredClause(Date.now(), false);
  const rows = db
    .query(`SELECT * FROM memories WHERE ${expiry.sql} ORDER BY category, occurrence_count DESC, last_seen_at DESC LIMIT ?`)
    .all(expiry.param, limit) as Row[];
  return rows.map(fromRow);
}

/** Top preference/server_fact rows for the always-on system-prompt summary - a hard LIMIT bounds
 * prompt growth structurally, not by convention. Excludes "reply_style" (injected separately as a
 * tone instruction, see agent/index.ts) so it isn't shown twice. */
export function topFacts(db: Database, limit = 8): MemoryRecord[] {
  const expiry = notExpiredClause(Date.now(), false);
  const rows = db
    .query(
      `SELECT * FROM memories
       WHERE category IN ('preference', 'server_fact') AND NOT (category = 'preference' AND key = 'reply_style')
         AND ${expiry.sql}
       ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ?`,
    )
    .all(expiry.param, limit) as Row[];
  return rows.map(fromRow);
}

export function buildSummary(db: Database): string {
  const rows = topFacts(db);
  const sections: string[] = [];
  if (rows.length > 0) {
    const lines = rows.map((r) => `- ${r.value} (${confidenceLabel(r.occurrenceCount)})`);
    sections.push(`What you've learned about this user and server so far:\n${lines.join("\n")}`);
  }
  const caps = query(db, { category: "capability", limit: 8 });
  if (caps.length > 0) {
    const lines = caps.map((r) => {
      let summary = r.value;
      try {
        const doc = JSON.parse(r.value) as CapabilityDoc;
        const parts = [doc.summary];
        if (doc.components?.length) parts.push(`components: ${doc.components.map((c) => c.name).join(", ")}`);
        summary = parts.join(" - ");
      } catch {
        /* plain text value */
      }
      return `- ${r.key}: ${summary.slice(0, 300)}`;
    });
    sections.push(`Systems you already operate (use their ext_* tools directly; memory_query category "capability" for the full model):\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/** Mechanical write for a terminal operation - no LLM, straight from the operation's own fields. */
export function recordIncident(
  db: Database,
  info: { kind: string; goal: string; phase: "committed" | "rolledback" | "drift"; error: string | null },
): MemoryRecord {
  const slug = info.goal.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
  const value = info.error ? `${info.goal} - ${info.phase}: ${info.error}` : `${info.goal} - ${info.phase}`;
  return remember(db, "incident", `incident.${info.kind}.${slug}`, value, `mechanical:${info.kind}`);
}

/** Delete-only "editing" this slice - id or an id prefix (the /memory display shows short prefixes).
 * The prefix goes into a LIKE, so `%`/`_` must be escaped or `/memory forget %` (or an empty arg,
 * building the pattern `%`) would wipe every memory - preferences, facts, and the learned
 * capability documents - with no undo (audit D1). */
export function forget(db: Database, idOrPrefix: string): number {
  const trimmed = idOrPrefix.trim();
  if (trimmed === "") return 0; // never match-all on an empty argument
  const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
  const result = db.run(`DELETE FROM memories WHERE id = ? OR id LIKE ? ESCAPE '\\'`, [trimmed, `${escaped}%`]);
  return result.changes;
}

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "Preferences",
  server_fact: "Server facts",
  incident: "Incidents",
  app_knowledge: "App knowledge",
  extension_knowledge: "Extension knowledge",
  research: "Research",
  capability: "Systems you operate",
};

export function formatForDisplay(records: MemoryRecord[]): string {
  if (records.length === 0) return "Nothing remembered yet.";
  const byCategory = new Map<MemoryCategory, MemoryRecord[]>();
  for (const r of records) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  const sections = [...byCategory.entries()].map(([category, rows]) => {
    const lines = rows.map((r) => `  ${r.id.slice(0, 8)}  ${r.value} (${confidenceLabel(r.occurrenceCount)})`);
    return `${CATEGORY_LABELS[category]}:\n${lines.join("\n")}`;
  });
  return `${sections.join("\n\n")}\n\n/memory forget <id> to remove one.`;
}
