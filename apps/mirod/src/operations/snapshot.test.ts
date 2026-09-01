import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotPaths, restoreSnapshot, sizeOf } from "./snapshot";

let work: string;
let snaps: string;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "snap-work-")));
  snaps = realpathSync(mkdtempSync(join(tmpdir(), "snap-dir-")));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(snaps, { recursive: true, force: true });
});

test("sizeOf walks directories and stops early past the cap", () => {
  mkdirSync(join(work, "d"));
  writeFileSync(join(work, "d", "a"), "x".repeat(100));
  writeFileSync(join(work, "d", "b"), "y".repeat(50));
  expect(sizeOf(join(work, "d"))).toBe(150);
  expect(sizeOf(join(work, "d"), 10)).toBeGreaterThan(10);
});

test("snapshot then restore brings modified and removed files back", async () => {
  const root = join(work, "app");
  mkdirSync(root);
  writeFileSync(join(root, "conf"), "original");
  writeFileSync(join(root, "keep"), "keep");

  const snap = await snapshotPaths([root], "t1", snaps);
  expect(snap.archive).not.toBeNull();
  expect(snap.paths).toEqual([root]);

  writeFileSync(join(root, "conf"), "changed");
  rmSync(join(root, "keep"));

  await restoreSnapshot(snap);
  expect(readFileSync(join(root, "conf"), "utf-8")).toBe("original");
  expect(readFileSync(join(root, "keep"), "utf-8")).toBe("keep");
});

test("paths that do not exist yet are recorded as skipped, not errors", async () => {
  const snap = await snapshotPaths([join(work, "later")], "t2", snaps);
  expect(snap.archive).toBeNull();
  expect(snap.skipped[0].reason).toContain("does not exist");
});

test("over the size cap, nothing is archived and every path is marked skipped with the reason", async () => {
  const big = join(work, "big");
  mkdirSync(big);
  writeFileSync(join(big, "blob"), Buffer.alloc(2048));
  const snap = await snapshotPaths([big], "t3", snaps, 1024);
  expect(snap.archive).toBeNull();
  expect(snap.skipped.map((s) => s.path)).toEqual([big]);
  expect(snap.skipped[0].reason).toContain("cap");
  expect(existsSync(join(snaps, "t3.tar"))).toBe(false);
});
