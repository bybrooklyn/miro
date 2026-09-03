import type { Database } from "bun:sqlite";

// Durable operation tracking (plan §38, §47). Every meaningful mutation is a row here, its phase
// transitions durable via SQLite WAL, so a crash mid-operation can be reconciled on next startup
// instead of leaving unknown state behind.

export type OperationPhase =
  | "planning"
  | "awaiting_confirmation"
  | "capturing"
  | "applying"
  | "verifying"
  | "committed"
  | "rolledback";

export interface OperationRecord {
  id: string;
  kind: string;
  goal: string;
  params: string; // JSON
  phase: OperationPhase;
  autoApprove: boolean;
  plan: string | null; // JSON
  capturedState: string | null; // JSON
  rollback: string | null; // JSON
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  kind: string;
  goal: string;
  params: string;
  phase: OperationPhase;
  auto_approve: number;
  plan: string | null;
  captured_state: string | null;
  rollback: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow(row: Row): OperationRecord {
  return {
    id: row.id,
    kind: row.kind,
    goal: row.goal,
    params: row.params,
    phase: row.phase,
    autoApprove: row.auto_approve === 1,
    plan: row.plan,
    capturedState: row.captured_state,
    rollback: row.rollback,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureOperationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      goal TEXT NOT NULL,
      params TEXT NOT NULL,
      phase TEXT NOT NULL,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      plan TEXT,
      captured_state TEXT,
      rollback TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export function createOperation(db: Database, id: string, kind: string, goal: string, paramsJson: string): void {
  const now = Date.now();
  db.run(
    `INSERT INTO operations (id, kind, goal, params, phase, auto_approve, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'planning', 0, ?, ?)`,
    [id, kind, goal, paramsJson, now, now],
  );
}

export function setPlan(db: Database, id: string, planJson: string, autoApprove: boolean): void {
  db.run(`UPDATE operations SET plan = ?, auto_approve = ?, phase = 'awaiting_confirmation', updated_at = ? WHERE id = ?`, [
    planJson,
    autoApprove ? 1 : 0,
    Date.now(),
    id,
  ]);
}

/** The one transition that matters for crash safety: captured_state, rollback, and phase='applying'
 * all land in a single atomic UPDATE, so phase='capturing' on disk always means nothing was
 * captured yet — reconciliation never has to guess about a partial capture. */
export function setCapturedAndApplying(db: Database, id: string, capturedStateJson: string, rollbackJson: string): void {
  db.run(`UPDATE operations SET captured_state = ?, rollback = ?, phase = 'applying', updated_at = ? WHERE id = ?`, [
    capturedStateJson,
    rollbackJson,
    Date.now(),
    id,
  ]);
}

export function setPhase(db: Database, id: string, phase: OperationPhase, error: string | null = null): void {
  db.run(`UPDATE operations SET phase = ?, error = ?, updated_at = ? WHERE id = ?`, [phase, error, Date.now(), id]);
}

export function getOperation(db: Database, id: string): OperationRecord | null {
  const row = db.query("SELECT * FROM operations WHERE id = ?").get(id) as Row | null;
  return row ? fromRow(row) : null;
}

export function listByPhases(db: Database, phases: OperationPhase[]): OperationRecord[] {
  const placeholders = phases.map(() => "?").join(",");
  const rows = db.query(`SELECT * FROM operations WHERE phase IN (${placeholders})`).all(...phases) as Row[];
  return rows.map(fromRow);
}

export function countByKindAndPhase(db: Database, kind: string, phase: OperationPhase): number {
  const row = db.query("SELECT COUNT(*) as n FROM operations WHERE kind = ? AND phase = ?").get(kind, phase) as { n: number };
  return row.n;
}

/** Auto-approved (unattended) operations created since `sinceMs` — the input to the engine's
 * blast-radius rate limit. An auto-approved op has no cancel path, so every row counts as one
 * that ran with no human in the loop. */
export function countAutoApprovedSince(db: Database, sinceMs: number): number {
  const row = db.query("SELECT COUNT(*) as n FROM operations WHERE auto_approve = 1 AND created_at >= ?").get(sinceMs) as { n: number };
  return row.n;
}

/** When the last REAL rollback happened — a change was made and then undone. A user cancellation
 * and a crash-interruption before any change both land in phase 'rolledback' but touched nothing,
 * so they never count. null if there has been none. */
export function lastRollbackAt(db: Database): number | null {
  const row = db
    .query(
      `SELECT MAX(updated_at) AS t FROM operations
       WHERE phase = 'rolledback'
         AND (error IS NULL OR (error NOT LIKE 'cancelled by user%' AND error NOT LIKE 'interrupted before%'))`,
    )
    .get() as { t: number | null };
  return row.t ?? null;
}
