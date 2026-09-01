import { existsSync, mkdirSync, statSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { MIRO_DIR } from "@miro/protocol";
import { run } from "../inventory/exec";

// Pre-apply snapshots for generic operations (PLAN.md §5.7: "a destructive operation on data
// snapshots before applying — that is the engine's captureState phase, so this is policy on
// kinds, not new machinery"). shell_command captures its declared writable roots here before
// running anything, so rollback can restore them byte-for-byte on top of whatever undo command
// the model supplied.

export const SNAPSHOT_DIR = join(MIRO_DIR, "snapshots");
// ponytail: a single size cap, no incremental/dedup. Above it the roots are recorded as skipped
// and rollback relies on the model's own rollback command — the plan says which. Raise or replace
// with a smarter strategy (rsync --link-dest, overlay) when a real operation needs to snapshot
// something big like /var/lib/docker.
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

export interface Snapshot {
  /** tar archive of the snapshotted paths, or null if nothing was captured. */
  archive: string | null;
  paths: string[];
  skipped: { path: string; reason: string }[];
}

/** Portable directory size (no `du -b` on macOS). Stops counting once `cap` is exceeded. */
export function sizeOf(path: string, cap = Number.POSITIVE_INFINITY): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  const stack = [path];
  while (stack.length > 0 && total <= cap) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = lstatSync(p);
      if (s.isDirectory()) stack.push(p);
      else total += s.size;
      if (total > cap) return total;
    }
  }
  return total;
}

export async function snapshotPaths(paths: string[], id: string, snapshotDir = SNAPSHOT_DIR, maxBytes = SNAPSHOT_MAX_BYTES): Promise<Snapshot> {
  const existing = paths.filter((p) => existsSync(p));
  const skipped = paths.filter((p) => !existsSync(p)).map((p) => ({ path: p, reason: "does not exist yet" }));
  if (existing.length === 0) return { archive: null, paths: [], skipped };

  let total = 0;
  for (const p of existing) {
    total += sizeOf(p, maxBytes);
    if (total > maxBytes) {
      return { archive: null, paths: [], skipped: [...skipped, ...existing.map((x) => ({ path: x, reason: `total exceeds snapshot cap of ${maxBytes} bytes` }))] };
    }
  }

  mkdirSync(snapshotDir, { recursive: true });
  const archive = join(snapshotDir, `${id}.tar`);
  // Paths are stored relative to / so restore is a plain `tar -x -C /`.
  await run("tar", ["-cpf", archive, "-C", "/", ...existing.map((p) => relative("/", p))], { timeoutMs: 120_000 });
  return { archive, paths: existing, skipped };
}

/** Restores the archive's contents over the live paths. Files created after the snapshot are not
 * removed (ponytail: a real "restore to exact state" needs a manifest diff; rollback commands cover
 * the rest for now). */
export async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  if (!snapshot.archive) return;
  await run("tar", ["-xpf", snapshot.archive, "-C", "/"], { timeoutMs: 120_000 });
}
