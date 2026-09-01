import { commandExists, run } from "./exec";

// Read-only slice of plan §8's ContainerRuntime interface (listContainers/inspectContainer/logs).
// ponytail: pull/deploy/events are mutation/streaming operations for Stage 3+ (Safe action) —
// skipped here rather than stubbed, since there's nothing to verify against without a live daemon.

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  ports: string;
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string | null;
  startedAt: string;
  restartCount: number;
  labels: Record<string, string>;
  mounts: { source: string; destination: string }[];
  ports: { containerPort: string; hostPort: string | null }[];
}

export interface LogRecord {
  timestamp: string;
  line: string;
}

/** Docker's own `,`-joined `key=value` label string (its own --format json quirk, not real JSON). */
export function parseLabels(raw: string): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

interface DockerPsRow {
  ID: string;
  Image: string;
  Names: string;
  State: string;
  Status: string;
  Labels: string;
  Ports: string;
}

export function parseDockerPs(output: string): ContainerSummary[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DockerPsRow)
    .map((row) => ({
      id: row.ID,
      name: row.Names,
      image: row.Image,
      state: row.State,
      status: row.Status,
      labels: parseLabels(row.Labels),
      ports: row.Ports,
    }));
}

export async function listContainers(): Promise<{ available: boolean; containers: ContainerSummary[] }> {
  if (!(await commandExists("docker"))) return { available: false, containers: [] };
  try {
    const output = await run("docker", ["ps", "-a", "--format", "{{json .}}"]);
    return { available: true, containers: parseDockerPs(output) };
  } catch {
    // docker CLI present but the daemon is unreachable (stopped, permissions, ...)
    return { available: false, containers: [] };
  }
}

export function parseDockerInspect(json: string): ContainerDetail {
  const [raw] = JSON.parse(json) as any[];
  const ports: ContainerDetail["ports"] = [];
  for (const [containerPort, bindings] of Object.entries(raw.NetworkSettings?.Ports ?? {})) {
    const list = (bindings as { HostPort?: string }[] | null) ?? [null];
    for (const binding of list) {
      ports.push({ containerPort, hostPort: binding?.HostPort ?? null });
    }
  }
  return {
    id: raw.Id,
    name: (raw.Name ?? "").replace(/^\//, ""),
    image: raw.Config?.Image ?? "",
    state: raw.State?.Status ?? "unknown",
    health: raw.State?.Health?.Status ?? null,
    startedAt: raw.State?.StartedAt ?? "",
    restartCount: raw.RestartCount ?? 0,
    labels: raw.Config?.Labels ?? {},
    mounts: (raw.Mounts ?? []).map((m: any) => ({ source: m.Source, destination: m.Destination })),
    ports,
  };
}

export async function inspectContainer(id: string): Promise<ContainerDetail> {
  return parseDockerInspect(await run("docker", ["inspect", id]));
}

export function parseDockerLogs(output: string): LogRecord[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      return { timestamp: line.slice(0, spaceIdx), line: line.slice(spaceIdx + 1) };
    });
}

export async function containerLogs(id: string, tail = 100): Promise<LogRecord[]> {
  return parseDockerLogs(await run("docker", ["logs", "--timestamps", "--tail", String(tail), id]));
}
