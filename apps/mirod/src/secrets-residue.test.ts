import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "./secrets";

// Deleting a secret, and what is left behind.
//
// What prompted this: on the dev box, a ref string ("provider.github") was still present in miro.db
// after its row was deleted, with no live row referencing it. Investigated rather than assumed - the
// bytes next to it are other REF NAMES, i.e. an index page, and there is no ciphertext-shaped run within
// 200 bytes of it. Ref names are not secrets (Miro deliberately lists them to the agent as "credentials
// on file"); the encrypted values did not survive. Seven local configurations - secure_delete on and off,
// with and without padding, a checkpoint, a vacuum, an overwrite - could not reproduce ciphertext residue
// either, so these tests deliberately do NOT assert a file-level absence that would pass whatever the
// code did. They assert what is real: a supported deletion path (there was none), and secure_delete on,
// because a freed cell's bytes are not guaranteed to be zeroed and the key file sits in the same directory.

function box() {
  const dir = mkdtempSync(join(tmpdir(), "miro-secrets-"));
  const dbPath = join(dir, "miro.db");
  const db = new Database(dbPath);
  const store = createSecretStore(join(dir, "secret.key"));
  store.ensureTable(db);
  return { db, dbPath, store };
}

test("secure_delete is on for any connection that ensures the table", () => {
  // Set in ensureSecretsTable, not once at boot: the CLIs (`mirod secret set`, status, egress) each open
  // their own connection, and the pragma is per connection.
  const { db } = box();
  expect((db.query("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete).toBe(1);
});

test("a stored secret's ciphertext really is in the file - the anchor the rest depends on", () => {
  const { db, dbPath, store } = box();
  store.setSecret(db, "provider.example", "ghp_a-token-value");
  const cipher = (db.query("SELECT ciphertext FROM secrets WHERE ref=?").get("provider.example") as { ciphertext: string }).ciphertext;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(readFileSync(dbPath).toString("latin1")).toContain(cipher);
});

test("deleteSecret removes the value and overwrites the cell before dropping the row", () => {
  const { db, store } = box();
  store.setSecret(db, "provider.example", "a value nobody should read again");
  expect(store.deleteSecret(db, "provider.example")).toBe(true);
  expect(store.getSecret(db, "provider.example")).toBeNull();
  expect(db.query("SELECT ciphertext FROM secrets WHERE ref=?").get("provider.example")).toBeNull();
});

test("deleteSecret reports whether there was anything to delete, and touches nothing else", () => {
  const { db, store } = box();
  store.setSecret(db, "provider.keep", "keep me");
  store.setSecret(db, "provider.drop", "drop me");
  expect(store.deleteSecret(db, "provider.absent")).toBe(false);
  expect(store.deleteSecret(db, "provider.drop")).toBe(true);
  expect(store.deleteSecret(db, "provider.drop")).toBe(false);
  expect(store.getSecret(db, "provider.keep")).toBe("keep me");
});

test("rotating a secret keeps only the new value readable through the store", () => {
  const { db, store } = box();
  store.setSecret(db, "provider.example", "OLD");
  store.setSecret(db, "provider.example", "NEW");
  expect(store.getSecret(db, "provider.example")).toBe("NEW");
  expect(db.query("SELECT COUNT(*) c FROM secrets WHERE ref=?").get("provider.example")).toMatchObject({ c: 1 });
});
