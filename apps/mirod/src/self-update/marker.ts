import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { basename } from "node:path";

// The self-update marker (PLAN.md §5.32) - a single JSON file at /opt/miro/update.json, the shared
// state between mirod (which stages an update and, at boot, blesses or reverts it) and the standalone
// ExecStartPre preflight (which does the atomic symlink swap and the crash-loop revert BEFORE mirod
// runs). A file, not the DB operation row the reboot slice used, because the preflight runs before
// mirod and a daemon that crashes on boot never reaches its own reconcile - only a pre-daemon guard
// can recover that. Every TERMINAL phase deletes the file, so a later unrelated restart is a clean
// no-op and an infinite swap/revert loop is impossible. This module is pure + fs only (no daemon
// state), so both mirod and the preflight import the same reader/writer.

export type UpdatePhase = "pending" | "swapped" | "revert_requested" | "reverting";

export interface UpdateMarker {
  schema: 1;
  phase: UpdatePhase;
  fromVersion: string;
  toVersion: string;
  /** The version dir that was `current` before the swap - the revert target. Never GC'd. */
  prevDir: string;
  /** The version dir the swap makes `current`. */
  stagedDir: string;
  /** The severity (μ_pre) captured on the old version at install time. -1 when it could not be read. */
  muPre: number;
  /** Un-blessed boots of the new version so far - the crash-loop counter the preflight increments. */
  attempts: number;
  issuedAt: number;
  updatedAt: number;
}

/** Read the marker, or null if absent/unreadable. Unreadable is treated as absent so a corrupt marker
 * degrades to a normal boot rather than wedging startup (the preflight relies on this). */
export function readMarker(path: string): UpdateMarker | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as UpdateMarker;
    if (m.schema !== 1 || typeof m.phase !== "string") return null;
    return m;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), stamping updatedAt. */
export function writeMarker(path: string, m: UpdateMarker): void {
  const next = { ...m, updatedAt: Date.now() };
  writeFileSync(`${path}.tmp`, JSON.stringify(next));
  renameSync(`${path}.tmp`, path);
}

export function clearMarker(path: string): void {
  try {
    rmSync(path);
  } catch {
    // already gone - a terminal transition is idempotent
  }
}

/** Boot-time verdict for a `swapped` marker (pure, unit-tested). The daemon is running the code the
 * swap produced; this decides what to do about it:
 * - `swap_failed`: the running version is not the one we staged - the swap did not take effect, so
 *   `current` is still the old (healthy) version and there is nothing to revert.
 * - `bless`: μ_post is not worse than μ_pre (or μ_pre was unreadable, so we bless on liveness alone -
 *   the daemon booted far enough to run this).
 * - `revert`: the new version is running but worse - roll back to prevDir. */
export function blessDecision(runningVersion: string | null, marker: UpdateMarker, muPost: number): "bless" | "revert" | "swap_failed" {
  if (runningVersion !== marker.toVersion) return "swap_failed";
  if (marker.muPre < 0) return "bless"; // μ_pre unknown - liveness is the only signal, and we have it
  return muPost <= marker.muPre ? "bless" : "revert";
}

/** The preflight's crash-loop step (pure mirror of preflight.mjs - keep in sync). A `swapped` marker
 * seen again means the new version has not blessed itself yet (it crashed, or is still trying). Past
 * `max` un-blessed boots, revert. */
export function crashLoopNext(attempts: number, max: number): { revert: boolean; attempts: number } {
  const next = attempts + 1;
  return next > max ? { revert: true, attempts: next } : { revert: false, attempts: next };
}

/** Which version dirs to garbage-collect after a successful bless: keep the newest `keep`, and NEVER
 * a protected dir (the current version and the previous one a revert would target). Dirs are compared
 * by their basename as a version string (newest last after a natural sort). */
export function versionsToGC(dirs: string[], keep: number, protect: string[]): string[] {
  const protectedSet = new Set(protect);
  const survivors = dirs.filter((d) => !protectedSet.has(d));
  // Newest kept: sort by version basename, drop the newest `keep`, GC the rest. Protected dirs never
  // count against the keep budget - they are always kept regardless.
  const sorted = [...survivors].sort((a, b) => compareVersions(basename(a), basename(b)));
  const keepCount = Math.max(0, keep - protect.length);
  return sorted.slice(0, Math.max(0, sorted.length - keepCount));
}

/** Numeric-dotted comparison ("0.0.10" > "0.0.2"), falling back to string order for non-numeric parts. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if ((pa[i] ?? "") !== (pb[i] ?? "")) {
      return (pa[i] ?? "") < (pb[i] ?? "") ? -1 : 1;
    }
  }
  return 0;
}
