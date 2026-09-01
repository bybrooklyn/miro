import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "./secrets";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "miro-secrets-test-"));
  return { store: createSecretStore(join(dir, "secret.key")), dir };
}

test("encrypt/decrypt round-trips and ciphertext isn't the plaintext", () => {
  const { store, dir } = tempStore();
  const ciphertext = store.encrypt("sk-anthropic-abc123");
  expect(ciphertext).not.toContain("sk-anthropic-abc123");
  expect(store.decrypt(ciphertext)).toBe("sk-anthropic-abc123");
  rmSync(dir, { recursive: true, force: true });
});

test("setSecret/getSecret round-trip through SQLite", () => {
  const { store, dir } = tempStore();
  const db = new Database(":memory:");
  store.ensureTable(db);
  store.setSecret(db, "provider.anthropic", "sk-real-key");
  expect(store.getSecret(db, "provider.anthropic")).toBe("sk-real-key");
  expect(store.getSecret(db, "provider.openai")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("two stores with different key files can't decrypt each other's ciphertext", () => {
  const a = tempStore();
  const b = tempStore();
  const ciphertext = a.store.encrypt("secret");
  expect(() => b.store.decrypt(ciphertext)).toThrow();
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});
