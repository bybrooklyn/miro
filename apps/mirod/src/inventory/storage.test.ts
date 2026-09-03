import { test, expect } from "bun:test";
import { parseDf } from "./storage";

// Captured live from `df -kP` on the dev machine - proves the parser handles real output,
// not just a hand-built fixture.
const REAL_DF_OUTPUT = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   239362496  15884664   6805876    71%    /
devfs                  203       203         0   100%    /dev
/dev/disk3s5     239362496 187912216   6805876    97%    /System/Volumes/Data
`;

test("parseDf extracts size/used/available/percent from real df -kP output", () => {
  const mounts = parseDf(REAL_DF_OUTPUT);
  const root = mounts.find((m) => m.mountPoint === "/");
  expect(root).toBeDefined();
  expect(root!.sizeBytes).toBe(239362496 * 1024);
  expect(root!.usedBytes).toBe(15884664 * 1024);
  expect(root!.availableBytes).toBe(6805876 * 1024);
  expect(root!.usedPercent).toBe(71);
});

test("parseDf filters known-noisy pseudo-filesystems (Linux tmpfs/overlay/proc/...)", () => {
  const linuxStyle = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         104805116 45812340  53764212      47% /
tmpfs                8069200        0   8069200       0% /dev/shm
overlay              1234567   111111   1000000      10% /var/lib/docker/overlay2/abc
`;
  const mounts = parseDf(linuxStyle);
  expect(mounts.map((m) => m.mountPoint)).toEqual(["/"]);
});
