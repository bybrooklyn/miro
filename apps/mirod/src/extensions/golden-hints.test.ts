import { test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadGoldenHint, formatGoldenHint, GOLDEN_HINTS_DIR } from "./golden-hints";

const TEST_APP = "__golden_hints_test_app__";
const TEST_PATH = join(GOLDEN_HINTS_DIR, `${TEST_APP}.json`);

afterEach(() => {
  if (existsSync(TEST_PATH)) rmSync(TEST_PATH);
});

test("loadGoldenHint returns null when no hint file exists for the app", () => {
  expect(loadGoldenHint("__no_such_app__")).toBeNull();
});

test("loadGoldenHint reads and parses a real hint file", () => {
  mkdirSync(GOLDEN_HINTS_DIR, { recursive: true });
  writeFileSync(TEST_PATH, JSON.stringify({ docsUrl: "https://example.com/docs", defaultPort: 1234, authScheme: "API key" }));

  expect(loadGoldenHint(TEST_APP)).toEqual({ docsUrl: "https://example.com/docs", defaultPort: 1234, authScheme: "API key" });
});

test("loadGoldenHint matches case-insensitively on trimmed app name", () => {
  mkdirSync(GOLDEN_HINTS_DIR, { recursive: true });
  writeFileSync(TEST_PATH, JSON.stringify({ docsUrl: "https://example.com" }));

  expect(loadGoldenHint(`  ${TEST_APP.toUpperCase()}  `)).toEqual({ docsUrl: "https://example.com" });
});

test("loadGoldenHint fails open (returns null) on malformed JSON", () => {
  mkdirSync(GOLDEN_HINTS_DIR, { recursive: true });
  writeFileSync(TEST_PATH, "{ not valid json");

  expect(loadGoldenHint(TEST_APP)).toBeNull();
});

test("formatGoldenHint joins only the fields present", () => {
  expect(formatGoldenHint({ docsUrl: "https://x.com", defaultPort: 80, authScheme: "none" })).toBe(
    "API docs: https://x.com; default port: 80; auth: none",
  );
  expect(formatGoldenHint({ defaultPort: 80 })).toBe("default port: 80");
  expect(formatGoldenHint({})).toBe("");
});

test("real jellyfin hint file, if present, parses and has the expected shape", () => {
  const hint = loadGoldenHint("jellyfin");
  if (hint) {
    expect(typeof hint.docsUrl === "string" || hint.docsUrl === undefined).toBe(true);
    expect(typeof hint.defaultPort === "number" || hint.defaultPort === undefined).toBe(true);
  }
});
