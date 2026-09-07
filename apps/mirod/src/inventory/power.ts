import { commandExists, run } from "./exec";

// Read-only UPS state via NUT's `upsc` (PLAN.md Power/UPS slice). Mirrors the inventory pattern
// (gpu.ts): a pure parser separated from the guarded I/O, never throws, an `available` flag. NUT
// exposes the UPS over a local socket (upsd on 127.0.0.1:3493); `upsc` reads it unauthenticated.

export interface UpsStatus {
  name: string;
  /** Raw ups.status, e.g. "OL", "OB DISCHRG", "OB LB". */
  status: string;
  flags: string[];
  /** OB present - running on battery (mains lost). */
  onBattery: boolean;
  /** LB present - battery low, a graceful shutdown is due. */
  lowBattery: boolean;
  charge: number | null;
  runtimeSec: number | null;
  model: string | null;
}

export interface PowerReadout {
  available: boolean;
  upses: UpsStatus[];
}

/** `key: value` lines from `upsc`. A value can contain spaces (ups.status = "OB DISCHRG"). */
export function parseUpsc(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function upsStatusFrom(name: string, vars: Record<string, string>): UpsStatus {
  const status = vars["ups.status"] ?? "";
  const flags = status.split(/\s+/).filter(Boolean);
  const num = (k: string) => {
    const v = Number(vars[k]);
    return vars[k] !== undefined && Number.isFinite(v) ? v : null;
  };
  return {
    name,
    status,
    flags,
    onBattery: flags.includes("OB"),
    lowBattery: flags.includes("LB"),
    charge: num("battery.charge"),
    runtimeSec: num("battery.runtime"),
    model: vars["ups.model"] ?? vars["device.model"] ?? null,
  };
}

/** UPS names NUT knows (`upsc -l`), each as "<name>@localhost". Empty when NUT is not set up. */
export async function listUps(): Promise<string[]> {
  if (!(await commandExists("upsc"))) return [];
  try {
    return (await run("upsc", ["-l"], { timeoutMs: 5_000 }))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((n) => `${n}@localhost`);
  } catch {
    return [];
  }
}

/** One UPS's live state. Never throws - a missing/wedged upsd yields status "". */
export async function readUps(name: string): Promise<UpsStatus> {
  try {
    return upsStatusFrom(name, parseUpsc(await run("upsc", [name], { timeoutMs: 5_000 })));
  } catch {
    return { name, status: "", flags: [], onBattery: false, lowBattery: false, charge: null, runtimeSec: null, model: null };
  }
}

/** Every UPS NUT knows about. `available:false` when NUT/upsc is absent or lists none. */
export async function readAllUps(): Promise<PowerReadout> {
  const names = await listUps();
  if (names.length === 0) return { available: false, upses: [] };
  return { available: true, upses: await Promise.all(names.map(readUps)) };
}
