import type { Database } from "bun:sqlite";
import { listServices, type ServiceInfo } from "../inventory/systemd";
import { listContainers, type ContainerSummary } from "../inventory/containers";
import { getMounts, type MountInfo } from "../inventory/storage";

// The severity oracle (PLAN.md §5.15 A, STRATUS's Transactional No-Regression): a cheap,
// kind-independent health number computed before and after every operation. The engine commits
// only if the kind's own verify() passes AND the box is not WORSE off than before - catching a
// narrowly-correct verify() (e.g. "is this one unit active") that missed a wider regression the
// same action caused elsewhere. Split pure-vs-shell like discovery.ts: the score is a pure
// function of already-fetched inventory, unit-tested with no mocks; the live gather is a thin
// wrapper. ponytail: an unweighted sum of simple counts, not a calibrated model - tune the
// dimensions/weights if this proves too noisy or too blind in real use.
//
// Structural dimensions only. A "recent incidents" term used to be added (audit A11): incidents
// are written by background sweeps (Prodtest drift, the extension health probe) outside the write
// lock, and within one operation the count can only go UP - so the term could only ever produce a
// false "the server got worse" rollback of a verified change, never catch a real one.

export interface SeverityInputs {
  services: ServiceInfo[];
  containers: ContainerSummary[];
  mounts: MountInfo[];
}

const DISK_CRITICAL_PERCENT = 90;

/** Pure: derive the severity number from already-fetched inventory. */
export function severityFrom(inputs: SeverityInputs): number {
  const failedUnits = inputs.services.filter((s) => s.active === "failed").length;
  // Cheap signal only: a crash-looping container, from the already-fetched listContainers state
  // string. A real per-container HEALTHCHECK status needs an inspect call per container - too
  // expensive to run on every operation's severity check; add it if this proves too blind.
  const unhealthyContainers = inputs.containers.filter((c) => c.state === "restarting").length;
  const diskCritical = inputs.mounts.filter((m) => m.usedPercent >= DISK_CRITICAL_PERCENT).length;
  return failedUnits + unhealthyContainers + diskCritical;
}

/** Live gather + score. Never throws - an inventory source that's unavailable (no docker, no
 * systemd) contributes zero to its dimension rather than failing the whole severity check, same
 * degrade-gracefully convention every inventory tool already follows. `db` is kept for the
 * injectable signature the engine uses (OperationToolContext.computeSeverity). */
export async function computeSeverity(_db: Database): Promise<number> {
  const [services, containers, mounts] = await Promise.all([
    listServices().then((r) => r.services).catch(() => [] as ServiceInfo[]),
    listContainers().then((r) => r.containers).catch(() => [] as ContainerSummary[]),
    getMounts().catch(() => [] as MountInfo[]),
  ]);
  return severityFrom({ services, containers, mounts });
}
