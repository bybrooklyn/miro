import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationKind } from "../engine";
import { isLifelinePath, isSensitivePath, realTarget } from "../classify";
import { trashDestination, moveToTrash, restoreFromTrash, TRASH_DIR, type TrashEntry } from "../trash";
import { sizeOf } from "../snapshot";

// The only way anything gets deleted (PLAN.md §5.7): a move into Miro's trash, recoverable, with
// rollback being the move back. The destination is computed in captureState and carried in the
// captured state, so rollback needs nothing but what the engine already persists - a crash between
// apply and commit reconciles cleanly at boot from the operations table alone.

export interface FileDeleteParams {
  path: string;
}

export interface FileDeleteCaptured {
  entry: TrashEntry;
  wasDirectory: boolean;
  bytes: number;
}

/** captureState → apply hand-off: apply(params) does not receive captured state, so the
 * destination chosen in captureState is parked here by path until apply consumes it. */
const pending = new Map<string, TrashEntry>();

const SIZE_CAP = 1_000_000_000;

export const fileDeleteKind: OperationKind<FileDeleteParams, FileDeleteCaptured> = {
  kind: "file.delete",
  // Prodtest: the path is still gone. Same target key as file.write, so a later write of the same
  // path supersedes the delete instead of reporting it as drift.
  prodtest: (p) => p.path,

  async describe(p) {
    if (!existsSync(p.path)) throw new Error(`${p.path} does not exist`);
    const real = realTarget(p.path);
    if (isSensitivePath(p.path) || isSensitivePath(real)) {
      throw new Error(`refused: ${p.path} is Miro's own state or secret material`);
    }
    const st = statSync(p.path);
    const lifeline = isLifelinePath(p.path) || isLifelinePath(real);
    // Once, capped: an uncapped recursive walk of /var/lib/docker ran for minutes before the owner
    // was even asked (audit B10). Past the cap the plan says so rather than counting on.
    const bytes = sizeOf(p.path, SIZE_CAP);
    const size = bytes > SIZE_CAP ? `more than ${Math.round(SIZE_CAP / 1e9)} GB` : `${bytes} bytes`;
    return {
      summary: `Move ${p.path} to trash (${st.isDirectory() ? "directory" : "file"}, ${size})`,
      autoApprove: false,
      class: lifeline ? "lifeline" : "destructive",
      writes: [dirname(p.path), TRASH_DIR],
      network: false,
      warning: lifeline ? "this path can affect SSH, networking, or Miro itself" : "recoverable from Miro's trash",
      expects: `${p.path} is gone from its path and present in Miro's trash`,
      rollbackWhen: "verify fails or the move throws - restored from the trash",
      scopeEvidence: "the path's parent directory and the trash directory, nothing else",
      dryRunFidelity: "exact",
      details: { path: p.path, type: st.isDirectory() ? "directory" : "file", bytes, sizeCapped: bytes > SIZE_CAP },
    };
  },

  async captureState(p) {
    const entry = trashDestination(p.path);
    pending.set(p.path, entry);
    return { entry, wasDirectory: statSync(p.path).isDirectory(), bytes: sizeOf(p.path, SIZE_CAP) };
  },

  async apply(p) {
    const entry = pending.get(p.path);
    pending.delete(p.path);
    if (!entry) throw new Error("apply called without captureState");
    moveToTrash(entry);
  },

  async verify(p) {
    return !existsSync(p.path);
  },

  async rollback(p, captured) {
    pending.delete(p.path);
    if (existsSync(captured.entry.trashedPath) && !existsSync(p.path)) restoreFromTrash(captured.entry);
  },
};
