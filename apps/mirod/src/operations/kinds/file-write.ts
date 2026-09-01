import { existsSync, readFileSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationKind } from "../engine";
import { isLifelinePath, isSensitivePath } from "../classify";
import { trashDestination, moveToTrash } from "../trash";

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

const PREVIEW_LINES = 60;
function preview(text: string): string {
  const lines = text.split("\n");
  return lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join("\n") + `\n… (${lines.length - PREVIEW_LINES} more lines)` : text;
}

export const fileWriteKind: OperationKind<FileWriteParams, FileWriteCaptured> = {
  kind: "file.write",

  async describe(p) {
    if (isSensitivePath(p.path)) throw new Error(`refused: ${p.path} is secret material and is never written through a generic operation`);
    const lifeline = isLifelinePath(p.path);
    const existed = existsSync(p.path);
    const previous = existed ? readFileSync(p.path, "utf-8") : null;
    return {
      summary: `${existed ? "Overwrite" : "Create"} ${p.path} (${Buffer.byteLength(p.content)} bytes)`,
      autoApprove: false,
      class: lifeline ? "lifeline" : "mutate",
      writes: [dirname(p.path)],
      network: false,
      warning: lifeline ? "this file can affect SSH, networking, or Miro itself" : undefined,
      details: {
        path: p.path,
        existed,
        bytes: Buffer.byteLength(p.content),
        mode: p.mode !== undefined ? `0${p.mode.toString(8)}` : null,
        current: previous !== null ? preview(previous) : null,
        proposed: preview(p.content),
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
