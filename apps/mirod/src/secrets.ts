import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Database } from "bun:sqlite";

// Local encrypted secret store (plan §46). Values are encrypted at rest with a machine-local key
// file (0600), so they're unreadable by casually browsing ~/.miro/miro.db.
// ponytail: not a hardware-backed keystore (Keychain/libsecret) — a file-permission-protected key
// is the v1 bar here; upgrade to a real OS keystore if that's ever load-bearing.

/** "<namespace>.<name>", e.g. "provider.anthropic", "transport.iroh_secret_key", "sonarr.api". The
 * model only ever sees refs like this — real values are resolved inside an operation's
 * apply/captureState/verify/rollback, never in describe() or any read-only tool. */
export type SecretRef = string;

export interface SecretStore {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  ensureTable(db: Database): void;
  setSecret(db: Database, ref: SecretRef, value: string): void;
  getSecret(db: Database, ref: SecretRef): string | null;
}

export function createSecretStore(keyPath: string): SecretStore {
  function loadOrCreateKey(): Buffer {
    if (existsSync(keyPath)) return readFileSync(keyPath);
    const key = randomBytes(32);
    writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }

  const key = loadOrCreateKey();

  function encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  }

  function decrypt(encoded: string): string {
    const raw = Buffer.from(encoded, "base64");
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  return {
    encrypt,
    decrypt,
    ensureTable(db) {
      db.run("CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)");
    },
    setSecret(db, ref, value) {
      db.run(
        "INSERT INTO secrets (ref, ciphertext) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext",
        [ref, encrypt(value)],
      );
    },
    getSecret(db, ref) {
      const row = db.query("SELECT ciphertext FROM secrets WHERE ref = ?").get(ref) as
        | { ciphertext: string }
        | null;
      return row ? decrypt(row.ciphertext) : null;
    },
  };
}
