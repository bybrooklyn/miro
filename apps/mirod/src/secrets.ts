import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Database } from "bun:sqlite";

// Local encrypted secret store (plan §46). Values are encrypted at rest with a machine-local key
// file (0600), so they're unreadable by casually browsing ~/.miro/miro.db.
// ponytail: not a hardware-backed keystore (Keychain/libsecret) - a file-permission-protected key
// is the v1 bar here; upgrade to a real OS keystore if that's ever load-bearing.

/** "<namespace>.<name>", e.g. "provider.anthropic", "transport.iroh_secret_key", "sonarr.api". The
 * model only ever sees refs like this - real values are resolved inside an operation's
 * apply/captureState/verify/rollback, never in describe() or any read-only tool. */
export type SecretRef = string;

export interface SecretStore {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  ensureTable(db: Database): void;
  setSecret(db: Database, ref: SecretRef, value: string): void;
  getSecret(db: Database, ref: SecretRef): string | null;
  /** Remove a secret so that its ciphertext does not stay readable in the database file. */
  deleteSecret(db: Database, ref: SecretRef): boolean;
}

export function ensureSecretsTable(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)");
  // SQLite leaves a deleted or overwritten cell's bytes in the page until it is reused, so a rotated
  // or removed credential stays recoverable from the file - next to secret.key, in the same directory,
  // and in any copy of it. Found live: a secret deleted from a busy database was still readable in
  // miro.db afterwards, with no live row referencing it. secure_delete makes SQLite zero freed content
  // instead. Set per connection, so it is set here rather than only at boot: every process that opens
  // this database (the daemon, `mirod secret set`, the status CLI) gets it.
  db.exec("PRAGMA secure_delete = ON");
}

/** Refs only, never values - what an agent is told it already holds ("credentials on file").
 * Found live: with the admin password Miro itself had created sitting under
 * extension.jellyfin.admin_password, both agents asked the user for it, because nothing listed it. */
export function listSecretRefs(db: Database, prefix = ""): SecretRef[] {
  const rows = db.query("SELECT ref FROM secrets WHERE ref LIKE ? ORDER BY ref").all(`${prefix}%`) as { ref: string }[];
  return rows.map((r) => r.ref);
}

export function createSecretStore(keyPath: string): SecretStore {
  function loadOrCreateKey(): Buffer {
    if (existsSync(keyPath)) {
      const key = readFileSync(keyPath);
      // A truncated key file (a crash during the first write) would otherwise surface as
      // "Invalid key length" from every encrypt/decrypt for the process's whole life, with nothing
      // pointing at the file (audit B6). Named here, once, at boot.
      if (key.length !== 32) throw new Error(`${keyPath} is not a 32-byte key (${key.length} bytes) - the file is truncated or not a key; move it aside to start fresh (secrets encrypted with the original key are unreadable without it)`);
      return key;
    }
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
    ensureTable: ensureSecretsTable,
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
    deleteSecret(db, ref) {
      const row = db.query("SELECT ciphertext FROM secrets WHERE ref = ?").get(ref) as { ciphertext: string } | null;
      if (!row) return false;
      // Overwrite in place before deleting, and with the same length so the update rewrites the cell
      // rather than relocating the row. Belt and braces on top of secure_delete: this holds even on a
      // database some other process opened without the pragma.
      db.run("UPDATE secrets SET ciphertext = ? WHERE ref = ?", ["0".repeat(row.ciphertext.length), ref]);
      db.run("DELETE FROM secrets WHERE ref = ?", [ref]);
      return true;
    },
  };
}
