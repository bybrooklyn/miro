import { test, expect } from "bun:test";
import { parseAptList, parseDnfList, detectPackageManager, listInstalledPackages } from "./packages";

test("parseAptList parses `apt list --installed` output", () => {
  const output = [
    "Listing... Done",
    "adduser/stable,now 3.118 all [installed]",
    "jellyfin/stable,now 10.9.7 amd64 [installed]",
  ].join("\n");
  expect(parseAptList(output)).toEqual([
    { name: "adduser", version: "3.118" },
    { name: "jellyfin", version: "10.9.7" },
  ]);
});

test("parseDnfList parses `dnf list installed` output", () => {
  const output = [
    "Installed Packages",
    "bash.x86_64          5.1.8-2.fc35    @System",
    "jellyfin.x86_64       10.9.7-1.fc35   @System",
  ].join("\n");
  expect(parseDnfList(output)).toEqual([
    { name: "bash", version: "5.1.8-2.fc35" },
    { name: "jellyfin", version: "10.9.7-1.fc35" },
  ]);
});

test(
  "detectPackageManager finds neither apt nor dnf on this dev box (real check)",
  async () => {
    expect(await detectPackageManager()).toBeNull();
  },
  // See network.test.ts's getTailscaleStatus test for why this retries.
  { timeout: 10000, retry: 2 },
);

test(
  "listInstalledPackages reports unavailable when no known package manager exists (real check)",
  async () => {
    expect(await listInstalledPackages()).toEqual({ available: false, manager: null, packages: [] });
  },
  { timeout: 10000, retry: 2 },
);
