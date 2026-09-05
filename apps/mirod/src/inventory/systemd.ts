import { commandExists, run } from "./exec";

export interface ServiceInfo {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

/** Parses `systemctl list-units --type=service --all --no-legend --plain` output. */
export function parseSystemctlList(output: string): ServiceInfo[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const [unit, load, active, sub, ...description] = parts;
      return { unit, load, active, sub, description: description.join(" ") };
    });
}

export async function listServices(): Promise<{ available: boolean; services: ServiceInfo[] }> {
  if (!(await commandExists("systemctl"))) return { available: false, services: [] };
  // "present but not usable" (systemd not the init, dbus down) throws - degrade like the container
  // and tailscale readers do, rather than trap the next direct caller (audit H6).
  try {
    const output = await run("systemctl", ["list-units", "--type=service", "--all", "--no-legend", "--plain"]);
    return { available: true, services: parseSystemctlList(output) };
  } catch {
    return { available: false, services: [] };
  }
}

/** Single-unit read for a specific service's active state - used by the operation engine
 * (apps/mirod/src/operations/kinds/systemd-restart.ts) to capture/verify one unit without
 * re-listing every service on the machine. */
export async function getServiceState(unit: string): Promise<{ active: boolean; activeState: string }> {
  if (!(await commandExists("systemctl"))) return { active: false, activeState: "unknown" };
  const output = await run("systemctl", ["show", unit, "--property=ActiveState", "--value"]);
  const activeState = output.trim();
  return { active: activeState === "active", activeState };
}

/** Whether a unit starts at boot - for systemd-unit.ts's enable/disable capture and verify.
 * `systemctl is-enabled` exits non-zero for "disabled" (and for an unknown unit), which is what
 * the catch is for; only the two enabled states count. */
export async function getUnitEnabled(unit: string): Promise<boolean> {
  if (!(await commandExists("systemctl"))) return false;
  try {
    const output = (await run("systemctl", ["is-enabled", unit])).trim();
    return output === "enabled" || output === "enabled-runtime";
  } catch {
    return false;
  }
}

export interface LogRecord {
  timestamp: string;
  line: string;
}

/** Parses `journalctl -o short-iso` output: a leading ISO timestamp token, then the rest of the line. */
export function parseJournalctl(output: string): LogRecord[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) return { timestamp: "", line };
      return { timestamp: line.slice(0, spaceIdx), line: line.slice(spaceIdx + 1) };
    });
}

export async function serviceLogs(unit: string, lines = 100): Promise<{ available: boolean; logs: LogRecord[] }> {
  if (!(await commandExists("journalctl"))) return { available: false, logs: [] };
  try {
    const output = await run("journalctl", ["-u", unit, "-n", String(lines), "--no-pager", "-o", "short-iso"]);
    return { available: true, logs: parseJournalctl(output) };
  } catch {
    return { available: false, logs: [] };
  }
}
