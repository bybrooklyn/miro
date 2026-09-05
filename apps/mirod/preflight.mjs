#!/usr/bin/env bun
// mirod ExecStartPre (PLAN.md §5.32): the atomic rename-if-staged swap + the crash-loop revert.
// Runs as root, BEFORE mirod, on every start. Deliberately STANDALONE - it is a fixed copy at
// /opt/miro/preflight.mjs, imports nothing from the versioned tree, and duplicates ~30 lines of
// marker logic on purpose, so a broken new version cannot break its own recovery. The whole body is
// wrapped so ANY error degrades to a normal boot (exit 0) rather than wedging startup. Keep the
// phase machine in sync with apps/mirod/src/self-update/marker.ts (crashLoopNext / the table).
import { readFileSync, writeFileSync, renameSync, symlinkSync, rmSync } from "node:fs";

const ROOT = process.env.MIRO_UPDATE_ROOT ?? "/opt/miro";
const MARKER = `${ROOT}/update.json`;
const CURRENT = `${ROOT}/current`;
const MAX = 2; // revert on the 3rd un-blessed boot of the new version

function readMarker() {
  try {
    const m = JSON.parse(readFileSync(MARKER, "utf8"));
    return m && m.schema === 1 && typeof m.phase === "string" ? m : null;
  } catch {
    return null;
  }
}

function writeMarker(m) {
  writeFileSync(`${MARKER}.tmp`, JSON.stringify({ ...m, updatedAt: Date.now() }));
  renameSync(`${MARKER}.tmp`, MARKER);
}

// Point CURRENT at `target` atomically: a temp symlink + rename(2). `ln -sfn` alone is unlink+symlink,
// a window where a racing wrapper sees no `current`.
function swap(target) {
  const tmp = `${CURRENT}.tmp`;
  try { rmSync(tmp); } catch {}
  symlinkSync(target, tmp);
  renameSync(tmp, CURRENT);
}

try {
  const m = readMarker();
  if (m) {
    if (m.phase === "pending") {
      // First boot after an install: make the staged version current.
      try {
        swap(m.stagedDir);
        writeMarker({ ...m, phase: "swapped", attempts: 1 });
      } catch {
        writeMarker({ ...m, phase: "reverting" }); // could not swap - fall back to the old version, mirod reports it
      }
    } else if (m.phase === "swapped") {
      // The new version has booted before without blessing itself (it crashed, or is mid-settle).
      const attempts = (m.attempts ?? 0) + 1;
      if (attempts > MAX) {
        swap(m.prevDir);
        writeMarker({ ...m, phase: "reverting" });
      } else {
        writeMarker({ ...m, phase: "swapped", attempts });
      }
    } else if (m.phase === "revert_requested") {
      // mirod judged the new version unhealthy and asked for the swap back.
      swap(m.prevDir);
      writeMarker({ ...m, phase: "reverting" });
    }
    // reverting / anything else: mirod acts on it, not the preflight.
  }
} catch {
  // Any unexpected failure: never block the boot.
}
process.exit(0);
