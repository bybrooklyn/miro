import { test, expect } from "bun:test";
import { unifiedDiff } from "./diff";

test("identical content yields an empty diff", () => {
  expect(unifiedDiff("a\nb\n", "a\nb\n", "/x")).toBe("");
});

test("a changed line in the middle produces one hunk with context", () => {
  const before = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  const after = ["one", "two", "three", "FOUR", "five", "six", "seven"].join("\n");
  const d = unifiedDiff(before, after, "/opt/x.conf");
  expect(d).toContain("--- /opt/x.conf\n+++ /opt/x.conf\n");
  expect(d).toContain("@@ -1,7 +1,7 @@");
  expect(d).toContain("-four\n+FOUR\n");
  expect(d.split("\n").filter((l) => l.startsWith(" ")).length).toBe(6);
});

test("a new file is all additions; an emptied file all removals", () => {
  expect(unifiedDiff("", "a\nb", "/n")).toContain("+a\n+b\n");
  expect(unifiedDiff("a\nb", "", "/n")).toContain("-a\n-b\n");
});

test("distant changes become separate hunks", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[2] = "CHANGED 2";
  changed[35] = "CHANGED 35";
  const d = unifiedDiff(lines.join("\n"), changed.join("\n"), "/f");
  expect((d.match(/^@@/gm) ?? []).length).toBe(2);
});

test("oversized inputs degrade to a marker instead of blowing up", () => {
  const big = Array.from({ length: 5000 }, (_, i) => String(i)).join("\n");
  expect(unifiedDiff(big, big + "\nx", "/big")).toContain("too large");
});
