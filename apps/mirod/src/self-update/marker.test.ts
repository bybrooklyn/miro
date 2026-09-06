import { test, expect } from "bun:test";
import { blessDecision, crashLoopNext, versionsToGC, readMarker, writeMarker, clearMarker, type UpdateMarker } from "./marker";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base: UpdateMarker = {
  schema: 1,
  phase: "swapped",
  fromVersion: "0.0.1",
  toVersion: "0.0.2",
  prevDir: "/opt/miro/versions/0.0.1",
  stagedDir: "/opt/miro/versions/0.0.2",
  muPre: 1,
  attempts: 1,
  issuedAt: 0,
  updatedAt: 0,
};

test("blessDecision: running the new version and no worse -> bless", () => {
  expect(blessDecision("0.0.2", base, 1)).toBe("bless");
  expect(blessDecision("0.0.2", base, 0)).toBe("bless");
});

test("blessDecision: running the new version but worse -> revert", () => {
  expect(blessDecision("0.0.2", base, 2)).toBe("revert");
});

test("blessDecision: the swap did not take (still the old version) -> swap_failed, never a false bless", () => {
  expect(blessDecision("0.0.1", base, 0)).toBe("swap_failed");
  expect(blessDecision(null, base, 0)).toBe("swap_failed");
});

test("blessDecision: an unreadable muPre blesses on liveness alone (the daemon booted far enough to judge)", () => {
  expect(blessDecision("0.0.2", { ...base, muPre: -1 }, 999)).toBe("bless");
});

test("crashLoopNext: increments below MAX, reverts past it", () => {
  expect(crashLoopNext(1, 2)).toEqual({ revert: false, attempts: 2 });
  expect(crashLoopNext(2, 2)).toEqual({ revert: true, attempts: 3 });
});

test("versionsToGC: keeps the newest 3 by numeric version, never a protected dir", () => {
  const dirs = ["/v/0.0.1", "/v/0.0.2", "/v/0.0.10", "/v/0.0.3", "/v/0.0.9"].map((d) => d);
  // protect current (0.0.10) + prev (0.0.9); keep budget = 3 - 2 = 1 more of the rest -> keep the newest remaining (0.0.3), GC 0.0.1 and 0.0.2.
  const gc = versionsToGC(dirs, 3, ["/v/0.0.10", "/v/0.0.9"]);
  expect(gc.sort()).toEqual(["/v/0.0.1", "/v/0.0.2"]);
  expect(gc).not.toContain("/v/0.0.10");
  expect(gc).not.toContain("/v/0.0.9");
});

test("versionsToGC: nothing to remove when within the keep budget", () => {
  expect(versionsToGC(["/v/0.0.1", "/v/0.0.2"], 3, ["/v/0.0.2"])).toEqual([]);
});

test("readMarker/writeMarker/clearMarker round-trip; a corrupt or missing file reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "upd-"));
  const path = join(dir, "update.json");
  expect(readMarker(path)).toBeNull(); // missing
  writeMarker(path, base);
  expect(readMarker(path)?.toVersion).toBe("0.0.2");
  writeMarker(path, { ...base, phase: "reverting" });
  expect(readMarker(path)?.phase).toBe("reverting");
  clearMarker(path);
  expect(existsSync(path)).toBe(false);
  expect(readMarker(path)).toBeNull();
});
