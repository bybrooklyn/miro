import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trashDestination, moveToTrash, restoreFromTrash, listTrash } from "./trash";

// Real filesystem, a throwaway trash directory per test — no mocks.

let work: string;
let trash: string;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "trash-work-")));
  trash = realpathSync(mkdtempSync(join(tmpdir(), "trash-dir-")));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(trash, { recursive: true, force: true });
});

test("destination is under the trash dir and mirrors the original absolute path", () => {
  const entry = trashDestination(join(work, "a", "b.txt"), trash);
  expect(entry.trashedPath.startsWith(trash + "/")).toBe(true);
  expect(entry.trashedPath.endsWith(join(work, "a", "b.txt"))).toBe(true);
  expect(entry.originalPath).toBe(join(work, "a", "b.txt"));
});

test("move to trash then restore round-trips a file, and the index tracks both", () => {
  const p = join(work, "config.ini");
  writeFileSync(p, "key=value");
  const entry = trashDestination(p, trash);

  moveToTrash(entry, trash);
  expect(existsSync(p)).toBe(false);
  expect(readFileSync(entry.trashedPath, "utf-8")).toBe("key=value");
  expect(listTrash(trash).map((e) => e.id)).toEqual([entry.id]);

  restoreFromTrash(entry, trash);
  expect(readFileSync(p, "utf-8")).toBe("key=value");
  expect(existsSync(entry.trashedPath)).toBe(false);
  expect(listTrash(trash)).toEqual([]);
});

test("directories move whole", () => {
  const dir = join(work, "media");
  mkdirSync(join(dir, "movies"), { recursive: true });
  writeFileSync(join(dir, "movies", "x.mkv"), "bytes");
  const entry = trashDestination(dir, trash);
  moveToTrash(entry, trash);
  expect(existsSync(dir)).toBe(false);
  expect(readFileSync(join(entry.trashedPath, "movies", "x.mkv"), "utf-8")).toBe("bytes");
  restoreFromTrash(entry, trash);
  expect(readFileSync(join(dir, "movies", "x.mkv"), "utf-8")).toBe("bytes");
});

test("restore refuses to overwrite a path that exists again", () => {
  const p = join(work, "f");
  writeFileSync(p, "1");
  const entry = trashDestination(p, trash);
  moveToTrash(entry, trash);
  writeFileSync(p, "2");
  expect(() => restoreFromTrash(entry, trash)).toThrow(/exists again/);
  expect(readFileSync(p, "utf-8")).toBe("2");
});

test("moving a missing path is an error, not a silent no-op", () => {
  expect(() => moveToTrash(trashDestination(join(work, "nope"), trash), trash)).toThrow(/does not exist/);
});
