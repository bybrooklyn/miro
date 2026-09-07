import { existsSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { blessDecision, clearMarker, readMarker, versionsToGC, writeMarker, type UpdateMarker } from "./marker";
import type { NotifyTier } from "../notifications";

// The daemon side of self-update (PLAN.md §5.32). mirod stages an update (writes a `pending` marker
// and restarts; the preflight does the atomic swap before the next boot) and, at boot, blesses or
// reverts the version the swap produced - the same μ_pre/μ_post health judgement the reboot slice
// makes, but a version swap instead of a machine reboot, and a file marker instead of a DB row so a
// crash-on-boot can be recovered by the pre-daemon preflight. Runs at the reconcile slot in
// index.ts, before the socket binds, so a verdict persists through notify() and replays on reconnect.

export const UPDATE_ROOT = process.env.MIRO_UPDATE_ROOT ?? "/opt/miro";
export const KEEP_VERSIONS = 3;
const SETTLE_MS = 45_000; // must stay under the unit's WatchdogSec (60s); the settle is pre-READY
const SETTLE_INTERVAL_MS = 5_000;

function paths(root = UPDATE_ROOT) {
  return { markerPath: join(root, "update.json"), currentLink: join(root, "current"), versionsDir: join(root, "versions") };
}

/** The version this daemon is running, from the wrapper's MIRO_VERSION (the basename of the current
 * symlink's target). Absent on a dev nohup run (no wrapper) - then self-update simply no-ops. */
/** Safe to restart into a new version right now (PLAN.md self-update slice 3): no operation is
 * mid-apply and no chat/learn turn is active. An `applying` row means a mutation is in flight
 * (interrupting it is crash-recoverable but not free); an active turn means the owner is mid-flow.
 * Gates the OPT-IN autonomous auto-install; a human-confirmed install never consults it. */
export function isQuiescent(db: Database, anyTurnActive: boolean): boolean {
  if (anyTurnActive) return false;
  const row = db.query("SELECT COUNT(*) AS n FROM operations WHERE phase = 'applying'").get() as { n: number };
  return row.n === 0;
}

export function currentVersion(): string | null {
  return process.env.MIRO_VERSION ?? null;
}

export interface BlessDeps {
  db: Database;
  computeSeverity: (db: Database) => Promise<number>;
  notify: (n: { tier: NotifyTier; title: string; body: string; source: string; at: number }) => void;
  /** Restart the unit - the swap/revert takes effect on the next boot via the preflight. */
  restart: () => Promise<unknown>;
  /** Kept alive during the settle so a slow health check is not mistaken for a hang (WATCHDOG=1). */
  heartbeat?: () => void;
  root?: string;
  running?: string | null;
}

/** Poll severity until it settles to <= muPre (healthy) or the deadline, heartbeating each step so a
 * long settle is not counted as a hang. Returns the most favourable (lowest) severity observed. */
async function settleSeverity(deps: BlessDeps, muPre: number): Promise<number> {
  const deadline = Date.now() + SETTLE_MS;
  let best = Number.POSITIVE_INFINITY;
  for (;;) {
    deps.heartbeat?.();
    const mu = await deps.computeSeverity(deps.db).catch(() => best);
    best = Math.min(best, mu);
    if (best <= muPre || Date.now() >= deadline) return best === Number.POSITIVE_INFINITY ? mu : best;
    await Bun.sleep(SETTLE_INTERVAL_MS);
  }
}

/** Boot-time bless/revert. Only `swapped` (judge the new version) and `reverting` (report the
 * completed auto-revert) are mirod's to act on; `pending`/`revert_requested` belong to the preflight
 * and, if mirod sees one, the preflight has not run yet - leave it for the next boot. */
export async function blessOrRevertUpdate(deps: BlessDeps): Promise<void> {
  const { markerPath, currentLink, versionsDir } = paths(deps.root);
  const m = readMarker(markerPath);
  if (!m) return;
  const running = deps.running !== undefined ? deps.running : currentVersion();

  if (m.phase === "reverting") {
    // We are the old version, back after an auto-revert the preflight completed.
    deps.notify({ tier: "needs_attention", title: `Update to ${m.toVersion} was rolled back`, body: `It did not pass the post-update health check; Miro reverted to ${m.fromVersion}.`, source: "update", at: Date.now() });
    clearMarker(markerPath);
    return;
  }

  if (m.phase !== "swapped") return; // pending / revert_requested: the preflight acts, not mirod

  const muPost = await settleSeverity(deps, m.muPre);
  const decision = blessDecision(running, m, muPost);

  if (decision === "swap_failed") {
    deps.notify({ tier: "needs_attention", title: `Update to ${m.toVersion} did not take effect`, body: `Still running ${running ?? "an unknown version"}. Nothing was changed.`, source: "update", at: Date.now() });
    clearMarker(markerPath);
    return;
  }

  if (decision === "bless") {
    gcOldVersions(versionsDir, currentLink, m.prevDir);
    deps.notify({ tier: "worth_knowing", title: `Updated to ${m.toVersion}`, body: m.muPre < 0 ? "Healthy." : `Healthy (severity ${muPost} vs ${m.muPre} before).`, source: "update", at: Date.now() });
    clearMarker(markerPath);
    return;
  }

  // revert: hand the symlink swap to the preflight on the next boot, then restart into it.
  writeMarker(markerPath, { ...m, phase: "revert_requested" });
  await deps.restart().catch(() => {});
}

function gcOldVersions(versionsDir: string, currentLink: string, prevDir: string): void {
  let dirs: string[];
  try {
    dirs = readdirSync(versionsDir).map((d) => join(versionsDir, d));
  } catch {
    return;
  }
  const protect = [safeReal(currentLink), safeReal(prevDir)].filter(Boolean) as string[];
  for (const dir of versionsToGC(dirs, KEEP_VERSIONS, protect)) {
    // Only a real copy is removed; v1 (the dev-tree symlink) resolves into current's protect set.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function safeReal(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

export interface StageDeps {
  db: Database;
  computeSeverity: (db: Database) => Promise<number>;
  restart: () => Promise<unknown>;
  root?: string;
  running?: string | null;
}

/** Owner-initiated install: verify the target version dir exists, capture μ_pre on THIS (old,
 * healthy) version, write a `pending` marker, and restart. The preflight swaps `current` to the
 * staged dir before the next boot; blessOrRevertUpdate judges it there. */
export async function stageUpdate(deps: StageDeps, toVersion: string): Promise<{ ok: boolean; reason?: string }> {
  const { markerPath, currentLink, versionsDir } = paths(deps.root);
  const stagedDir = join(versionsDir, toVersion);
  if (!existsSync(stagedDir)) return { ok: false, reason: `version ${toVersion} is not staged under ${versionsDir}` };
  const running = deps.running !== undefined ? deps.running : currentVersion();
  if (!running) return { ok: false, reason: "this daemon has no version (a dev run without the wrapper) - self-update needs the systemd install" };
  if (running === toVersion) return { ok: false, reason: `already running ${toVersion}` };
  const prevDir = safeReal(currentLink);
  if (!prevDir) return { ok: false, reason: "could not resolve the current version - refusing to stage an update with no revert target" };

  const muPre = await deps.computeSeverity(deps.db).catch(() => -1);
  const marker: UpdateMarker = { schema: 1, phase: "pending", fromVersion: running, toVersion, prevDir, stagedDir, muPre, attempts: 0, issuedAt: Date.now(), updatedAt: Date.now() };
  writeMarker(markerPath, marker);
  await deps.restart();
  return { ok: true };
}

/** Version dirs available to update to (excluding the running one), for the owner-facing tool. */
export function availableVersions(root = UPDATE_ROOT): string[] {
  try {
    return readdirSync(join(root, "versions")).filter((v) => v !== currentVersion());
  } catch {
    return [];
  }
}
