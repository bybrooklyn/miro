import { test, expect } from "bun:test";
import { join } from "node:path";

// install.sh's pure decisions, driven directly (MIRO_INSTALL_SOURCE_ONLY loads the functions without
// running anything). These are the parts that silently ship a broken box when wrong: the wrong Bun
// build dies with an illegal instruction or a missing loader, and a wrong already_installed verdict
// either clobbers a live install or refuses to install at all.
const SCRIPT = join(import.meta.dir, "../../../install.sh");

function call(expr: string): { out: string; code: number } {
  const p = Bun.spawnSync(["sh", "-c", `. "${SCRIPT}"; ${expr}`], {
    env: { ...process.env, MIRO_INSTALL_SOURCE_ONLY: "1" },
  });
  return { out: new TextDecoder().decode(p.stdout).trim(), code: p.exitCode ?? 0 };
}

test("install.sh is valid POSIX sh", () => {
  const p = Bun.spawnSync(["sh", "-n", SCRIPT]);
  expect(new TextDecoder().decode(p.stderr)).toBe("");
  expect(p.exitCode).toBe(0);
});

test("resolve_arch maps what Miro ships and refuses what it does not", () => {
  expect(call("resolve_arch x86_64").out).toBe("x64");
  expect(call("resolve_arch amd64").out).toBe("x64");
  expect(call("resolve_arch aarch64").out).toBe("aarch64");
  expect(call("resolve_arch arm64").out).toBe("aarch64");
  // A refusal, not a silent guess - an armv7 box would otherwise download an unusable Bun.
  expect(call("resolve_arch armv7l").code).not.toBe(0);
  expect(call("resolve_arch riscv64").code).not.toBe(0);
});

test("resolve_bun_asset picks the libc and CPU-baseline variant", () => {
  expect(call("resolve_bun_asset x64 glibc 0").out).toBe("bun-linux-x64.zip");
  expect(call("resolve_bun_asset x64 glibc 1").out).toBe("bun-linux-x64-baseline.zip");
  expect(call("resolve_bun_asset x64 musl 0").out).toBe("bun-linux-x64-musl.zip");
  expect(call("resolve_bun_asset x64 musl 1").out).toBe("bun-linux-x64-baseline-musl.zip");
  // aarch64 has no baseline split, so the flag must not leak into the name.
  expect(call("resolve_bun_asset aarch64 glibc 1").out).toBe("bun-linux-aarch64.zip");
  expect(call("resolve_bun_asset aarch64 musl 0").out).toBe("bun-linux-aarch64-musl.zip");
});

test("release_url builds the public release download path", () => {
  expect(call("release_url 0.0.2 miro-v0.0.2.tar.gz").out).toBe(
    "https://github.com/bybrooklyn/miro/releases/download/v0.0.2/miro-v0.0.2.tar.gz",
  );
  expect(call("release_url 1.2.3-beta.1 manifest.json.sigstore").out).toBe(
    "https://github.com/bybrooklyn/miro/releases/download/v1.2.3-beta.1/manifest.json.sigstore",
  );
  expect(call('REPO=someone/fork; release_url 9.9.9 manifest.json').out).toContain("someone/fork");
});

test("already_installed is a three-way decision, not a boolean", () => {
  // No symlink yet: a run that died before the swap must resume the fresh install.
  expect(call('already_installed "" 0.0.2').out).toBe("fresh");
  // Same version already current: nothing to do.
  expect(call('already_installed /opt/miro/versions/0.0.2 0.0.2').out).toBe("noop");
  // Different version current: hand the swap to the running daemon, never clobber it.
  expect(call('already_installed /opt/miro/versions/0.0.1 0.0.2').out).toBe("upgrade");
  // A prefix must not be mistaken for a match (0.0.2 vs 0.0.20).
  expect(call('already_installed /opt/miro/versions/0.0.20 0.0.2').out).toBe("upgrade");
});

test("bun_url pins the version the lockfile was resolved with", () => {
  expect(call("bun_url bun-linux-aarch64.zip").out).toBe(
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-aarch64.zip",
  );
});

test("--dry-run for a client install resolves paths and writes nothing", () => {
  const home = `${process.env.TMPDIR ?? "/tmp"}/miro-install-test-home-${Bun.randomUUIDv7()}`;
  const p = Bun.spawnSync(["sh", SCRIPT, "--client", "--dry-run", "--version", "0.0.2", "--non-interactive"], {
    env: { ...process.env, HOME: home },
  });
  const out = new TextDecoder().decode(p.stdout);
  expect(p.exitCode).toBe(0);
  expect(out).toContain("MODE=client");
  expect(out).toContain("VERSION=0.0.2");
  expect(out).toContain(`CLIENT_DIR=${home}/.miro`);
  expect(out).toContain("miro-v0.0.2.tar.gz");
  // The whole point of --dry-run: nothing on disk.
  expect(Bun.spawnSync(["test", "-e", home]).exitCode).not.toBe(0);
});
