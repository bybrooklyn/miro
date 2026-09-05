import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Database } from "bun:sqlite";
import { DB_PATH } from "@miro/protocol";
import { isSensitivePath } from "../operations/classify";

// Scoped filesystem index (plan §22) - enough to answer "what's on this disk", not the full
// event-driven/dirty-shutdown-recovery index the plan eventually wants. ponytail: bounded
// depth/entry walk with a fixed denylist and extension-based classifier, both heuristics with a
// known ceiling - upgrade to real per-app semantic relationships (§23) if this misclassifies often.

export type SemanticClass = "media" | "config" | "code" | "archive" | "other";

const CLASS_BY_EXTENSION: Record<string, SemanticClass> = {
  ".mp4": "media",
  ".mkv": "media",
  ".mp3": "media",
  ".flac": "media",
  ".jpg": "media",
  ".jpeg": "media",
  ".png": "media",
  ".yml": "config",
  ".yaml": "config",
  ".json": "config",
  ".conf": "config",
  ".env": "config",
  ".toml": "config",
  ".ini": "config",
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".py": "code",
  ".go": "code",
  ".rs": "code",
  ".zip": "archive",
  ".tar": "archive",
  ".gz": "archive",
};

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".cache", "__pycache__", "dist", "build"]);

export function classify(path: string): SemanticClass {
  return CLASS_BY_EXTENSION[extname(path).toLowerCase()] ?? "other";
}

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes: number;
  mtimeMs: number;
  class: SemanticClass;
}

export interface ScanOptions {
  maxDepth?: number;
  maxEntries?: number;
}

/** Walks a directory tree, bounded by depth and total entries. Skips symlinks and noisy dirs. */
export function scanRoot(rootPath: string, options: ScanOptions = {}): FileEntry[] {
  const maxDepth = options.maxDepth ?? 6;
  const maxEntries = options.maxEntries ?? 5000;
  const entries: FileEntry[] = [];

  function walk(dir: string, depth: number) {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    let children: import("node:fs").Dirent[];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, or it vanished mid-walk
    }
    for (const child of children) {
      if (entries.length >= maxEntries) return;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory() && SKIP_DIR_NAMES.has(child.name)) continue;

      const path = join(dir, child.name);
      // Names only, but a listing of ~/.ssh or a .env's location is still a map to the secrets
      // that every other read path refuses to draw (audit C14).
      if (isSensitivePath(path)) continue;
      let stat: import("node:fs").Stats;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }

      if (child.isDirectory()) {
        entries.push({ path, type: "dir", sizeBytes: 0, mtimeMs: stat.mtimeMs, class: "other" });
        walk(path, depth + 1);
      } else if (child.isFile()) {
        entries.push({ path, type: "file", sizeBytes: stat.size, mtimeMs: stat.mtimeMs, class: classify(path) });
      }
    }
  }

  walk(rootPath, 0);
  return entries;
}

export function ensureFsIndexTable(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS fs_index (path TEXT PRIMARY KEY, root TEXT NOT NULL, type TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, class TEXT NOT NULL)",
  );
}

export function indexRoot(db: Database, rootPath: string, options?: ScanOptions): number {
  const entries = scanRoot(rootPath, options);
  const upsert = db.prepare(
    "INSERT INTO fs_index (path, root, type, size_bytes, mtime_ms, class) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, class = excluded.class",
  );
  const insertAll = db.transaction((rows: FileEntry[]) => {
    for (const row of rows) upsert.run(row.path, rootPath, row.type, row.sizeBytes, row.mtimeMs, row.class);
  });
  insertAll(entries);
  return entries.length;
}

export function queryByClass(db: Database, semanticClass: SemanticClass, limit = 100): FileEntry[] {
  const rows = db
    .query("SELECT path, type, size_bytes, mtime_ms, class FROM fs_index WHERE class = ? LIMIT ?")
    .all(semanticClass, limit) as { path: string; type: string; size_bytes: number; mtime_ms: number; class: string }[];
  return rows.map((r) => ({
    path: r.path,
    type: r.type as "file" | "dir",
    sizeBytes: r.size_bytes,
    mtimeMs: r.mtime_ms,
    class: r.class as SemanticClass,
  }));
}

// SQLite supports multiple connections to the same file from one process - this is its own
// connection to mirod's real DB, kept lazy so importing this module never touches disk at rest
// (tests never hit it; they pass their own :memory:/temp db to the functions above).
let sharedDb: Database | null = null;
function getSharedDb(): Database {
  if (!sharedDb) {
    sharedDb = new Database(DB_PATH);
    ensureFsIndexTable(sharedDb);
  }
  return sharedDb;
}

export function indexRootOnDisk(rootPath: string, options?: ScanOptions): number {
  return indexRoot(getSharedDb(), rootPath, options);
}

export function queryByClassOnDisk(semanticClass: SemanticClass, limit?: number): FileEntry[] {
  return queryByClass(getSharedDb(), semanticClass, limit);
}
