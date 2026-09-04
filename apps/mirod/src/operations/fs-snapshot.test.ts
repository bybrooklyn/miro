import { test, expect } from "bun:test";
import { classifyFilesystem, detectFilesystem, isSnapshottable } from "./fs-snapshot";

test("classifyFilesystem: recognizes btrfs and zfs, nothing else", () => {
  expect(classifyFilesystem("btrfs")).toBe("btrfs");
  expect(classifyFilesystem("zfs")).toBe("zfs");
  expect(classifyFilesystem("ext4")).toBeNull();
  expect(classifyFilesystem("xfs")).toBeNull();
  expect(classifyFilesystem("overlay")).toBeNull();
  expect(classifyFilesystem(null)).toBeNull();
});

test("classifyFilesystem: does not fuzzy-match a device path or a related name", () => {
  // The exact bug this exists to avoid: df's device-path column ("/dev/sda1", "rpool/ROOT") must
  // never be mistaken for the fstype string "zfs"/"btrfs" itself.
  expect(classifyFilesystem("/dev/sda1")).toBeNull();
  expect(classifyFilesystem("rpool/ROOT")).toBeNull();
  expect(classifyFilesystem("zfs-fuse")).toBeNull(); // a real but distinct fstype name
});

test("detectFilesystem: degrades to null on a machine with no findmnt (this dev Mac), never throws", async () => {
  // Real command, no mock - this dev Mac genuinely lacks findmnt (util-linux, Linux-only), so this
  // exercises the actual graceful-degrade path the same way inventory tools without their
  // command (systemctl, docker) on this machine already do.
  await expect(detectFilesystem("/")).resolves.toBeNull();
});

test("isSnapshottable: composes detectFilesystem + classifyFilesystem, also degrades to null here", async () => {
  await expect(isSnapshottable("/")).resolves.toBeNull();
});

test("detectFilesystem: a nonexistent path never throws", async () => {
  await expect(detectFilesystem("/definitely/does/not/exist/anywhere")).resolves.toBeNull();
});
