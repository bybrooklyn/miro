import { arch, cpus, hostname, release, totalmem, uptime } from "node:os";
import { readFileSync } from "node:fs";

export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  uptimeSeconds: number;
}

/** Extracts PRETTY_NAME from /etc/os-release content (e.g. "Debian GNU/Linux 13 (trixie)"). */
export function parseOsRelease(text: string): string | null {
  const match = text.match(/^PRETTY_NAME="?(.*?)"?$/m);
  return match ? match[1] : null;
}

export function getHostInfo(): HostInfo {
  let os = `${process.platform} ${release()}`;
  try {
    const prettyName = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
    if (prettyName) os = prettyName;
  } catch {
    // not Linux, or the file is missing - keep the platform/release fallback
  }

  const cpuList = cpus();
  return {
    hostname: hostname(),
    os,
    kernel: release(),
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    uptimeSeconds: uptime(),
  };
}
