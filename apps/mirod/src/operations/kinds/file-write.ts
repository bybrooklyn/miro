import { existsSync, readFileSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationKind } from "../engine";
import { isLifelinePath, isSensitivePath, realTarget, redactSecretsInText } from "../classify";
import { trashDestination, moveToTrash } from "../trash";
import { unifiedDiff, redactDiffForPlan } from "../diff";

// Writing a whole file as a tracked operation. The full new content is in the plan the user sees
// (alongside the current content, so the change is reviewable), the previous content is captured,
// verify is a read-back, and rollback restores the previous content - or, for a file this
// operation created, moves it to the trash rather than deleting it.

export interface FileWriteParams {
  path: string;
  content: string;
  /** Octal mode, e.g. 0o644. Left unchanged if omitted. */
  mode?: number;
  /** false for a one-shot marker the app consumes; omitted means the content should keep holding
   * and drift detection (operations/prodtest.ts) re-checks it. */
  verifyKeeps?: boolean;
}

export interface FileWriteCaptured {
  existed: boolean;
  previous: string | null;
  mode: number | null;
}

// realTarget lives in ../classify now, next to isSensitivePath, which resolves symlinks itself.
export { realTarget };

const PREVIEW_LINES = 60;
function preview(text: string): string {
  const lines = text.split("\n");
  return lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join("\n") + `\n… (${lines.length - PREVIEW_LINES} more lines)` : text;
}

export const fileWriteKind: OperationKind<FileWriteParams, FileWriteCaptured> = {
  kind: "file.write",
  // Prodtest: the file still holds what Miro wrote - the latest write per path is what counts.
  // Lasting by default (a config file is), opt-out for a one-shot marker the app consumes (found
  // live: Jellyfin's password-recovery marker, PLAN.md §5.24).
  prodtest: (p) => (p.verifyKeeps === false ? null : p.path),

  async describe(p) {
    // Check the path as the kernel will see it: a symlink at /srv/app/config pointing into /etc
    // would otherwise be approved as "/srv/app/config" and written as /etc/… (adversarial review).
    const real = realTarget(p.path);
    if (isSensitivePath(p.path) || isSensitivePath(real)) throw new Error(`refused: ${p.path} is secret material and is never written through a generic operation`);
    const lifeline = isLifelinePath(p.path) || isLifelinePath(real);
    const existed = existsSync(p.path);
    const previous = existed ? readFileSync(p.path, "utf-8") : null;
    return {
      summary: `${existed ? "Overwrite" : "Create"} ${p.path} (${Buffer.byteLength(p.content)} bytes)`,
      autoApprove: false,
      class: lifeline ? "lifeline" : "mutate",
      writes: [dirname(real)],
      network: false,
      warning: lifeline ? "this file can affect SSH, networking, or Miro itself" : undefined,
      expects: `${p.path} contains exactly the proposed content`,
      rollbackWhen: existed ? "verify fails or the write throws - the previous content is restored" : "verify fails or the write throws - the new file is removed",
      scopeEvidence: `the target's real parent directory (${dirname(real)})`,
      dryRunFidelity: "exact",
      details: {
        path: p.path,
        existed,
        bytes: Buffer.byteLength(p.content),
        mode: p.mode != null ? `0${p.mode.toString(8)}` : null,
        // The plan is persisted and sent to every client: the file's CURRENT content is redacted
        // (an app config's database password is not Miro's to broadcast - audit A10); the proposed
        // side is the model's own input and stays legible for approval.
        current: previous !== null ? redactSecretsInText(preview(previous)) : null,
        proposed: preview(p.content),
        // What the client renders as the approval surface: a real diff, not two dumps.
        diff: redactDiffForPlan(unifiedDiff(previous ?? "", p.content, p.path)),
      },
    };
  },

  async captureState(p) {
    const existed = existsSync(p.path);
    return {
      existed,
      previous: existed ? readFileSync(p.path, "utf-8") : null,
      mode: existed ? statSync(p.path).mode & 0o777 : null,
    };
  },

  async apply(p) {
    mkdirSync(dirname(p.path), { recursive: true });
    await Bun.write(p.path, p.content);
    // `!= null`, not `!== undefined`: a strict-schema provider (Codex) sends null for an omitted
    // optional field, and chmod(path, null) is chmod 0 - found live under the hardened unit's
    // probes (PLAN.md §5.30): two files written with "mode: null" came out ----------.
    if (p.mode != null) chmodSync(p.path, p.mode);
  },

  async verify(p) {
    return existsSync(p.path) && readFileSync(p.path, "utf-8") === p.content;
  },

  async rollback(p, captured) {
    if (captured.existed && captured.previous !== null) {
      await Bun.write(p.path, captured.previous);
      if (captured.mode !== null) chmodSync(p.path, captured.mode);
    } else if (existsSync(p.path)) {
      // This operation created the file: undo means it goes to the trash, never an rm.
      moveToTrash(trashDestination(p.path));
    }
  },
};
