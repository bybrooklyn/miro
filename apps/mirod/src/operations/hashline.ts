import { createHash } from "node:crypto";

// Hash-anchored edits (PLAN.md §5.14 slice 2, after omp's hashline): a file is shown to the model
// with every line tagged `N:hhhh|` (its number and a short content hash), and an edit names the
// lines it touches by those anchors. The daemon checks every anchor against the file as it is NOW
// before touching it - a line that moved or changed since the model read the file is a refusal
// ("read it again"), never a guess. No str-replace ambiguity, no whole-file rewrite (file_write's
// failure mode on a 500-line config), and a diff the owner reviews. Pure and unit-tested; the
// file.edit kind is the thin shell around it.

export const ANCHOR = /^(\d+):([0-9a-f]{4})$/;

export function lineHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 4);
}

export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  // A trailing newline is not an extra empty line to edit; it is put back on join.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The view the model edits against: `N:hhhh|text`, N from 1. */
export function anchoredView(content: string): string {
  return splitLines(content)
    .map((line, i) => `${i + 1}:${lineHash(line)}|${line}`)
    .join("\n");
}

export type EditOp = "replace" | "insert_after" | "delete";

export interface AnchoredEdit {
  /** First line of the range, as `N:hhhh` from the anchored view. */
  anchor: string;
  /** Last line of the range (inclusive), same form; defaults to `anchor`. Ignored for insert_after. */
  to?: string;
  op: EditOp;
  /** The new lines (replace / insert_after). */
  lines?: string[];
}

export class StaleAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleAnchorError";
  }
}

function parseAnchor(anchor: string, lines: string[]): number {
  const m = ANCHOR.exec(anchor.trim());
  if (!m) throw new Error(`refused: "${anchor}" is not an anchor - use the N:hhhh tags from read_file with anchored: true`);
  const n = Number(m[1]);
  if (n < 1 || n > lines.length) throw new StaleAnchorError(`refused: anchor ${anchor} is past the end of the file (${lines.length} lines) - read it again with anchored: true`);
  const actual = lineHash(lines[n - 1]!);
  if (actual !== m[2]) throw new StaleAnchorError(`refused: anchor ${anchor} no longer matches line ${n} (now ${n}:${actual}) - the file changed since you read it; read it again with anchored: true`);
  return n;
}

/** Applies the edits to `content`, checking every anchor against it first. Edits are applied
 * bottom-up so line numbers stay valid; overlapping ranges are refused. */
export function applyEdits(content: string, edits: AnchoredEdit[]): string {
  if (edits.length === 0) throw new Error("refused: no edits given");
  const lines = splitLines(content);
  const resolved = edits.map((e, i) => {
    const start = parseAnchor(e.anchor, lines);
    const end = e.op === "insert_after" || !e.to ? start : parseAnchor(e.to, lines);
    if (end < start) throw new Error(`refused: edit ${i + 1} ends (${e.to}) before it starts (${e.anchor})`);
    if ((e.op === "replace" || e.op === "insert_after") && !e.lines) throw new Error(`refused: edit ${i + 1} (${e.op}) needs lines`);
    return { ...e, start, end, index: i };
  });
  const byLine = [...resolved].sort((a, b) => a.start - b.start || a.index - b.index);
  for (let i = 1; i < byLine.length; i++) {
    const prev = byLine[i - 1]!;
    const cur = byLine[i]!;
    const prevEnd = prev.op === "insert_after" ? prev.start - 1 : prev.end; // an insert touches no existing line
    const curStart = cur.op === "insert_after" ? cur.start + 1 : cur.start;
    if (curStart <= prevEnd) throw new Error(`refused: edits ${prev.index + 1} and ${cur.index + 1} overlap (lines ${cur.start}..${prev.end})`);
  }
  const out = [...lines];
  for (const e of [...resolved].sort((a, b) => b.start - a.start || b.index - a.index)) {
    if (e.op === "replace") out.splice(e.start - 1, e.end - e.start + 1, ...(e.lines ?? []));
    else if (e.op === "insert_after") out.splice(e.start, 0, ...(e.lines ?? []));
    else out.splice(e.start - 1, e.end - e.start + 1);
  }
  return out.join("\n") + (content.endsWith("\n") || content === "" ? "\n" : "");
}
