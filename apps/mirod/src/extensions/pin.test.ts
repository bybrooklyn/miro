import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExtensionsTable, promote, getExtension } from "./store";
import { hashExtension, assertPinned, PinMismatchError } from "./pin";

// Real temp directory, real :memory: DB - the exact files and row the daemon would use.
function promotedExtension(contentHash: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "miro-pin-test-"));
  writeFileSync(join(dir, "extension.ts"), 'export default { entries: [] };\n');
  writeFileSync(join(dir, "manifest"), '{"app":"demo","tools":[]}');
  const db = new Database(":memory:");
  ensureExtensionsTable(db);
  promote(db, "demo", '{"app":"demo","tools":[]}', 1, "http://localhost:1", contentHash);
  return { dir, db };
}

test("hashExtension is stable for the same bytes and changes with either file", () => {
  const { dir } = promotedExtension(null);
  const before = hashExtension(dir);
  expect(hashExtension(dir)).toBe(before);
  appendFileSync(join(dir, "manifest"), " ");
  expect(hashExtension(dir)).not.toBe(before);
});

test("a promoted extension whose code is unchanged passes every check", () => {
  const { dir, db } = promotedExtension(null);
  const hash = hashExtension(dir);
  promote(db, "demo", "{}", 2, "http://localhost:1", hash);
  expect(() => assertPinned(db, "demo", dir)).not.toThrow();
  expect(getExtension(db, "demo")!.state).toBe("enabled");
});

test("a row promoted before pinning existed is pinned as it stands on first use, then enforced", () => {
  const { dir, db } = promotedExtension(null);
  expect(getExtension(db, "demo")!.contentHash).toBeNull();
  assertPinned(db, "demo", dir);
  expect(getExtension(db, "demo")!.contentHash).toBe(hashExtension(dir));
  // Now a change is caught, not silently re-pinned.
  appendFileSync(join(dir, "extension.ts"), "// tampered\n");
  expect(() => assertPinned(db, "demo", dir)).toThrow(PinMismatchError);
});

test("code changed after promotion disables the extension and refuses to run it", () => {
  const { dir, db } = promotedExtension(null);
  promote(db, "demo", "{}", 2, "http://localhost:1", hashExtension(dir));
  appendFileSync(join(dir, "extension.ts"), "export const evil = 1;\n");
  expect(() => assertPinned(db, "demo", dir)).toThrow(/does not match what was validated/);
  const row = getExtension(db, "demo")!;
  expect(row.state).toBe("disabled");
  expect(row.lastError).toMatch(/content hash mismatch/);
  // A disabled extension is left alone by later checks (nothing to protect any more).
  expect(() => assertPinned(db, "demo", dir)).not.toThrow();
});
