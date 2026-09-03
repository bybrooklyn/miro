import { existsSync, readFileSync, statSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { OperationKind } from "../engine";
import { isLifelinePath, isSensitivePath } from "../classify";
import { trashDestination, moveToTrash } from "../trash";
import { unifiedDiff } from "../diff";

// Writing a whole file as a tracked operation. The full new content is in the plan the user sees
// (alongside the current content, so the change is reviewable), the previous content is captured,
// verify is a read-back, and rollback restores the previous content — or, for a file this
// operation created, moves it to the trash rather than deleting it.

export interface FileWriteParams {
  path: string;
  content: string;
  /** Octal mode, e.g. 0o644. Left unchanged if omitted. */
  mode?: number;
}

export interface FileWriteCaptured {
  existed: boolean;
  previous: string | null;
  mode: number | null;
}

/** The path with symlinks resolved — the file itself if it exists, else its nearest existing
 * ancestor plus the remainder. */
export function realTarget(path: string): string {
  if (existsSync(path)) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }
  let dir = dirname(path);
  const rest: string[] = [basename(path)];
  while (!existsSync(dir) && dir !== dirname(dir)) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  try {
    return join(realpathSync(dir), ...rest);
  } catch {
    return path;
  }
}

const PREVIEW_LINES = 60;
function preview(text: string): string {
  const lines = text.split("\n");
  return lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join("\n") + `\n… (${lines.length - PREVIEW_LINES} more lines)` : text;
}

export const fileWriteKind: OperationKind<FileWriteParams, FileWriteCaptured> = {
  kind: "file.write",

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
      rollbackWhen: existed ? "verify fails or the write throws — the previous content is restored" : "verify fails or the write throws — the new file is removed",
      scopeEvidence: `the target's real parent directory (${dirname(real)})`,
      dryRunFidelity: "exact",
      details: {
        path: p.path,
        existed,
        bytes: Buffer.byteLength(p.content),
        mode: p.mode !== undefined ? `0${p.mode.toString(8)}` : null,
        current: previous !== null ? preview(previous) : null,
        proposed: preview(p.content),
        // What the client renders as the approval surface: a real diff, not two dumps.
        diff: unifiedDiff(previous ?? "", p.content, p.path),
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
    if (p.mode !== undefined) chmodSync(p.path, p.mode);
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
