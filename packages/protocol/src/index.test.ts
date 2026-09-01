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

test("encodeLine round-trips through createLineBuffer", () => {
  const out: unknown[] = [];
  const feed = createLineBuffer((line) => out.push(JSON.parse(line)));
  feed(encodeLine({ type: "reply", text: "hey" }));
  expect(out).toEqual([{ type: "reply", text: "hey" }]);
});
