import { commandExists, run } from "./exec";

// Distro package-manager adapter (plan §7): "distro differences should remain thin and
// deterministic" — one interface, two backends (apt-family covers Debian+Ubuntu, dnf covers
// Fedora), matching the plan's own v1 test matrix. ponytail: read-only (list) only — install/
// remove are a Stage 3+ (Safe action) mutation, not built here.

export type PackageManager = "apt" | "dnf";

export interface InstalledPackage {
  name: string;
  version: string;
}

export interface PackageListResult {
  available: boolean;
  manager: PackageManager | null;
  packages: InstalledPackage[];
}

export async function detectPackageManager(): Promise<PackageManager | null> {
  if (await commandExists("apt")) return "apt";
  if (await commandExists("dnf")) return "dnf";
  return null;
}

/** Parses `apt list --installed` output: `name/suite,now version arch [installed]` per line. */
export function parseAptList(output: string): InstalledPackage[] {
  return output
    .split("\n")
    .filter((line) => line.includes("/") && !line.startsWith("Listing"))
    .map((line) => {
      const [name] = line.split("/");
      const version = line.trim().split(/\s+/)[1] ?? "";
      return { name, version };
    });
}

/** Parses `dnf list installed` output: a header line, then `name.arch  version  repo` rows. */
export function parseDnfList(output: string): InstalledPackage[] {
  return output
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Installed Packages"))
    .map((line) => {
      const [nameArch, version] = line.trim().split(/\s+/);
      return { name: nameArch.replace(/\.[^.]+$/, ""), version: version ?? "" };
    });
}

export async function listInstalledPackages(): Promise<PackageListResult> {
  const manager = await detectPackageManager();
  if (!manager) return { available: false, manager: null, packages: [] };

  if (manager === "apt") {
    const output = await run("apt", ["list", "--installed"]);
    return { available: true, manager, packages: parseAptList(output) };
  }
  const output = await run("dnf", ["list", "installed"]);
  return { available: true, manager, packages: parseDnfList(output) };
}
