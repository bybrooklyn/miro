import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationKind } from "../engine";
import { isLifelinePath, isSensitivePath, realTarget } from "../classify";
import { unifiedDiff, redactDiffForPlan } from "../diff";
import { applyEdits, type AnchoredEdit } from "../hashline";

// Hash-anchored edits of an existing file (operations/hashline.ts) as a tracked operation. The
// tool computes `content` from the edits at call time, so the params are self-contained: verify,
// crash reconciliation and Prodtest all work from the stored params, and describe() re-derives the
// content from the file as it is NOW - a file that changed since the model read it is a refusal,
// not a guess. Everything else (capture, restore, lifeline/sensitive rules) is file.write's.

export interface FileEditParams {
  path: string;
  edits: AnchoredEdit[];
  /** The whole file after the edits - filled in by the tool, never by the model. */
  content: string;
}

interface Captured {
  previous: string;
  mode: number;
}

export const fileEditKind: OperationKind<FileEditParams, Captured> = {
  kind: "file.edit",
  // Same target key as file.write: the latest change to a path is what Prodtest keeps checking.
  prodtest: (p) => p.path,

  async describe(p) {
    const real = realTarget(p.path);
    if (isSensitivePath(p.path) || isSensitivePath(real)) throw new Error(`refused: ${p.path} is secret material and is never written through a generic operation`);
    if (!existsSync(p.path) || !statSync(p.path).isFile()) throw new Error(`refused: ${p.path} is not an existing file - file_edit edits what exists; file_write creates`);
    const previous = readFileSync(p.path, "utf-8");
    const derived = applyEdits(previous, p.edits); // throws StaleAnchorError when the file moved on
    if (derived !== p.content) throw new Error(`refused: ${p.path} changed between reading it and planning this edit - read it again with anchored: true`);
    const lifeline = isLifelinePath(p.path) || isLifelinePath(real);
    return {
      summary: `Edit ${p.path} (${p.edits.length} anchored edit${p.edits.length === 1 ? "" : "s"}, ${Buffer.byteLength(previous)} → ${Buffer.byteLength(p.content)} bytes)`,
      autoApprove: false,
      class: lifeline ? "lifeline" : "mutate",
      writes: [dirname(real)],
      network: false,
      warning: lifeline ? "this file can affect SSH, networking, or Miro itself" : undefined,
      expects: `${p.path} contains exactly the edited content`,
      rollbackWhen: "verify fails or the write throws - the previous content is restored",
      scopeEvidence: `the target's real parent directory (${dirname(real)})`,
      dryRunFidelity: "exact",
      details: {
        path: p.path,
        edits: p.edits.map((e) => `${e.op} ${e.anchor}${e.to ? `..${e.to}` : ""}`),
        // The approval surface: the diff, not two dumps of a 500-line config. Existing lines are
        // redacted (they are the app's secrets, not the model's input - audit A10).
        diff: redactDiffForPlan(unifiedDiff(previous, p.content, p.path)),
      },
    };
  },

  async captureState(p) {
    return { previous: readFileSync(p.path, "utf-8"), mode: statSync(p.path).mode & 0o777 };
  },

  async apply(p) {
    await Bun.write(p.path, p.content);
  },

  async verify(p) {
    return existsSync(p.path) && readFileSync(p.path, "utf-8") === p.content;
  },

  async rollback(p, captured) {
    await Bun.write(p.path, captured.previous);
    chmodSync(p.path, captured.mode);
  },
};
