import type { Database } from "bun:sqlite";

export interface TimelineEvent {
  id: number;
  ts: number;
  source: string;
  message: string;
}

export function ensureTimelineTable(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL)",
  );
}

export function recordEvent(db: Database, source: string, message: string): void {
  db.run("INSERT INTO events (ts, source, message) VALUES (?, ?, ?)", [Date.now(), source, message]);
}

export function queryEvents(db: Database, limit = 50): TimelineEvent[] {
  return db
    .query("SELECT id, ts, source, message FROM events ORDER BY id DESC LIMIT ?")
    .all(limit) as TimelineEvent[];
}
