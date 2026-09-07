import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "../secrets";
import { importSecretDropFiles } from "./drop-file";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "dropf-"));
  const dir = join(base, "secrets.d"); // the scanned drop dir - separate from the key file
  mkdirSync(dir);
  const db = new Database(":memory:");
  const store = createSecretStore(join(base, "secret.key")); // key lives OUTSIDE the drop dir, like production
  store.ensureTable(db);
  return { dir, db, store };
}

test("imports a valid-ref file, stores it, and shreds it", () => {
  const { dir, db, store } = setup();
  writeFileSync(join(dir, "provider.github"), "ghp_abc123\n");
  const n = importSecretDropFiles(db, store, dir);
  expect(n).toBe(1);
  expect(store.getSecret(db, "provider.github")).toBe("ghp_abc123");
  expect(existsSync(join(dir, "provider.github"))).toBe(false); // shredded
});

test("ignores a filename that isn't a <namespace>.<name> ref, and leaves it in place", () => {
  const { dir, db, store } = setup();
  writeFileSync(join(dir, "notaref"), "value");
  writeFileSync(join(dir, ".hidden"), "value");
  const n = importSecretDropFiles(db, store, dir);
  expect(n).toBe(0);
  expect(existsSync(join(dir, "notaref"))).toBe(true); // left for the owner to see the warning
});

test("a deep ref (extension.gluetun.wg_private_key) is accepted", () => {
  const { dir, db, store } = setup();
  writeFileSync(join(dir, "extension.gluetun.wg_private_key"), "KEY=");
  expect(importSecretDropFiles(db, store, dir)).toBe(1);
  expect(store.getSecret(db, "extension.gluetun.wg_private_key")).toBe("KEY=");
});
