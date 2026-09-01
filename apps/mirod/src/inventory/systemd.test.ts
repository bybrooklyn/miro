import { test, expect } from "bun:test";
import { parseSystemctlList, listServices, parseJournalctl, serviceLogs } from "./systemd";

test("parseSystemctlList parses `systemctl list-units --no-legend --plain` output", () => {
  const output = [
    "docker.service                    loaded active running Docker Application Container Engine",
    "jellyfin.service                  loaded active running Jellyfin Media Server",
    "sshd.service                      loaded active running OpenSSH server daemon",
  ].join("\n");
  const services = parseSystemctlList(output);
  expect(services).toHaveLength(3);
  expect(services[1]).toEqual({
    unit: "jellyfin.service",
    load: "loaded",
    active: "active",
    sub: "running",
    description: "Jellyfin Media Server",
  });
});

test(
  "listServices reports unavailable on a machine with no systemctl (real check on this dev box)",
  async () => {
    const result = await listServices();
    expect(result).toEqual({ available: false, services: [] });
  },
  // See network.test.ts's getTailscaleStatus test for why this retries.
  { timeout: 10000, retry: 2 },
);

test("parseJournalctl splits `journalctl -o short-iso` lines into timestamp + rest", () => {
  const output = [
    "2026-08-30T12:00:00+0000 homeserver jellyfin[1234]: Starting Jellyfin Server",
    "2026-08-30T12:00:01+0000 homeserver jellyfin[1234]: Ready",
  ].join("\n");
  expect(parseJournalctl(output)).toEqual([
    { timestamp: "2026-08-30T12:00:00+0000", line: "homeserver jellyfin[1234]: Starting Jellyfin Server" },
    { timestamp: "2026-08-30T12:00:01+0000", line: "homeserver jellyfin[1234]: Ready" },
  ]);
});

test(
  "serviceLogs reports unavailable on a machine with no journalctl (real check on this dev box)",
  async () => {
    expect(await serviceLogs("jellyfin")).toEqual({ available: false, logs: [] });
  },
  { timeout: 10000, retry: 2 },
);
