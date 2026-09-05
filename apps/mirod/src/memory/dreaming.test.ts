import { test, expect } from "bun:test";
import { isLikelyCorrection, parseRememberJson } from "./dreaming";

// The LLM call itself isn't unit-tested here; worker.test.ts drives spawnWorker with a mock model
// and covers the loop, so what remains is the pure parsing and the correction heuristic.

test("isLikelyCorrection matches common correction phrasings", () => {
  expect(isLikelyCorrection("No, that's not what I asked")).toBe(true);
  expect(isLikelyCorrection("that's wrong")).toBe(true);
  expect(isLikelyCorrection("actually, I meant the other one")).toBe(true);
  expect(isLikelyCorrection("don't do that")).toBe(true);
});

test("isLikelyCorrection doesn't flag ordinary messages", () => {
  expect(isLikelyCorrection("what's the disk usage on this server?")).toBe(false);
  expect(isLikelyCorrection("thanks, that worked")).toBe(false);
});

test("parseRememberJson extracts a well-formed remember array", () => {
  const text = 'Sure, here you go: {"remember": [{"category": "preference", "key": "reply_style", "value": "terse"}]}';
  expect(parseRememberJson(text)).toEqual([{ category: "preference", key: "reply_style", value: "terse" }]);
});

test("parseRememberJson returns an empty array for an empty remember list", () => {
  expect(parseRememberJson('{"remember": []}')).toEqual([]);
});

test("parseRememberJson is a silent no-op on malformed text", () => {
  expect(parseRememberJson("not json at all")).toEqual([]);
  expect(parseRememberJson("")).toEqual([]);
});
