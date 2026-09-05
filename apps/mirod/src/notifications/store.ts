import type { Database } from "bun:sqlite";
import type { NotifyTier } from "./sinks";

// Durable notification record (PLAN.md §5.31). Every notify() persists here first, so a
// notification survives a broadcast/phone failure and, for a disconnected owner, waits to be
// replayed on the next connection. Same shape as operations/store.ts: camelCase interface,
// snake_case columns, a defensive ensure*Table run at boot. `tui_delivered_at` is null until a
// connected TUI actually received the notice (routine tier never replays).

export interface NotificationRecord {
  id: string;
  tier: NotifyTier;
  title: string;
  body: string;
  source: string;
  createdAt: number;
  tuiDeliveredAt: number | null;
}

interface Row {
  id: string;
  tier: NotifyTier;
  title: string;
  body: string;
  source: string;
  created_at: number;
  tui_delivered_at: number | null;
}

function fromRow(row: Row): NotificationRecord {
  return {
    id: row.id,
    tier: row.tier,
    title: row.title,
    body: row.body,
    source: row.source,
    createdAt: row.created_at,
    tuiDeliveredAt: row.tui_delivered_at,
  };
}

export function ensureNotificationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      tui_delivered_at INTEGER
    )
  `);
}

export function insertNotification(db: Database, rec: { id: string; tier: NotifyTier; title: string; body: string; source: string; createdAt: number; tuiDeliveredAt: number | null }): void {
  db.run(`INSERT INTO notifications (id, tier, title, body, source, created_at, tui_delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    rec.id,
    rec.tier,
    rec.title,
    rec.body,
    rec.source,
    rec.createdAt,
    rec.tuiDeliveredAt,
  ]);
}

/** worth_knowing+ notifications a connected TUI has not yet seen, oldest first so the replay order
 * matches when they happened. routine never replays - it is log-only. */
export function listUndelivered(db: Database): NotificationRecord[] {
  const rows = db
    .query(`SELECT * FROM notifications WHERE tier IN ('worth_knowing','needs_attention') AND tui_delivered_at IS NULL ORDER BY created_at ASC, rowid ASC`)
    .all() as Row[];
  return rows.map(fromRow);
}

export function markDelivered(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");
  db.run(`UPDATE notifications SET tui_delivered_at = ? WHERE id IN (${placeholders})`, [now, ...ids]);
}

/** Dedup backstop: has a notification with this exact title gone out within the window? Used before
 * a needs_attention phone push so a recurring signal does not buzz the phone repeatedly. */
export function recentByTitle(db: Database, title: string, sinceMs: number): boolean {
  const row = db.query(`SELECT 1 FROM notifications WHERE title = ? AND created_at >= ? LIMIT 1`).get(title, Date.now() - sinceMs) as { 1: number } | null;
  return row !== null;
}
