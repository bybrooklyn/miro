import { commandExists, run } from "../inventory/exec";

// Filesystem-snapshot detection (PLAN.md §5.15 A: "prefer btrfs/ZFS/LVM snapshots for declared
// roots" - the named upgrade path over snapshot.ts's tar-with-a-cap). This file is deliberately
// DETECTION ONLY. The actual `btrfs subvolume snapshot` / `zfs snapshot` create+restore commands
// are safety-critical rollback machinery, and this dev machine has neither filesystem to live-
// verify them against (the project's own house style: don't trust untested code for exactly this
// class of thing - see AGENTS.md "Live verification"). Scoped to btrfs/zfs; LVM is deliberately
// excluded - it snapshots at the block-device/volume-group level, not per-path, so "snapshot this
// directory" doesn't map onto it the way it does a btrfs subvolume or a zfs dataset.

export type SnapshottableFilesystem = "btrfs" | "zfs";

/** Pure: classify an fstype string (as reported by `findmnt -no FSTYPE` / `/proc/mounts`) into a
 * filesystem this module knows how to eventually snapshot, or null. */
export function classifyFilesystem(fsType: string | null): SnapshottableFilesystem | null {
  if (fsType === "btrfs") return "btrfs";
  if (fsType === "zfs") return "zfs";
  return null;
}

/** The real filesystem type backing a path, via `findmnt` (util-linux, present on every Debian) -
 * NOT `df`'s "Filesystem" column, which is the DEVICE path (`/dev/sda1`) for a real disk, not the
 * fs type name; misreading that column would silently misdetect every non-pseudo filesystem (found
 * while building this, not assumed - see inventory/storage.ts's getMounts, whose `filesystem`
 * field exists for the noisy-pseudo-fs denylist, not this purpose). Degrades to null - no findmnt
 * (this dev Mac, or a non-util-linux system), the path doesn't exist, anything - matching the
 * graceful-unavailable convention every inventory tool already follows. */
export async function detectFilesystem(path: string): Promise<string | null> {
  if (!(await commandExists("findmnt"))) return null;
  try {
    const out = await run("findmnt", ["-no", "FSTYPE", "--target", path]);
    const fsType = out.trim();
    return fsType || null;
  } catch {
    return null;
  }
}

/** Whether `path` sits on a filesystem this module could eventually snapshot natively. */
export async function isSnapshottable(path: string): Promise<SnapshottableFilesystem | null> {
  return classifyFilesystem(await detectFilesystem(path));
}
