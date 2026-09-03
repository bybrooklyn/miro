import type { Database } from "bun:sqlite";
import { listContainers, type ContainerSummary } from "./inventory/containers";
import { listServices, type ServiceInfo } from "./inventory/systemd";
import { remember } from "./memory/store";
import { NOISE_UNIT } from "./agent/context";

// Server discovery (PLAN.md §5.13). Turn the live box into (a) durable server_fact memories and
// (b) the app-presence facts the learning agent needs, so learning never depends on a hand-written
// golden hint. Reads only through the existing inventory tools; writes only through memory/store's
// redaction choke point. The shell-touching wrappers are thin; the parsing/formatting is pure and
// unit-tested — the same split as inventory/containers.ts's parseDockerPs vs listContainers.

/** Host-published ports parsed from `docker ps`'s Ports field
 *  ("0.0.0.0:8096->8096/tcp, :::8096->8096/tcp" → [8096]). Host side only, deduped, sorted.
 *  A container port with no host binding ("8096/tcp") has no "->" and is correctly ignored. */
export function hostPorts(portsField: string): number[] {
  const ports = new Set<number>();
  for (const m of portsField.matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[?::\]?):(\d+)->/g)) ports.add(Number(m[1]));
  return [...ports].sort((a, b) => a - b);
}

/** "jellyfin/jellyfin:10.11" → "jellyfin". The name people actually match an app by. */
function imageBase(image: string): string {
  return image.toLowerCase().split("/").pop()?.split(":")[0] ?? "";
}

export interface AppPresence {
  found: boolean;
  container?: { name: string; image: string; state: string; ports: number[] };
  service?: string;
  baseUrlGuess?: string;
  evidence: string[];
}

/** Pure: given already-fetched inventory, locate an app by name (substring on container name or
 * image basename, or a systemd unit name) and derive a likely base URL from its first host port. */
export function presenceFrom(app: string, containers: ContainerSummary[], services: ServiceInfo[]): AppPresence {
  const a = app.trim().toLowerCase();
  const evidence: string[] = [];
  let container: AppPresence["container"];
  const hit = containers.find((c) => c.name.toLowerCase().includes(a) || imageBase(c.image).includes(a));
  if (hit) {
    const ports = hostPorts(hit.ports);
    container = { name: hit.name, image: hit.image, state: hit.state, ports };
    evidence.push(
      `Docker container "${hit.name}" (image ${hit.image}, ${hit.state})` +
        (ports.length ? ` publishing host port(s) ${ports.join(", ")}` : ", no published ports"),
    );
  }
  let service: string | undefined;
  const unit = services.find((s) => s.unit.toLowerCase().includes(a));
  if (unit) {
    service = unit.unit;
    evidence.push(`systemd unit "${service}" (${unit.active})`);
  }
  const port = container?.ports[0];
  const baseUrlGuess = port ? `http://localhost:${port}` : undefined;
  if (baseUrlGuess) evidence.push(`likely base URL ${baseUrlGuess} (unverified — probe it)`);
  return { found: Boolean(container || service), container, service, baseUrlGuess, evidence };
}

/** The discovery-derived replacement for a golden hint: a one-line "here's what's on your box"
 * string fed into the learn goal. Honest when nothing matched — the agent still has its ladder. */
export function formatPresence(app: string, p: AppPresence): string {
  return p.found
    ? `found on this box — ${p.evidence.join("; ")}`
    : `not found running on this box (no matching container or systemd unit) — it may be stopped or named differently; inspect with container_list / shell_inspect`;
}

/** Thin wrapper: fetch live inventory, then presenceFrom. */
export async function discoverAppOnBox(app: string): Promise<AppPresence> {
  const [containers, services] = await Promise.all([
    listContainers().then((r) => r.containers).catch(() => [] as ContainerSummary[]),
    listServices().then((r) => r.services).catch(() => [] as ServiceInfo[]),
  ]);
  return presenceFrom(app, containers, services);
}

/** Pure: the durable, high-level server_facts to persist from live inventory. Deliberately few and
 * summarised — raw per-container detail already reaches the agent every turn via the live snapshot
 * in agent/context.ts; these are the cross-restart, reinforceable facts, not a copy of that. */
export function factsFrom(containers: ContainerSummary[], services: ServiceInfo[]): { key: string; value: string }[] {
  const facts: { key: string; value: string }[] = [];
  if (containers.length) {
    const running = containers.filter((c) => c.state === "running");
    const shown = (running.length ? running : containers).map((c) => c.name);
    facts.push({
      key: "server.containers",
      value:
        `Runs ${containers.length} Docker container(s)${running.length ? `, ${running.length} running` : ""}: ` +
        `${shown.slice(0, 20).join(", ")}${shown.length > 20 ? ` (+${shown.length - 20} more)` : ""}`,
    });
  }
  const active = services.filter((s) => s.active === "active" && !NOISE_UNIT.test(s.unit)).map((s) => s.unit);
  if (active.length) {
    facts.push({ key: "server.services", value: `Active services of note: ${active.slice(0, 20).join(", ")}` });
  }
  return facts;
}

/** Persist the derived server_facts, reinforced on each run (occurrence_count grows → confidence).
 * ponytail: no staleness prune — a removed container's fact lingers until the next sweep re-derives
 * (and overwrites) the value. Add a last_seen prune only if stale facts actually mislead. */
export async function runDiscovery(db: Database): Promise<{ facts: number }> {
  const [containers, services] = await Promise.all([
    listContainers().then((r) => r.containers).catch(() => [] as ContainerSummary[]),
    listServices().then((r) => r.services).catch(() => [] as ServiceInfo[]),
  ]);
  const facts = factsFrom(containers, services);
  for (const f of facts) remember(db, "server_fact", f.key, f.value, "discovery");
  return { facts: facts.length };
}
