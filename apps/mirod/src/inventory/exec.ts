import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** No caller of run() may hang the daemon: `docker ps` against a wedged socket, `df` on a dead
 * NFS mount, `apt list` behind a stuck lock - each used to block the chat turn (takeSnapshot runs
 * before every turn) or, worse, an operation holding the daemon-wide write lock (computeSeverity
 * runs inside it), forever. A promisified execFile with `timeout: undefined` has no timeout at
 * all (audit B3/A12). Callers that legitimately run long (tar, docker run) pass their own. */
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS });
  return stdout;
}

/** A command that needs root: run as-is by the root daemon (production), through `sudo -n` (never
 * a password prompt) by an unprivileged dev daemon. Root must never route through sudo - the
 * hardened unit sets NoNewPrivileges=yes, under which sudo refuses even for root (PLAN.md §5.30). */
export function runPrivileged(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const argv = process.getuid?.() === 0 ? args : ["sudo", "-n", ...args];
  return run(argv[0], argv.slice(1), opts);
}
