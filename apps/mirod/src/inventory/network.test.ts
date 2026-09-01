import { test, expect } from "bun:test";
import { getNetworkInterfaces, parseTailscaleStatus, getTailscaleStatus } from "./network";

test("getNetworkInterfaces returns real interfaces for this machine", () => {
  const interfaces = getNetworkInterfaces();
  expect(interfaces.length).toBeGreaterThan(0);
  expect(interfaces.some((i) => i.address.length > 0)).toBe(true);
});

test("parseTailscaleStatus extracts connection state, IP, and hostname from `tailscale status --json`", () => {
  const fixture = JSON.stringify({
    BackendState: "Running",
    Self: { HostName: "homeserver", TailscaleIPs: ["100.64.0.1"] },
  });
  expect(parseTailscaleStatus(fixture)).toEqual({
    connected: true,
    ip: "100.64.0.1",
    hostname: "homeserver",
  });
});

test("parseTailscaleStatus reports disconnected when backend isn't running", () => {
  const fixture = JSON.stringify({ BackendState: "Stopped", Self: null });
  expect(parseTailscaleStatus(fixture)).toEqual({ connected: false, ip: null, hostname: null });
});

test(
  "getTailscaleStatus reports unavailable on a machine without the CLI (real check on this dev box)",
  async () => {
    expect(await getTailscaleStatus()).toEqual({ available: false, connected: false, ip: null, hostname: null });
  },
  // Spawns a real child process (`which tailscale`) — under bun test's own multi-file concurrency,
  // real subprocess spawns occasionally stall well past their normal ~20ms (investigated: isolated
  // and direct calls are always fast; only many test files spawning child processes at once via
  // `bun test` shows this). retry rather than a longer timeout, since a longer timeout alone
  // didn't fully fix it.
  { timeout: 10000, retry: 2 },
);
