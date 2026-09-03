import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, scanRoot, ensureFsIndexTable, indexRoot, queryByClass } from "./filesystem";

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "miro-fs-index-test-"));
  writeFileSync(join(root, "movie.mp4"), "fake video bytes");
  writeFileSync(join(root, "config.yaml"), "key: value");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "app.ts"), "export {};");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "ignored.js"), "// should not be indexed");
  return root;
}

test("classify maps known extensions to semantic classes", () => {
  expect(classify("/media/movie.mp4")).toBe("media");
  expect(classify("/etc/app/config.yaml")).toBe("config");
  expect(classify("/src/index.ts")).toBe("code");
  expect(classify("/backups/data.zip")).toBe("archive");
  expect(classify("/random/file.xyz")).toBe("other");
});

test("scanRoot walks a real directory tree, classifying files and skipping noisy dirs", () => {
  const root = fixtureTree();
  const entries = scanRoot(root);

  const byPath = new Map(entries.map((e) => [e.path, e]));
  expect(byPath.get(join(root, "movie.mp4"))?.class).toBe("media");
  expect(byPath.get(join(root, "config.yaml"))?.class).toBe("config");
  expect(byPath.get(join(root, "sub", "app.ts"))?.class).toBe("code");
  // node_modules is a real directory that exists on disk - it must not appear in the results.
  expect(entries.some((e) => e.path.includes("node_modules"))).toBe(false);

  rmSync(root, { recursive: true, force: true });
});

test("scanRoot respects maxDepth", () => {
  const root = fixtureTree();
  const shallow = scanRoot(root, { maxDepth: 0 });
  // Depth 0 sees only immediate children of root, not sub/app.ts
  expect(shallow.some((e) => e.path.includes("app.ts"))).toBe(false);
  expect(shallow.some((e) => e.path.endsWith("movie.mp4"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("indexRoot persists real scan results to SQLite and queryByClass reads them back", () => {
  const root = fixtureTree();
  const db = new Database(":memory:");
  ensureFsIndexTable(db);

  const count = indexRoot(db, root);
  expect(count).toBeGreaterThan(0);

  const media = queryByClass(db, "media");
  expect(media.some((e) => e.path === join(root, "movie.mp4"))).toBe(true);

  rmSync(root, { recursive: true, force: true });
});
