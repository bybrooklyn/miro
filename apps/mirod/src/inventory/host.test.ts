import { test, expect } from "bun:test";
import { parseOsRelease, getHostInfo } from "./host";

test("parseOsRelease extracts PRETTY_NAME from /etc/os-release content", () => {
  const debian = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\n`;
  expect(parseOsRelease(debian)).toBe("Debian GNU/Linux 13 (trixie)");
});

test("parseOsRelease returns null when PRETTY_NAME is absent", () => {
  expect(parseOsRelease("NAME=Fedora\n")).toBeNull();
});

test("getHostInfo returns real values for this machine (no /etc/os-release here, falls back cleanly)", () => {
  const info = getHostInfo();
  expect(info.hostname.length).toBeGreaterThan(0);
  expect(info.cpuCount).toBeGreaterThan(0);
  expect(info.totalMemoryBytes).toBeGreaterThan(0);
});
