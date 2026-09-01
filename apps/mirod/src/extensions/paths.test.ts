import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ensureNodeModulesSymlink,
  promoteStagingToLive,
  discardStaging,
  extensionDir,
  stagingDir,
  prevDir,
  EXTENSIONS_DIR,
} from "./paths";

// Real filesystem, real ~/.miro/extensions/ — same "no mocks, real everything" convention as
// secrets.test.ts's real temp key files. Uses a throwaway app name, cleaned up after every test.
const APP = "__paths_test_app__";

afterEach(() => {
  for (const dir of [extensionDir(APP), stagingDir(APP), prevDir(APP)]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureNodeModulesSymlink creates a symlink into the given node_modules", () => {
  const dir = extensionDir(APP);
  const fakeNodeModules = join(EXTENSIONS_DIR, "__fake_node_modules_for_test__");
  mkdirSync(fakeNodeModules, { recursive: true });

  ensureNodeModulesSymlink(dir, fakeNodeModules);

  const link = join(dir, "node_modules");
  expect(existsSync(link)).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  rmSync(fakeNodeModules, { recursive: true, force: true });
});

test("ensureNodeModulesSymlink is idempotent", () => {
  const dir = extensionDir(APP);
  const fakeNodeModules = join(EXTENSIONS_DIR, "__fake_node_modules_for_test__");
  mkdirSync(fakeNodeModules, { recursive: true });

  ensureNodeModulesSymlink(dir, fakeNodeModules);
  ensureNodeModulesSymlink(dir, fakeNodeModules); // must not throw
  expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
  rmSync(fakeNodeModules, { recursive: true, force: true });
});

test("promoteStagingToLive moves staging into place with no prior live dir", () => {
  mkdirSync(stagingDir(APP), { recursive: true });
  writeFileSync(join(stagingDir(APP), "manifest"), "v1");

  promoteStagingToLive(APP);

  expect(existsSync(extensionDir(APP))).toBe(true);
  expect(existsSync(stagingDir(APP))).toBe(false);
  expect(existsSync(prevDir(APP))).toBe(false);
});

test("promoteStagingToLive keeps exactly one prior generation, overwriting any older .prev", () => {
  mkdirSync(stagingDir(APP), { recursive: true });
  writeFileSync(join(stagingDir(APP), "manifest"), "v1");
  promoteStagingToLive(APP);

  mkdirSync(stagingDir(APP), { recursive: true });
  writeFileSync(join(stagingDir(APP), "manifest"), "v2");
  promoteStagingToLive(APP);

  expect(existsSync(prevDir(APP))).toBe(true);
  expect(Bun.file(join(prevDir(APP), "manifest")).text()).resolves.toBe("v1");
  expect(Bun.file(join(extensionDir(APP), "manifest")).text()).resolves.toBe("v2");

  mkdirSync(stagingDir(APP), { recursive: true });
  writeFileSync(join(stagingDir(APP), "manifest"), "v3");
  promoteStagingToLive(APP);

  // v1's .prev copy got overwritten by v2's — only one generation of history is ever kept.
  expect(Bun.file(join(prevDir(APP), "manifest")).text()).resolves.toBe("v2");
  expect(Bun.file(join(extensionDir(APP), "manifest")).text()).resolves.toBe("v3");
});

test("discardStaging removes a staging directory if present, no-op if absent", () => {
  expect(() => discardStaging(APP)).not.toThrow(); // absent case

  mkdirSync(stagingDir(APP), { recursive: true });
  writeFileSync(join(stagingDir(APP), "manifest"), "x");
  discardStaging(APP);
  expect(existsSync(stagingDir(APP))).toBe(false);
});

test("extensionDir/stagingDir/prevDir are distinct, stable paths for the same app", () => {
  expect(extensionDir("gotify")).not.toBe(stagingDir("gotify"));
  expect(extensionDir("gotify")).not.toBe(prevDir("gotify"));
  expect(stagingDir("gotify")).toContain("gotify.staging");
  expect(prevDir("gotify")).toContain("gotify.prev");
});
