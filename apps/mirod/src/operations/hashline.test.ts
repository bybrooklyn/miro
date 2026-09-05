import { test, expect } from "bun:test";
import { anchoredView, applyEdits, lineHash, StaleAnchorError } from "./hashline";

const CONFIG = "[server]\nport = 8096\nbind = 0.0.0.0\n\n[log]\nlevel = info\n";

function anchor(content: string, n: number): string {
  return `${n}:${lineHash(content.split("\n")[n - 1]!)}`;
}

test("anchoredView tags every line with its number and a short content hash; a trailing newline is not a line", () => {
  const view = anchoredView(CONFIG);
  const lines = view.split("\n");
  expect(lines).toHaveLength(6);
  expect(lines[0]).toBe(`1:${lineHash("[server]")}|[server]`);
  expect(lines[3]).toBe(`4:${lineHash("")}|`);
  expect(anchoredView("")).toBe(`1:${lineHash("")}|`);
});

test("replace, insert_after and delete against anchors, applied bottom-up so earlier anchors stay valid", () => {
  const edited = applyEdits(CONFIG, [
    { anchor: anchor(CONFIG, 2), op: "replace", lines: ["port = 8920"] },
    { anchor: anchor(CONFIG, 6), op: "insert_after", lines: ["file = /var/log/app.log"] },
    { anchor: anchor(CONFIG, 3), to: anchor(CONFIG, 4), op: "delete" },
  ]);
  expect(edited).toBe("[server]\nport = 8920\n[log]\nlevel = info\nfile = /var/log/app.log\n");
  // A file without a trailing newline stays that way.
  expect(applyEdits("a\nb", [{ anchor: `2:${lineHash("b")}`, op: "replace", lines: ["c"] }])).toBe("a\nc");
});

test("a stale or malformed anchor is refused with the current tag, never guessed", () => {
  const changed = CONFIG.replace("8096", "9000");
  expect(() => applyEdits(changed, [{ anchor: anchor(CONFIG, 2), op: "delete" }])).toThrow(StaleAnchorError);
  expect(() => applyEdits(changed, [{ anchor: anchor(CONFIG, 2), op: "delete" }])).toThrow(/no longer matches line 2 \(now 2:[0-9a-f]{4}\)/);
  expect(() => applyEdits(CONFIG, [{ anchor: "9:abcd", op: "delete" }])).toThrow(/past the end/);
  expect(() => applyEdits(CONFIG, [{ anchor: "port = 8096", op: "delete" }])).toThrow(/not an anchor/);
  expect(() => applyEdits(CONFIG, [])).toThrow(/no edits/);
  expect(() => applyEdits(CONFIG, [{ anchor: anchor(CONFIG, 2), op: "replace" }])).toThrow(/needs lines/);
});

test("overlapping ranges and inverted ranges are refused; an insert next to a replace is not an overlap", () => {
  expect(() => applyEdits(CONFIG, [{ anchor: anchor(CONFIG, 1), to: anchor(CONFIG, 3), op: "delete" }, { anchor: anchor(CONFIG, 2), op: "replace", lines: ["x"] }])).toThrow(/overlap/);
  expect(() => applyEdits(CONFIG, [{ anchor: anchor(CONFIG, 3), to: anchor(CONFIG, 1), op: "delete" }])).toThrow(/ends .* before it starts/);
  expect(applyEdits(CONFIG, [{ anchor: anchor(CONFIG, 2), op: "replace", lines: ["port = 1"] }, { anchor: anchor(CONFIG, 2), op: "insert_after", lines: ["extra = 1"] }])).toBe("[server]\nport = 1\nextra = 1\nbind = 0.0.0.0\n\n[log]\nlevel = info\n");
});
