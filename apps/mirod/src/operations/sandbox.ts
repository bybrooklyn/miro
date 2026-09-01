import { mkdirSync, existsSync } from "node:fs";

// The kernel sandbox (PLAN.md §5.7, "contain, don't classify"). Every non-`read` command an agent
// issues runs through runSandboxed(): bubblewrap gives the process a read-only view of the whole
// filesystem, with exactly the plan-declared paths bind-mounted writable and the network shared
// only if the plan said so. A write outside the declared scope fails with EROFS/EACCES — the
// operation's verify then fails and the engine rolls back. Proven live on the dev VM before this
// file existed: in-scope write OK, /etc and $HOME writes refused, network blocked, and as root the
// exact same constraints hold (Landlock as a second lock is the named upgrade path — ponytail: one
// layer now, two when a tiny Landlock helper exists; bubblewrap is a CLI usable today).
//
// Limits, stated: the sandbox cannot see past a socket. `docker run -v /:/host`, `systemctl`,
// D-Bus and `apt`-via-`dpkg` do their work in another process, which is why the classifier's
// per-binary argument rules exist even with this underneath. A socket a command genuinely needs
// (the docker socket, /run/systemd) is declared like any other writable root.

export interface SandboxOptions {
  /** Paths the command may write. Files, directories, or sockets — bind-mounted read-write.
   * A directory that does not exist yet is created (declaring it writable is declaring it). */
  writableRoots: string[];
  /** Paths that must be visible but read-only — e.g. an operation's declared roots during its
   * verify step. Matters under /tmp, which the sandbox otherwise replaces with a fresh tmpfs. */
  visibleRoots?: string[];
  /** Share the host network namespace. Off = a fresh, empty namespace: no internet, no loopback. */
  network: boolean;
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment. The daemon's own env is never inherited (it carries provider keys). */
  env?: Record<string, string>;
  stdin?: string;
  /** Output is truncated past this many bytes (per stream) with a marker. */
  maxOutputBytes?: number;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** The bubblewrap argv for a given policy — exported so tests and the plan display can show the
 * exact containment a command will run under. */
export function bwrapArgs(opts: SandboxOptions): string[] {
  const args = [
    "bwrap",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
  ];
  const roots = [...new Set(opts.writableRoots.map((p) => p.replace(/\/+$/, "") || "/"))];
  if (roots.includes("/")) throw new Error("a sandbox cannot declare / writable");
  // Scratch space: a fresh tmpfs on /tmp unless the plan declared /tmp itself writable. Declared
  // and visible roots are mounted after it, so anything under /tmp they name shows through.
  // Consequence, deliberate: an undeclared write under /tmp succeeds into memory that vanishes
  // with the sandbox — scratch files work, and the host's /tmp is never touched. Everywhere else
  // an undeclared write fails with EROFS. Proven live on the dev VM (kinds.test.ts).
  if (!roots.includes("/tmp")) args.push("--tmpfs", "/tmp");
  for (const root of [...new Set((opts.visibleRoots ?? []).map((p) => p.replace(/\/+$/, "") || "/"))]) {
    if (root === "/") continue;
    args.push("--ro-bind", root, root);
  }
  for (const root of roots) args.push("--bind", root, root);
  if (!opts.network) args.push("--unshare-net");
  if (opts.cwd) args.push("--chdir", opts.cwd);
  args.push("--");
  return args;
}

export async function sandboxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bwrap", "--version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  return { text: Buffer.from(text).subarray(0, max).toString() + `\n[output truncated at ${max} bytes]`, truncated: true };
}

/** Run `argv` (never a shell string — the classifier already produced argv) under the sandbox. */
export async function runSandboxed(argv: string[], opts: SandboxOptions): Promise<SandboxResult> {
  if (argv.length === 0) throw new Error("empty argv");
  for (const root of opts.writableRoots) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const proc = Bun.spawn([...bwrapArgs(opts), ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    // Scrubbed: never the daemon's real env (provider API keys live there) — same rule as the
    // extension host. PATH must cover /usr/sbin for the root-only tools operations exist for.
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: process.env.HOME ?? "/root",
      LANG: "C.UTF-8",
      TERM: "dumb",
      DEBIAN_FRONTEND: "noninteractive",
      ...opts.env,
    },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdoutRaw, stderrRaw] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);

  const out = truncate(stdoutRaw, max);
  const err = truncate(stderrRaw, max);
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: out.text,
    stderr: err.text,
    timedOut,
    truncated: out.truncated || err.truncated,
  };
}
