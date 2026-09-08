import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureDevicesTable,
  mintPairingCode,
  redeemPairingCode,
  authenticateDevice,
  createDevice,
  listDevices,
  revokeDevice,
  CODE_TTL_MS,
} from "./store";

// Real sqlite, real crypto. Every property here is one the old design lacked: possession of the ticket
// used to be permanent, unrevocable, whole-daemon access.
function db(): Database {
  const d = new Database(":memory:");
  ensureDevicesTable(d);
  return d;
}

test("a minted code redeems once, for a token that authenticates", () => {
  const d = db();
  const code = mintPairingCode(d);
  expect(code).toMatch(/^\d{9}$/);
  const res = redeemPairingCode(d, code, "laptop", "iroh");
  expect("error" in res).toBe(false);
  if ("error" in res) return;
  expect(res.token.length).toBeGreaterThan(32);
  const dev = authenticateDevice(d, res.token);
  expect(dev?.id).toBe(res.device.id);
  expect(dev?.name).toBe("laptop");
});

test("a code is single-use", () => {
  const d = db();
  const code = mintPairingCode(d);
  expect("error" in redeemPairingCode(d, code, "first", "iroh")).toBe(false);
  expect(redeemPairingCode(d, code, "second", "iroh")).toEqual({ error: "used" });
  // And the second attempt created nothing.
  expect(listDevices(d).length).toBe(1);
});

test("a code expires", () => {
  const d = db();
  const now = Date.now();
  const code = mintPairingCode(d, CODE_TTL_MS, now);
  expect(redeemPairingCode(d, code, "late", "iroh", now + CODE_TTL_MS + 1)).toEqual({ error: "expired" });
  // Still valid a second before the deadline - the boundary is not off by a window.
  expect("error" in redeemPairingCode(d, code, "just in time", "iroh", now + CODE_TTL_MS - 1)).toBe(false);
});

test("an unknown code is refused and nothing is created", () => {
  const d = db();
  expect(redeemPairingCode(d, "000000000", "nobody", "iroh")).toEqual({ error: "unknown" });
  expect(listDevices(d)).toEqual([]);
});

test("the token itself is never stored - only its hash", () => {
  const d = db();
  const { token } = createDevice(d, "laptop", "iroh");
  const dump = JSON.stringify(d.query("SELECT * FROM devices").all());
  expect(dump).not.toContain(token);
  // The stored hash is what makes it verifiable without being replayable from a stolen DB.
  expect(dump).toContain(new Bun.CryptoHasher("sha256").update(token).digest("hex"));
});

test("revoking refuses the token but keeps the record", () => {
  const d = db();
  const { device, token } = createDevice(d, "old-phone", "iroh");
  expect(authenticateDevice(d, token)).not.toBeNull();
  expect(revokeDevice(d, device.id)).toBe(true);
  expect(authenticateDevice(d, token)).toBeNull();
  // A tombstone, not a delete: the owner can still see the device existed and when it was cut off.
  const listed = listDevices(d);
  expect(listed.length).toBe(1);
  expect(listed[0]!.revokedAt).not.toBeNull();
  // Revoking twice is not a second event.
  expect(revokeDevice(d, device.id)).toBe(false);
  expect(revokeDevice(d, "nosuchid")).toBe(false);
});

test("one device's revocation does not touch another's", () => {
  const d = db();
  const a = createDevice(d, "phone", "iroh");
  const b = createDevice(d, "laptop", "iroh");
  revokeDevice(d, a.device.id);
  expect(authenticateDevice(d, a.token)).toBeNull();
  expect(authenticateDevice(d, b.token)?.name).toBe("laptop");
});

test("authenticate rejects garbage without throwing, and records last-seen for real tokens", () => {
  const d = db();
  expect(authenticateDevice(d, "")).toBeNull();
  expect(authenticateDevice(d, "not-a-token")).toBeNull();
  const { token } = createDevice(d, "laptop", "iroh");
  expect(listDevices(d)[0]!.lastSeenAt).toBeNull();
  authenticateDevice(d, token, 1_700_000_000_000);
  expect(listDevices(d)[0]!.lastSeenAt).toBe(1_700_000_000_000);
});

test("codes are distinct across mints", () => {
  const d = db();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(mintPairingCode(d));
  expect(seen.size).toBe(50);
});
