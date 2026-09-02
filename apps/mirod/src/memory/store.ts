import type { Database } from "bun:sqlite";
import { redactSecretsInText } from "../operations/classify";

// Durable memory (plan §37). Structured facts Miro learns about the user and the server, written
// mechanically (incidents, straight from operation records) or via a real LLM reflection pass
// (preferences/patterns) — see dreaming.ts. Same conventions as operations/store.ts: plain
// bun:sqlite, no ORM, no migration framework.

export type MemoryCategory =
  | "preference"
  | "server_fact"
  | "incident"
  // Schema-ready, no write path yet — app/extension knowledge need self-extension (not built);
  // research findings need cached web search (not built).
  | "app_knowledge"
  | "extension_knowledge"
  | "research"
  // The durable operational model of a system Miro operates (PLAN.md §5.4 E): key = capability
  // or app name, value = a JSON document — summary, components, data flow, credentials by
  // reference, how to verify. What makes "Download Interstellar" a one-tool call a month later.
  | "capability";

export const WRITABLE_MEMORY_CATEGORIES = ["preference", "server_fact", "incident", "capability"] as const;

/** Shape of a `capability` memory's value (stored as JSON text). Kept loose on purpose — the
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
  source: string; // "agent_tool" | "reflection" | "mechanical:<opKind>"
  versionApplicability: string | null;
  occurrenceCount: number;
  createdAt: number;
  lastSeenAt: number;
  lastVerifiedAt: number;
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
}

/** Derived at read time from occurrenceCount, not stored — one source of truth. */
export function confidenceLabel(occurrenceCount: number): "tentative" | "noted a few times" | "confirmed" {
  if (occurrenceCount >= 4) return "confirmed";
  if (occurrenceCount >= 2) return "noted a few times";
  return "tentative";
}

/** Write or reinforce a fact. Same (category, key) increments occurrence_count and updates value;
 * a new key creates a new row. `id` stays stable across reinforcements. */
export function remember(
  db: Database,
  category: MemoryCategory,
  key: string,
  value: string,
  source: string,
  versionApplicability: string | null = null,
): MemoryRecord {
  const now = Date.now();
  // Redaction choke point: every writer routes through here, so a credential-shaped value can
  // never be persisted as a fact and re-injected into every future turn's context (audit L5).
  // Refs like `extension.jellyfin.admin_password` carry no value and pass through untouched.
  const safeValue = redactSecretsInText(value);
  db.run(
    `INSERT INTO memories (id, category, key, value, source, version_applicability, occurrence_count, created_at, last_seen_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(category, key) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       version_applicability = excluded.version_applicability,
       occurrence_count = occurrence_count + 1,
       last_seen_at = excluded.last_seen_at,
       last_verified_at = excluded.last_verified_at`,
    [crypto.randomUUID(), category, key, safeValue, source, versionApplicability, now, now, now],
  );
  return getByKey(db, category, key)!;
}

export function getByKey(db: Database, category: MemoryCategory, key: string): MemoryRecord | null {
  const row = db.query("SELECT * FROM memories WHERE category = ? AND key = ?").get(category, key) as Row | null;
  return row ? fromRow(row) : null;
}

export function query(
  db: Database,
  opts: { category?: MemoryCategory; keyword?: string; limit?: number } = {},
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
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM memories ${where} ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ?`)
    .all(...params, opts.limit ?? 20) as Row[];
  return rows.map(fromRow);
}

export function listAll(db: Database, limit = 50): MemoryRecord[] {
  const rows = db
    .query("SELECT * FROM memories ORDER BY category, occurrence_count DESC, last_seen_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(fromRow);
}

/** Top preference/server_fact rows for the always-on system-prompt summary — a hard LIMIT bounds
 * prompt growth structurally, not by convention. Excludes "reply_style" (injected separately as a
 * tone instruction, see agent/index.ts) so it isn't shown twice. */
export function topFacts(db: Database, limit = 8): MemoryRecord[] {
  const rows = db
    .query(
      `SELECT * FROM memories
       WHERE category IN ('preference', 'server_fact') AND NOT (category = 'preference' AND key = 'reply_style')
       ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
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
        summary = parts.join(" — ");
      } catch {
        /* plain text value */
      }
      return `- ${r.key}: ${summary.slice(0, 300)}`;
    });
    sections.push(`Systems you already operate (use their ext_* tools directly; memory_query category "capability" for the full model):\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/** Mechanical write for a terminal operation — no LLM, straight from the operation's own fields. */
export function recordIncident(
  db: Database,
  info: { kind: string; goal: string; phase: "committed" | "rolledback"; error: string | null },
): MemoryRecord {
  const slug = info.goal.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
  const value = info.error ? `${info.goal} — ${info.phase}: ${info.error}` : `${info.goal} — ${info.phase}`;
  return remember(db, "incident", `incident.${info.kind}.${slug}`, value, `mechanical:${info.kind}`);
}

/** Delete-only "editing" this slice — id or an id prefix (the /memory display shows short prefixes). */
export function forget(db: Database, idOrPrefix: string): number {
  const result = db.run("DELETE FROM memories WHERE id = ? OR id LIKE ?", [idOrPrefix, `${idOrPrefix}%`]);
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
