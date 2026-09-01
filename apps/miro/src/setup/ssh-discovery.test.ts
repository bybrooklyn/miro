import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSshConfig, discoverSshHosts } from "./ssh-discovery";

test("parseSshConfig extracts Host blocks with HostName/User/Port", () => {
  const config = `
# comment
Host homeserver
  HostName 192.168.1.42
  User brooklyn
  Port 22

Host jump
  HostName jump.example.com
  User admin
`;
  expect(parseSshConfig(config)).toEqual([
    { alias: "homeserver", hostname: "192.168.1.42", user: "brooklyn", port: 22 },
    { alias: "jump", hostname: "jump.example.com", user: "admin", port: null },
  ]);
});

test("parseSshConfig skips wildcard-only Host patterns (global defaults blocks)", () => {
  const config = `
Host *
  ForwardAgent yes

Host realhost
  HostName 10.0.0.5
`;
  expect(parseSshConfig(config)).toEqual([{ alias: "realhost", hostname: "10.0.0.5", user: null, port: null }]);
});

test("discoverSshHosts returns [] when the config file doesn't exist (no real ~/.ssh touched)", () => {
  const missingPath = join(mkdtempSync(join(tmpdir(), "miro-ssh-test-")), "nonexistent-config");
  expect(discoverSshHosts(missingPath)).toEqual([]);
});

test("discoverSshHosts reads a real (scratch, not the user's) config file end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "miro-ssh-test-"));
  const configPath = join(dir, "config");
  writeFileSync(configPath, "Host testbox\n  HostName 10.1.1.1\n  User root\n");
  expect(discoverSshHosts(configPath)).toEqual([{ alias: "testbox", hostname: "10.1.1.1", user: "root", port: null }]);
  rmSync(dir, { recursive: true, force: true });
});
