import { run } from "./exec";

export interface MountInfo {
  filesystem: string;
  mountPoint: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

// ponytail: denylist of noisy pseudo-filesystems, not real semantic classification.
// Upgrade to the real filesystem index (plan §22) if this starts hiding real disks.
const IGNORED_FILESYSTEMS = new Set([
  "tmpfs",
  "devtmpfs",
  "overlay",
  "squashfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "devpts",
  "none",
]);

/** Parses `df -kP` output (POSIX-portable across Linux and macOS). */
export function parseDf(output: string): MountInfo[] {
  const lines = output.trim().split("\n").slice(1);
  return lines
    .filter((line) => line.trim())
    .map((line) => line.trim().split(/\s+/))
    // A short line (a device name wrapped by a non-POSIX df, a torn last line) has no capacity
    // column to read; it used to throw and take every other mount with it (audit B14).
    .filter((parts) => parts.length >= 6)
    .map((parts) => {
      const [filesystem, blocks1k, used, available, capacity, ...mountParts] = parts;
      return {
        filesystem,
        mountPoint: mountParts.join(" "),
        sizeBytes: Number(blocks1k) * 1024,
        usedBytes: Number(used) * 1024,
        availableBytes: Number(available) * 1024,
        usedPercent: Number(capacity.replace("%", "")),
      };
    })
    .filter((mount) => !IGNORED_FILESYSTEMS.has(mount.filesystem));
}

/** Empty when df fails or hangs (a dead network mount blocks it) - the same degrade every other
 * inventory reader has; the callers already treat [] as "no storage data". */
export async function getMounts(): Promise<MountInfo[]> {
  try {
    return parseDf(await run("df", ["-kP"]));
  } catch {
    return [];
  }
}
