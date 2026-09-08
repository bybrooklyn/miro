import type { Database } from "bun:sqlite";

// The managed-stacks registry (PLAN.md compose-killer slice 1). The LIVE compose stacks Miro owns and
// runs - distinct from app_recipes (slice 2: the reusable KNOWLEDGE of how to install an app). Plain
// bun:sqlite, same ensure*Table/fromRow convention as extensions/store.ts. Keyed by app name.

export type StackStatus = "running" | "stopped";

export interface ManagedStack {
  app: string;
  /** The compose project dir, e.g. /var/lib/miro/stacks/<app>. */
  dir: string;
  composePath: string;
  status: StackStatus;
  /** The capability-memory recipe this came from (slice 2); null while installs are generated. */
  recipeId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  app: string;
  dir: string;
  compose_path: string;
  status: StackStatus;
  recipe_id: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow(r: Row): ManagedStack {
  return { app: r.app, dir: r.dir, composePath: r.compose_path, status: r.status, recipeId: r.recipe_id, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function ensureStacksTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS managed_stacks (
      app TEXT PRIMARY KEY,
      dir TEXT NOT NULL,
      compose_path TEXT NOT NULL,
      status TEXT NOT NULL,
      recipe_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export function upsertStack(db: Database, s: { app: string; dir: string; composePath: string; status: StackStatus; recipeId?: string | null }): void {
  const now = Date.now();
  db.run(
    `INSERT INTO managed_stacks (app, dir, compose_path, status, recipe_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app) DO UPDATE SET dir = excluded.dir, compose_path = excluded.compose_path, status = excluded.status,
       recipe_id = COALESCE(excluded.recipe_id, managed_stacks.recipe_id), updated_at = excluded.updated_at`,
    [s.app, s.dir, s.composePath, s.status, s.recipeId ?? null, now, now],
  );
}

export function setStackStatus(db: Database, app: string, status: StackStatus): void {
  db.run("UPDATE managed_stacks SET status = ?, updated_at = ? WHERE app = ?", [status, Date.now(), app]);
}

export function getStack(db: Database, app: string): ManagedStack | null {
  const r = db.query("SELECT * FROM managed_stacks WHERE app = ?").get(app) as Row | null;
  return r ? fromRow(r) : null;
}

export function listStacks(db: Database): ManagedStack[] {
  return (db.query("SELECT * FROM managed_stacks ORDER BY app").all() as Row[]).map(fromRow);
}

export function removeStack(db: Database, app: string): void {
  // The compose dir is moved to trash separately (recoverable); the row is dropped.
  db.run("DELETE FROM managed_stacks WHERE app = ?", [app]);
}
