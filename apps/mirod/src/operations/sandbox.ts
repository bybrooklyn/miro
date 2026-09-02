import { mkdirSync, existsSync } from "node:fs";

// The kernel sandbox (PLAN.md §5.7, "contain, don't classify"). Every non-`read` command an agent
// issues runs through runSandboxed(): bubblewrap gives the process a read-only view of the whole
// filesystem, with exactly the plan-declared paths bind-mounted writable and the network shared
// only if the plan said so. A write outside the declared scope fails with EROFS/EACCES — the
// operation's verify then fails and the engine rolls back. Proven live on the dev VM before this
// file existed: in-scope write OK, /etc and $HOME writes refused, network blocked. As root the
// same constraints hold for every capability-dropped command; see bwrapArgs for the one root
// difference (no user namespace) and what it costs (Landlock as a second lock is the named
// upgrade path — ponytail: one layer now, two when a tiny Landlock helper exists).
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
  /** Keep the caller's capabilities inside the sandbox. Off (the default, for reads) drops every
   * capability; a confirmed mutate operation that genuinely needs root's (apt, chown) turns it on. */
  keepCapabilities?: boolean;
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
export function bwrapArgs(opts: SandboxOptions, root = process.getuid?.() === 0): string[] {
  // Unprivileged: --unshare-all. The fresh user namespace is what lets bwrap mount at all, and it
  // locks the read-only root: even a root payload inside cannot `mount -o remount,rw /` its way
  // out (adversarial review). --share-net re-shares the host network namespace when declared.
  // As real root there is no user namespace: inside one every file owned by an unmapped uid is
  // "nobody", and not even root may traverse another user's 0700 home — `bwrap: Can't find source
  // path /home/miro: Permission denied` on a declared root rolled a real operation back (found
  // live). Without it the read-only root still holds against any payload lacking CAP_SYS_ADMIN:
  // every read, every command with capabilities dropped. keepCapabilities as root keeps the
  // declared-roots fence for an honest command (EROFS elsewhere), not against a hostile one —
  // which, holding real root and the docker socket, a mount namespace never contained anyway.
  // ponytail: Landlock is the second lock (PLAN.md §5.7); a capable root cannot lift that one.
  const namespaces = root
    ? ["--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try", ...(opts.network ? [] : ["--unshare-net"])]
    : ["--unshare-all", ...(opts.network ? ["--share-net"] : [])];
  // bwrap hands a privileged caller's payload no capabilities unless asked. Reads as root get
  // exactly one back — read anything: a manager must read app config in another user's home.
  // Secret material stays behind the classifier's path and tree-walk rules, and /proc is the
  // sandbox's own pid namespace, so no host process's environ is there to read.
  const caps = opts.keepCapabilities
    ? root ? ["--cap-add", "ALL"] : []
    : ["--cap-drop", "ALL", ...(root ? ["--cap-add", "CAP_DAC_READ_SEARCH"] : [])];
  const args = [
    "bwrap",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
    "--new-session",
    ...namespaces,
    ...caps,
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
