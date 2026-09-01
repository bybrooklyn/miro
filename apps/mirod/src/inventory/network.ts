import { networkInterfaces } from "node:os";
import { commandExists, run } from "./exec";

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
  mac: string;
}

export function getNetworkInterfaces(): NetworkInterfaceInfo[] {
  const out: NetworkInterfaceInfo[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      out.push({ name, address: addr.address, family: addr.family as "IPv4" | "IPv6", internal: addr.internal, mac: addr.mac });
    }
  }
  return out;
}

export interface TailscaleStatus {
  available: boolean;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
}

/** Parses `tailscale status --json` output. */
export function parseTailscaleStatus(json: string): Omit<TailscaleStatus, "available"> {
  const data = JSON.parse(json);
  const self = data.Self;
  return {
    connected: data.BackendState === "Running",
    ip: self?.TailscaleIPs?.[0] ?? null,
    hostname: self?.HostName ?? null,
  };
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  if (!(await commandExists("tailscale"))) {
    return { available: false, connected: false, ip: null, hostname: null };
  }
  try {
    const output = await run("tailscale", ["status", "--json"]);
    return { available: true, ...parseTailscaleStatus(output) };
  } catch {
    // installed but not logged in / daemon not running
    return { available: true, connected: false, ip: null, hostname: null };
  }
}
