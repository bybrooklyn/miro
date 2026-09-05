import { test, expect } from "bun:test";
import { createLineBuffer, encodeLine } from "./index";

test("createLineBuffer splits lines that arrive in one chunk", () => {
  const out: string[] = [];
  const feed = createLineBuffer((line) => out.push(line));
  feed('{"a":1}\n{"a":2}\n');
  expect(out).toEqual(['{"a":1}', '{"a":2}']);
});

test("createLineBuffer reassembles a line split across chunks", () => {
  const out: string[] = [];
  const feed = createLineBuffer((line) => out.push(line));
  feed('{"a":1');
  feed('2}\n');
  expect(out).toEqual(['{"a":12}']);
});

test("createLineBuffer decodes a multi-byte character split across chunks (audit #2)", () => {
  const line = encodeLine({ type: "reply_delta", text: "café ✓ 日本 🔑" });
  const bytes = Buffer.from(line, "utf8");
  for (let cut = 1; cut < bytes.length; cut++) {
    const out: string[] = [];
    const feed = createLineBuffer((l) => out.push(l));
    feed(bytes.subarray(0, cut));
    feed(bytes.subarray(cut));
    expect(out).toEqual([line.trimEnd()]);
  }
});

test("createLineBuffer drops an oversized line instead of growing without bound", async () => {
  const { MAX_LINE_BYTES } = await import("./index");
  const out: string[] = [];
  const feed = createLineBuffer((l) => out.push(l));
  feed("x".repeat(MAX_LINE_BYTES + 1));
  feed("tail\n" + '{"ok":1}\n');
  expect(out).toEqual(['{"ok":1}']); // the oversized line and its tail are gone; the next line is intact
});

test("encodeLine round-trips through createLineBuffer", () => {
  const out: unknown[] = [];
  const feed = createLineBuffer((line) => out.push(JSON.parse(line)));
  feed(encodeLine({ type: "reply", text: "hey" }));
  expect(out).toEqual([{ type: "reply", text: "hey" }]);
});
