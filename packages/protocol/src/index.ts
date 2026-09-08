import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// Two layouts (PLAN.md §5.5, privilege model): an unprivileged dev run keeps everything under
// ~/.miro; the real system service runs mirod as root with state in /var/lib/miro and its socket
// in /run/miro, group-accessible so the owner's TUI (not root) can connect. MIRO_DIR / MIRO_SOCKET
// override either. `resolveSocketPath()` is what a client uses: it finds the system socket if a
// root daemon is running, else falls back to the per-user one.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

export const MIRO_DIR = process.env.MIRO_DIR ?? (isRoot ? "/var/lib/miro" : join(homedir(), ".miro"));
export const SYSTEM_SOCKET_PATH = "/run/miro/mirod.sock";
export const SOCKET_PATH = process.env.MIRO_SOCKET ?? (isRoot ? SYSTEM_SOCKET_PATH : join(MIRO_DIR, "mirod.sock"));
export const DB_PATH = join(MIRO_DIR, "miro.db");

/** Client-side socket discovery: the system socket if a root daemon is running, else the same
 * per-user path the daemon computes (so MIRO_DIR moves both ends - audit #4: the client used to
 * hardcode ~/.miro and miss a daemon started with MIRO_DIR set). */
export function resolveSocketPath(): string {
  if (process.env.MIRO_SOCKET) return process.env.MIRO_SOCKET;
  if (existsSync(SYSTEM_SOCKET_PATH)) return SYSTEM_SOCKET_PATH;
  return join(MIRO_DIR, "mirod.sock");
}

// The wire protocol lives in ./wire so a browser can bundle it without this file's node: imports.
// Re-exported here because every existing import site says `@miro/protocol` and there is no reason
// for a daemon-side caller to care about the split.
export * from "./wire";
