import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { computeSetupStatus, setupGapLines } from "./status";

function db(settings: Record<string, string> = {}): Database {
  const d = new Database(":memory:");
  d.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  for (const [k, v] of Object.entries(settings)) d.run("INSERT INTO settings VALUES (?,?)", [k, v]);
  return d;
}

test("a fresh box: everything is a gap, nothing configured", () => {
  const s = computeSetupStatus(db());
  expect(s.configured).toEqual([]);
  expect(s.gaps.map((g) => g.key).sort()).toEqual(["backup", "notifications", "ups"]);
  // the nudge names the gaps and says to offer them as one plan, once
  const lines = setupGapLines(db()).join(" ");
  expect(lines).toContain("backup");
  expect(lines).toContain("offer once".length ? "offer once" : "");
});

test("a fully-set-up box: no gaps, all configured, silent nudge", () => {
  const d = db({ "backup.enabled": "true", "backup.repo": "me/box", "notify.ntfy.url": "http://x", "power.ups": "ups@localhost" });
  const s = computeSetupStatus(d);
  expect(s.gaps).toEqual([]);
  expect(s.configured.length).toBe(3);
  expect(setupGapLines(d)).toEqual([]); // nothing to nudge about
});

test("partial: backup on, notifications + ups still gaps", () => {
  const s = computeSetupStatus(db({ "backup.enabled": "true", "notify.gotify.url": "http://g" }));
  expect(s.gaps.map((g) => g.key)).toEqual(["ups"]);
  expect(s.configured.length).toBe(2);
});
