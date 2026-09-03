import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed, bwrapArgs, sandboxAvailable } from "./sandbox";

// Real bubblewrap, real subprocesses, real filesystem - no mocks. These tests are the live proof
// of the containment property and only mean something where bwrap exists (the dev VM, any Debian
// server); on the dev Mac they skip. bwrapArgs() is pure and tested everywhere.

const available = await sandboxAvailable();

describe("bwrapArgs (pure)", () => {
  test("read-only root, writable binds, scratch /tmp, every namespace unshared, caps dropped", () => {
    // The unprivileged shape - pinned with root=false so the assertion holds when the suite itself
    // runs as root on the VM.
    const args = bwrapArgs({ writableRoots: ["/srv/media", "/var/run/docker.sock"], network: false }, false);
    expect(args.slice(0, 3)).toEqual(["bwrap", "--ro-bind", "/"]);
    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args).toContain("--tmpfs");
    expect(args.join(" ")).toContain("--bind /srv/media /srv/media");
    expect(args.join(" ")).toContain("--bind /var/run/docker.sock /var/run/docker.sock");
    expect(args[args.length - 1]).toBe("--");
  });
  test("network on re-shares the host namespace; keepCapabilities keeps them", () => {
    const args = bwrapArgs({ writableRoots: [], network: true, keepCapabilities: true }, false);
    expect(args).toContain("--share-net");
    expect(args.join(" ")).not.toContain("--cap-drop");
    expect(args.join(" ")).not.toContain("--cap-add");
  });
  test("as root: no user namespace, net unshared unless declared, reads keep only CAP_DAC_READ_SEARCH", () => {
    const read = bwrapArgs({ writableRoots: [], network: false }, true);
    expect(read).not.toContain("--unshare-all");
    expect(read).not.toContain("--share-net");
    for (const ns of ["--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try", "--unshare-net"]) expect(read).toContain(ns);
    expect(read.join(" ")).toContain("--cap-drop ALL --cap-add CAP_DAC_READ_SEARCH");
    const net = bwrapArgs({ writableRoots: [], network: true }, true);
    expect(net).not.toContain("--unshare-net");
    const apply = bwrapArgs({ writableRoots: ["/srv"], network: true, keepCapabilities: true }, true);
    expect(apply.join(" ")).toContain("--cap-add ALL");
    expect(apply.join(" ")).not.toContain("--cap-drop");
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

  test("a root payload cannot remount the root read-write and escape (adversarial review)", async () => {
    // As real root, keepCapabilities is the named ceiling (see bwrapArgs): a payload holding
    // CAP_SYS_ADMIN outside a user namespace can remount. Every capability-dropped command holds.
    const root = process.getuid?.() === 0;
    for (const keepCapabilities of root ? [false] : [false, true]) {
      const r = await runSandboxed(["sh", "-c", "mount -o remount,rw / && touch /etc/sandbox-escape"], { writableRoots: [], network: false, keepCapabilities });
      expect(r.exitCode).not.toBe(0);
      expect(existsSync("/etc/sandbox-escape")).toBe(false);
    }
  });

  test("/proc/self/root does not lead out of the read-only view", async () => {
    const r = await runSandboxed(["sh", "-c", "echo x > /proc/self/root/etc/sandbox-escape2"], { writableRoots: [], network: false });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync("/etc/sandbox-escape2")).toBe(false);
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
