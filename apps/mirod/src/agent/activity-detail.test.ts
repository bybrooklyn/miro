import { test, expect } from "bun:test";
import { describeJson, summarizeResult } from "./model-utils";

// An activity's `detail` is documented as "short outcome text - never a full payload". Truncating JSON
// at 120 characters still sent a payload, just a broken one: the web transcript showed
// `{ "interfaces": [ { "name": "lo0", "address"…`. These assert it describes instead of quoting.

test("an array is described by its size, not its contents", () => {
  expect(describeJson([1, 2, 3])).toBe("3 items");
  expect(describeJson([{ big: "object" }])).toBe("1 item");
  expect(describeJson([])).toBe("0 items");
});

test("an object prefers the field that says what happened", () => {
  expect(describeJson({ message: "Done - verified." })).toBe("Done - verified.");
  expect(describeJson({ outcome: "committed", extra: 1 })).toBe("committed");
  expect(describeJson({ error: "no such stack" })).toBe("no such stack");
  expect(describeJson({ ok: true })).toBe("ok");
  expect(describeJson({ ok: false })).toBe("failed");
});

test("an object with nothing to say lists its fields, bounded", () => {
  expect(describeJson({ a: 1, b: 2 })).toBe("a, b");
  expect(describeJson({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toBe("a, b, c, d, +2 more");
  expect(describeJson({})).toBe("nothing");
});

test("a real tool result is described rather than quoted", () => {
  // The exact shape that produced the garbage line in the web UI.
  const payload = JSON.stringify({ interfaces: [{ name: "lo0", address: "127.0.0.1", family: "IPv4", internal: true, mac: "00:00:00:00:00:00" }], hostname: "box" });
  const detail = summarizeResult({ content: [{ text: payload }] }, false)!;
  expect(detail).toBe("interfaces, hostname");
  expect(detail).not.toContain("{");
  expect(detail).not.toContain("…");
});

test("prose results are still passed through, and long ones truncated", () => {
  expect(summarizeResult("Deployed and verified.", false)).toBe("Deployed and verified.");
  const long = "x".repeat(500);
  const out = summarizeResult(long, false)!;
  expect(out.length).toBeLessThanOrEqual(120);
  expect(out.endsWith("…")).toBe(true);
});

test("something that starts like JSON but is not stays prose", () => {
  expect(summarizeResult("[warning] disk almost full", false)).toBe("[warning] disk almost full");
});

test("an error with no text still says something", () => {
  expect(summarizeResult(undefined, true)).toBe("failed");
  expect(summarizeResult("   ", true)).toBe("failed");
  expect(summarizeResult(undefined, false)).toBeUndefined();
});
