import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { computeSetupStatus, setupGapLines } from "./status";

function db(settings: Record<string, string> = {}, secrets: string[] = []): Database {
  const d = new Database(":memory:");
  d.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  d.run("CREATE TABLE secrets (ref TEXT PRIMARY KEY, ciphertext TEXT)");
  for (const [k, v] of Object.entries(settings)) d.run("INSERT INTO settings VALUES (?,?)", [k, v]);
  for (const r of secrets) d.run("INSERT INTO secrets VALUES (?,?)", [r, "x"]);
  return d;
}

test("a fresh box: everything is a gap except update checks, which need no credential", () => {
  const s = computeSetupStatus(db());
  // Releases are public, so the daily update check works out of the box - it is never a gap.
  expect(s.configured).toEqual(["automatic update checks"]);
  expect(s.gaps.map((g) => g.key).sort()).toEqual(["backup", "notifications", "ups", "web"]);
  expect(setupGapLines(db()).join(" ")).toContain("offer once");
});

test("a fully-set-up box: no gaps, all configured, silent nudge", () => {
  const d = db(
    { "backup.enabled": "true", "backup.repo": "me/box", "notify.ntfy.url": "http://x", "power.ups": "ups@localhost", "web.enabled": "true" },
    ["provider.github"],
  );
  const s = computeSetupStatus(d);
  expect(s.gaps).toEqual([]);
  expect(s.configured.length).toBe(5);
  expect(setupGapLines(d)).toEqual([]);
});

test("partial: backup on, notifications set; ups still a gap", () => {
  const s = computeSetupStatus(db({ "backup.enabled": "true", "notify.gotify.url": "http://g" }));
  expect(s.gaps.map((g) => g.key).sort()).toEqual(["ups", "web"]);
  expect(s.configured.length).toBe(3);
});

test("a stored GitHub token upgrades the update-check line rather than closing a gap", () => {
  const s = computeSetupStatus(db({}, ["provider.github"]));
  expect(s.configured).toEqual(["automatic update checks (authenticated)"]);
  expect(s.gaps.map((g) => g.key)).not.toContain("updates");
});

test("computeSetupStatus never throws on a db missing the tables", () => {
  const bare = new Database(":memory:");
  expect(() => computeSetupStatus(bare)).not.toThrow();
  expect(computeSetupStatus(bare).gaps.length).toBe(4);
});
