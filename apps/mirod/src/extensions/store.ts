import type { Database } from "bun:sqlite";

// Durable extension state (plan §33-36). Plain bun:sqlite, no ORM — same convention as
// operations/store.ts and memory/store.ts. The manifest itself (JSON) is the source of truth for
// an extension's tools/secrets; this table tracks its lifecycle (enabled/disabled) and the two
// counters that drive Dreaming's repair loop (extensions/repair.ts).

export type ExtensionState = "enabled" | "disabled";

export interface ExtensionRecord {
  app: string;
  state: ExtensionState;
  manifest: string; // JSON (ExtensionManifest)
  version: number;
  baseUrl: string;
  consecutiveFailures: number;
  repairAttempts: number;
  lastValidatedAt: number | null;
  lastError: string | null;
  successfulRuns: number;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  app: string;
  state: ExtensionState;
  manifest: string;
  version: number;
  base_url: string;
  consecutive_failures: number;
  repair_attempts: number;
  last_validated_at: number | null;
  last_error: string | null;
  successful_runs: number | null;
  created_at: number;
  updated_at: number;
}

function fromRow(row: Row): ExtensionRecord {
  return {
    app: row.app,
    state: row.state,
    manifest: row.manifest,
    version: row.version,
    baseUrl: row.base_url,
    consecutiveFailures: row.consecutive_failures,
    repairAttempts: row.repair_attempts,
    lastValidatedAt: row.last_validated_at,
    lastError: row.last_error,
    successfulRuns: row.successful_runs ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureExtensionsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS extensions (
      app TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      manifest TEXT NOT NULL,
      version INTEGER NOT NULL,
      base_url TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      repair_attempts INTEGER NOT NULL DEFAULT 0,
      last_validated_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Maturity (plan §29, PLAN.md §5.4 G): how many real calls have succeeded since the last
  // promotion. The ladder's auto-approve policy reads this; nothing infers it from the user.
  // Added defensively for databases created before the column existed (no migration framework).
  const cols = (db.query("PRAGMA table_info(extensions)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("successful_runs")) db.run("ALTER TABLE extensions ADD COLUMN successful_runs INTEGER NOT NULL DEFAULT 0");
}

/** Maturity, derived — never stored, never set by hand (plan §29). ponytail: one threshold; the
 * full DISCOVERED→UNDERSTOOD→MANAGED→LEARNED→TRUSTED ladder can refine this when a policy needs
 * the intermediate rungs. */
export const TRUSTED_AFTER_SUCCESSFUL_RUNS = 10;
export function maturityOf(record: Pick<ExtensionRecord, "successfulRuns" | "repairAttempts">): "learned" | "trusted" {
  return record.successfulRuns >= TRUSTED_AFTER_SUCCESSFUL_RUNS && record.repairAttempts === 0 ? "trusted" : "learned";
}

/** A successful generation (fresh learn OR a successful repair) always fully resets both
 * counters — the extension is known-good again either way, no separate "reset repair attempts"
 * call needed at the repair call site. */
export function promote(db: Database, app: string, manifestJson: string, version: number, baseUrl: string): void {
  const now = Date.now();
  db.run(
    `INSERT INTO extensions (app, state, manifest, version, base_url, consecutive_failures, repair_attempts, last_validated_at, last_error, successful_runs, created_at, updated_at)
     VALUES (?, 'enabled', ?, ?, ?, 0, 0, ?, NULL, 0, ?, ?)
     ON CONFLICT(app) DO UPDATE SET
       state = 'enabled', manifest = excluded.manifest, version = excluded.version, base_url = excluded.base_url,
       consecutive_failures = 0, repair_attempts = 0, last_validated_at = excluded.last_validated_at,
       last_error = NULL, successful_runs = 0, updated_at = excluded.updated_at`,
    [app, manifestJson, version, baseUrl, now, now, now],
  );
}

/** Bumped by either a real tool-call failure or a failed periodic re-probe (extensions/repair.ts)
 * — one counter, two triggers, per plan §8. */
export function recordFailure(db: Database, app: string, error: string): number {
  db.run(
    `UPDATE extensions SET consecutive_failures = consecutive_failures + 1, last_error = ?, updated_at = ? WHERE app = ?`,
    [error, Date.now(), app],
  );
  return getExtension(db, app)?.consecutiveFailures ?? 0;
}

export function recordSuccess(db: Database, app: string): void {
  db.run(
    `UPDATE extensions SET consecutive_failures = 0, successful_runs = successful_runs + 1, last_validated_at = ?, updated_at = ? WHERE app = ?`,
    [Date.now(), Date.now(), app],
  );
}

export function incrementRepairAttempts(db: Database, app: string): number {
  db.run(`UPDATE extensions SET repair_attempts = repair_attempts + 1, updated_at = ? WHERE app = ?`, [Date.now(), app]);
  return getExtension(db, app)?.repairAttempts ?? 0;
}

export function disable(db: Database, app: string, reason: string): void {
  db.run(`UPDATE extensions SET state = 'disabled', last_error = ?, updated_at = ? WHERE app = ?`, [reason, Date.now(), app]);
}

export function getExtension(db: Database, app: string): ExtensionRecord | null {
  const row = db.query("SELECT * FROM extensions WHERE app = ?").get(app) as Row | null;
  return row ? fromRow(row) : null;
}

export function listEnabled(db: Database): ExtensionRecord[] {
  const rows = db.query("SELECT * FROM extensions WHERE state = 'enabled'").all() as Row[];
  return rows.map(fromRow);
}
