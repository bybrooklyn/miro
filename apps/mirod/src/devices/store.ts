import type { Database } from "bun:sqlite";
import { randomBytes, createHash } from "node:crypto";

// Paired devices and the short-lived codes that create them (PLAN.md deploy-anywhere PR 2). Before
// this, possession of the Iroh ticket was permanent, unrevocable, full daemon access - `/pair` said so
// out loud. Now a ticket only says where the box is; a device also needs a token it redeemed from a
// code that expires and can only be used once.
//
// The local unix socket is deliberately NOT covered here: /run/miro is 0750 root:miro and the socket
// 0660, so being able to open it already proves you are on the box and in the group. Adding a token
// there would be a second, weaker copy of a check the kernel already made.

export interface Device {
  id: string;
  name: string;
  transport: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface DeviceRow {
  id: string;
  name: string;
  transport: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

function fromRow(r: DeviceRow): Device {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  };
}

export function ensureDevicesTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  )`);
}

/** Only the hash is ever stored, so a stolen database cannot be replayed as a device. */
function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const CODE_TTL_MS = 10 * 60 * 1000;

/** A pairing code: 9 digits, grouped for reading aloud. Short-lived and single-use, so a code seen
 * over a shoulder or left in a scrollback is worthless minutes later. */
export function mintPairingCode(db: Database, ttlMs = CODE_TTL_MS, now = Date.now()): string {
  // 9 digits from rejection-free arithmetic on 4 random bytes is fine here: the value only has to be
  // unguessable for ten minutes against an attacker who must also already reach the endpoint.
  let code = "";
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0) % 1_000_000_000;
    code = String(n).padStart(9, "0");
    if (!db.query("SELECT code FROM pairing_codes WHERE code = ?").get(code)) break;
  }
  db.run("INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?,?,?)", [code, now, now + ttlMs]);
  // Housekeeping: codes are worthless once expired, and nobody audits them.
  db.run("DELETE FROM pairing_codes WHERE expires_at < ?", [now - ttlMs]);
  return code;
}

export interface PairedDevice {
  device: Device;
  /** Shown to the redeeming client exactly once - only its hash is kept. */
  token: string;
}

export type RedeemResult = PairedDevice | { error: "unknown" | "expired" | "used" };

/** Exchange a code for a durable per-device token. Single-use and expiry are enforced here rather
 * than by the caller, so no transport can forget to check them. */
export function redeemPairingCode(db: Database, code: string, name: string, transport: string, now = Date.now()): RedeemResult {
  const row = db.query("SELECT code, expires_at, used_at FROM pairing_codes WHERE code = ?").get(code.trim()) as
    | { code: string; expires_at: number; used_at: number | null }
    | null;
  if (!row) return { error: "unknown" };
  if (row.used_at !== null) return { error: "used" };
  if (row.expires_at < now) return { error: "expired" };
  const paired = createDevice(db, name, transport, now);
  db.run("UPDATE pairing_codes SET used_at = ?, used_by = ? WHERE code = ?", [now, paired.device.id, code.trim()]);
  return paired;
}

/** Registers a device and returns its one-time token. Used by redemption, and directly by tests. */
export function createDevice(db: Database, name: string, transport: string, now = Date.now()): PairedDevice {
  const id = randomBytes(6).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const clean = (name || "device").slice(0, 60);
  db.run("INSERT INTO devices (id, name, transport, token_hash, created_at, last_seen_at, revoked_at) VALUES (?,?,?,?,?,NULL,NULL)", [
    id,
    clean,
    transport,
    hash(token),
    now,
  ]);
  return { device: { id, name: clean, transport, createdAt: now, lastSeenAt: null, revokedAt: null }, token };
}

/** The device this token belongs to, or null if it is unknown or revoked. Touches last_seen_at, which
 * is what makes `mirod devices` useful for spotting something you do not recognise. */
export function authenticateDevice(db: Database, token: string, now = Date.now()): Device | null {
  if (!token) return null;
  const row = db.query("SELECT * FROM devices WHERE token_hash = ?").get(hash(token)) as DeviceRow | null;
  if (!row || row.revoked_at !== null) return null;
  db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [now, row.id]);
  return fromRow({ ...row, last_seen_at: now });
}

export function listDevices(db: Database): Device[] {
  return (db.query("SELECT * FROM devices ORDER BY created_at DESC").all() as DeviceRow[]).map(fromRow);
}

/** Revoking is a tombstone, not a delete: the row stays so the owner can see that a device existed
 * and when it was cut off. Returns false if there was nothing to revoke. */
export function revokeDevice(db: Database, id: string, now = Date.now()): boolean {
  const row = db.query("SELECT id, revoked_at FROM devices WHERE id = ?").get(id) as { id: string; revoked_at: number | null } | null;
  if (!row || row.revoked_at !== null) return false;
  db.run("UPDATE devices SET revoked_at = ? WHERE id = ?", [now, id]);
  return true;
}
