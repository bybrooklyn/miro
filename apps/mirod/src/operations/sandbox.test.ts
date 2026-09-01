import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed, bwrapArgs, sandboxAvailable } from "./sandbox";

// Real bubblewrap, real subprocesses, real filesystem — no mocks. These tests are the live proof
// of the containment property and only mean something where bwrap exists (the dev VM, any Debian
// server); on the dev Mac they skip. bwrapArgs() is pure and tested everywhere.

const available = await sandboxAvailable();

describe("bwrapArgs (pure)", () => {
  test("read-only root, writable binds, scratch /tmp, network off by default", () => {
    const args = bwrapArgs({ writableRoots: ["/srv/media", "/var/run/docker.sock"], network: false });
    expect(args.slice(0, 3)).toEqual(["bwrap", "--ro-bind", "/"]);
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--tmpfs");
    expect(args.join(" ")).toContain("--bind /srv/media /srv/media");
    expect(args.join(" ")).toContain("--bind /var/run/docker.sock /var/run/docker.sock");
    expect(args[args.length - 1]).toBe("--");
  });
  test("network on omits --unshare-net", () => {
    expect(bwrapArgs({ writableRoots: [], network: true })).not.toContain("--unshare-net");
  });
  test("declaring / writable is refused", () => {
    expect(() => bwrapArgs({ writableRoots: ["/"], network: false })).toThrow();
  });
  test("trailing slashes and duplicates are normalised", () => {
    const args = bwrapArgs({ writableRoots: ["/srv/x/", "/srv/x"], network: false });
    expect(args.filter((a) => a === "/srv/x").length).toBe(2); // one --bind pair
  });
});

describe.skipIf(!available)("runSandboxed (real bubblewrap)", () => {
  let scope: string;
  let outside: string;

  beforeAll(() => {
    scope = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-scope-")));
    // NOT under /tmp: the sandbox mounts a fresh tmpfs there, so an undeclared /tmp path fails
    // with "Directory nonexistent" rather than the read-only refusal this test is about.
    outside = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "sandbox-outside-")));
  });
  afterAll(() => {
    rmSync(scope, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("a write inside a declared root succeeds", async () => {
    const r = await runSandboxed(["sh", "-c", `echo hi > ${scope}/ok && cat ${scope}/ok`], { writableRoots: [scope], network: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
    expect(existsSync(join(scope, "ok"))).toBe(true);
  });

  test("a write outside the declared roots fails and leaves no file behind", async () => {
    const r = await runSandboxed(["sh", "-c", `echo hi > ${outside}/nope`], { writableRoots: [scope], network: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Read-only file system/);
    expect(existsSync(join(outside, "nope"))).toBe(false); // checked from outside the sandbox
  });

  test("/etc is never writable", async () => {
    const r = await runSandboxed(["touch", "/etc/sandbox-probe"], { writableRoots: [scope], network: false });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync("/etc/sandbox-probe")).toBe(false);
  });

  test("network off: even loopback is unreachable", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("up") });
    try {
      const r = await runSandboxed(["curl", "-s", "-m", "3", `http://127.0.0.1:${server.port}/`], { writableRoots: [], network: false });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("up");
    } finally {
      server.stop(true);
    }
  });

  test("network on: loopback works", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("up") });
    try {
      const r = await runSandboxed(["curl", "-s", "-m", "3", `http://127.0.0.1:${server.port}/`], { writableRoots: [], network: true });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("up");
    } finally {
      server.stop(true);
    }
  });

  test("timeout kills the command", async () => {
    const r = await runSandboxed(["sleep", "30"], { writableRoots: [], network: false, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  test("output is capped with a marker", async () => {
    const r = await runSandboxed(["sh", "-c", "yes | head -c 20000"], { writableRoots: [], network: false, maxOutputBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain("[output truncated at 1024 bytes]");
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(1200);
  });

  test("the daemon's environment is not inherited", async () => {
    process.env.MIRO_TEST_SECRET = "leak-me";
    try {
      const r = await runSandboxed(["sh", "-c", "echo \"${MIRO_TEST_SECRET:-absent}\""], { writableRoots: [], network: false });
      expect(r.stdout.trim()).toBe("absent");
    } finally {
      delete process.env.MIRO_TEST_SECRET;
    }
  });

  test("a declared root that does not exist yet is created", async () => {
    const fresh = join(scope, "new", "deeper");
    const r = await runSandboxed(["sh", "-c", `echo x > ${fresh}/f`], { writableRoots: [fresh], network: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(fresh, "f"))).toBe(true);
  });
});
