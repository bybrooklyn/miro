import { existsSync, mkdirSync, renameSync, cpSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIRO_DIR } from "@miro/protocol";

// Miro's trash (PLAN.md §5.7). `rm` is forbidden for every agent; deletion exists only as the
// file_delete operation kind, whose apply is a move into here and whose rollback is a move back.
// Nothing an agent does is an irrecoverable delete. The single place the daemon itself removes a
// path is the cross-device fallback below (copy, then remove the source) — a move by other means.

export const TRASH_DIR = join(MIRO_DIR, "trash");

export interface TrashEntry {
  id: string;
  originalPath: string;
  trashedPath: string;
  trashedAt: number;
}

/** Where `originalPath` will land — computed before the move so an operation's rollback can find
 * it from captured state alone, with no hidden bookkeeping in between. */
export function trashDestination(originalPath: string, trashDir = TRASH_DIR, now = Date.now()): TrashEntry {
  const id = `${now}-${crypto.randomUUID().slice(0, 8)}`;
  return { id, originalPath, trashedPath: join(trashDir, id, originalPath), trashedAt: now };
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Different filesystem: copy, verify the copy exists, then remove the source. This is the one
    // deliberate removal in the daemon and it only ever follows a completed copy.
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    if (!existsSync(to)) throw new Error(`cross-device move failed: ${to} missing after copy`);
    rmSync(from, { recursive: true, force: true });
  }
}

export function moveToTrash(entry: TrashEntry, trashDir = TRASH_DIR): void {
  if (!existsSync(entry.originalPath)) throw new Error(`${entry.originalPath} does not exist`);
  move(entry.originalPath, entry.trashedPath);
  appendFileSync(join(trashDir, "index.jsonl"), JSON.stringify({ ...entry, action: "trashed" }) + "\n");
}

export function restoreFromTrash(entry: TrashEntry, trashDir = TRASH_DIR): void {
  if (!existsSync(entry.trashedPath)) throw new Error(`trash entry ${entry.id} is missing`);
  if (existsSync(entry.originalPath)) throw new Error(`${entry.originalPath} exists again — refusing to overwrite it`);
  move(entry.trashedPath, entry.originalPath);
  appendFileSync(join(trashDir, "index.jsonl"), JSON.stringify({ ...entry, action: "restored", restoredAt: Date.now() }) + "\n");
}

/** Entries still in the trash (trashed and not since restored). */
export function listTrash(trashDir = TRASH_DIR): TrashEntry[] {
  const index = join(trashDir, "index.jsonl");
  if (!existsSync(index)) return [];
  const byId = new Map<string, TrashEntry>();
  for (const line of readFileSync(index, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as TrashEntry & { action: string };
    if (rec.action === "trashed") byId.set(rec.id, { id: rec.id, originalPath: rec.originalPath, trashedPath: rec.trashedPath, trashedAt: rec.trashedAt });
    else byId.delete(rec.id);
  }
  return [...byId.values()].filter((e) => existsSync(e.trashedPath));
}

// ponytail: no retention purge yet. Purging is itself a destructive operation (a real delete) and
// must be a confirmed operation kind with a default 30-day retention — add when the trash actually
// fills up, not before.
