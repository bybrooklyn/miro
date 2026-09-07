import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { isAbsolute, join } from "node:path";
import { runPrivileged } from "../../inventory/exec";
import { listServices, type ServiceInfo } from "../../inventory/systemd";
import { inspectContainer, listContainers, type ContainerSummary } from "../../inventory/containers";
import { getMounts, type MountInfo } from "../../inventory/storage";
import { severityFrom } from "../severity";
import type { OperationKind, OperationOutcome } from "../engine";

// The reboot operation (PLAN.md §5.30) - the one operation whose apply() ends the daemon on
// purpose, and the one exemption to systemd-restart.ts's refuseSelf(): the box goes down, so
// verify() can never run inside runOperation. Instead the row stays durably `applying` (the
// pending-bless marker IS the row and its captured_state - no marker file), and at the next boot
// reconcileOperations hands it to `reconcile` below, which proves the box actually rebooted (a
// new kernel boot id), waits for systemd to finish startup, re-gathers what was running, and
// judges: everything back and severity not worse -> committed; something missing ->
// applied_unverified naming it; the daemon merely restarted -> rolled back. A reboot has no undo,
// so a regression is a report, never a false "rolled back".
//
// What would not come back is fixed BEFORE the reboot, inside the same approval: a running
// container with no restart policy gets `--restart unless-stopped` (docker's default `no` is why
// "restart mirod, then docker start jellyfin" used to be a post-boot chore). A compose-managed
// container whose file sets `restart:` explicitly is left alone - the file is its definition; one
// with no key gets the runtime update and the report says which file to fix. Units that are
// active but disabled are only named: their enabled state is their definition of "at boot".

interface Params {
  reason: string;
}

export interface ContainerNote {
  name: string;
  /** The policy at capture - what rollback restores. */
  from: string;
  /** apply() sets `unless-stopped` on this one. */
  update: boolean;
  /** Compose-managed: the file that defines it (the first, when several). */
  composeFile?: string;
}

/** What was running. Containers are the reboot's explicit target (the restart-policy mechanism);
 * unit health is the severity number, NOT a name-by-name diff. Found live (PLAN.md §5.30): diffing
 * the active-unit set at early boot flagged mirod itself (mid-reconcile, before it is `active`),
 * oneshots that had already exited, and dbus/socket-activated units not yet triggered - all false
 * "missing". severityFrom counts FAILED units, which is the honest "a unit did not come back and
 * errored" signal; a clean-inactive on-demand unit is not a reboot failure. `activeServices` is a
 * plain count for the plan, never a pass/fail. */
export interface Snapshot {
  containers: string[];
  activeServices: number;
  dockerAvailable: boolean;
  severity: number;
}

export interface Captured extends Snapshot {
  /** /proc/sys/kernel/random/boot_id at capture ("" if unreadable) - a different one proves the reboot. */
  bootId: string;
  issuedAt: number;
  notes: ContainerNote[];
}

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export function readBootId(): string {
  try {
    return readFileSync(BOOT_ID_PATH, "utf-8").trim();
  } catch {
    return "";
  }
}

export async function snapshot(): Promise<Snapshot & { running: ContainerSummary[] }> {
  const [services, docker, mounts] = await Promise.all([
    listServices().then((r) => r.services).catch(() => [] as ServiceInfo[]),
    listContainers().catch(() => ({ available: false, containers: [] as ContainerSummary[] })),
    getMounts().catch(() => [] as MountInfo[]),
  ]);
  const running = docker.containers.filter((c) => c.state === "running");
  return {
    containers: running.map((c) => c.name),
    activeServices: services.filter((s) => s.active === "active").length,
    dockerAvailable: docker.available,
    severity: severityFrom({ services, containers: docker.containers, mounts }),
    running,
  };
}

/** The explicit `restart:` of one service in a compose file, or undefined when the key is absent
 * (or the file does not parse - treated as absent, so the container still gets a runtime policy
 * and the report names the file). Presence is what matters: an unquoted `no` may parse as false.
 * ponytail: the service's own top-level `restart` only - no deploy.restart_policy, extends, include. */
export function composeRestartKey(yamlText: string, service: string): string | undefined {
  try {
    const doc = Bun.YAML.parse(yamlText) as { services?: Record<string, { restart?: unknown } | null> } | null;
    const restart = doc?.services?.[service]?.restart;
    return restart === undefined || restart === null ? undefined : String(restart);
  } catch {
    return undefined;
  }
}

export async function containerNotes(running: ContainerSummary[]): Promise<ContainerNote[]> {
  const notes: ContainerNote[] = [];
  for (const c of running) {
    const from = (await inspectContainer(c.id).catch(() => null))?.restartPolicy ?? "no";
    // ponytail: on-failure counts as "has a policy" although docker does not start it at boot.
    if (from !== "no") {
      notes.push({ name: c.name, from, update: false });
      continue;
    }
    if (!c.labels["com.docker.compose.project"]) {
      notes.push({ name: c.name, from, update: true });
      continue;
    }
    const workingDir = c.labels["com.docker.compose.project.working_dir"] ?? "";
    const files = (c.labels["com.docker.compose.project.config_files"] ?? "")
      .split(",")
      .filter(Boolean)
      .map((f) => (isAbsolute(f) ? f : join(workingDir, f)));
    const service = c.labels["com.docker.compose.service"] ?? c.name;
    const explicit = files.find((f) => {
      try {
        return composeRestartKey(readFileSync(f, "utf-8"), service) !== undefined;
      } catch {
        return false;
      }
    });
    notes.push(explicit ? { name: c.name, from, update: false, composeFile: explicit } : { name: c.name, from, update: true, composeFile: files[0] });
  }
  return notes;
}

export async function restorePolicies(captured: Captured): Promise<void> {
  for (const n of captured.notes) {
    if (n.update) await runPrivileged(["docker", "update", "--restart", n.from, n.name]).catch(() => {});
  }
}

function missingFrom(before: string[], after: string[]): string[] {
  const now = new Set(after);
  return before.filter((x) => !now.has(x));
}

/** Pure: the post-boot verdict from the pre-reboot capture and the post-boot snapshot. Keys on the
 * containers (the explicit restart-policy target) and the severity number (which counts failed
 * units); a clean-inactive on-demand unit is not a reboot failure, so it is never a "miss". */
export function rebootOutcome(goal: string, captured: Captured, post: Snapshot, verb = "Rebooted"): { outcome: OperationOutcome; message: string } {
  const missingContainers = post.dockerAvailable ? missingFrom(captured.containers, post.containers) : captured.containers;
  const severity = `severity ${captured.severity}->${post.severity}`;
  const composeReminders = captured.notes
    .filter((n) => n.update && n.composeFile)
    .map((n) => `${n.name}'s restart policy was set at runtime - add \`restart: unless-stopped\` to ${n.composeFile} so compose keeps it`);

  if (missingContainers.length === 0 && post.severity <= captured.severity) {
    const reminder = composeReminders.length ? ` ${composeReminders.join("; ")}.` : "";
    return {
      outcome: "committed",
      message: `${verb} - ${goal}, verified: ${captured.containers.length} containers back and no failed units, ${severity}.${reminder}`,
    };
  }

  const missing: string[] = [];
  if (!post.dockerAvailable && captured.containers.length > 0) {
    missing.push(`docker is not reachable - ${captured.containers.length} containers unverified: ${captured.containers.join(", ")}`);
  } else {
    for (const c of missingContainers) {
      const n = captured.notes.find((note) => note.name === c);
      if (n?.composeFile && n.update) missing.push(`${c} (restart policy set at runtime; add \`restart: unless-stopped\` to ${n.composeFile})`);
      else if (n?.composeFile) missing.push(`${c} (its compose file ${n.composeFile} sets restart: ${n.from} - left alone)`);
      else missing.push(`${c} (restart policy ${n?.from ?? "unknown"}; check \`docker logs ${c}\`)`);
    }
  }
  if (missing.length === 0) missing.push(`severity got worse (${captured.severity}->${post.severity}) - run a health check`);
  return { outcome: "applied_unverified", message: `${verb} - ${goal}, but not everything came back (${severity}). Missing: ${missing.join("; ")}.` };
}

/** captureState's result for apply(), keyed by the params object runOperation passes to both
 * (the shell-command.ts pattern - apply gets no captured argument). */
const plans = new WeakMap<object, Captured>();

export const rebootKind: OperationKind<Params, Captured> = {
  kind: "system.reboot",

  async describe({ reason }) {
    const s = await snapshot();
    const notes = await containerNotes(s.running);
    const changed = notes.filter((n) => n.update).map((n) => n.name);
    const warnings = [
      "every connection drops; Miro reports what came back to the first client after boot",
      changed.length ? `containers set to restart=unless-stopped first: ${changed.join(", ")}` : "",
      s.dockerAvailable ? "" : "docker is not reachable - containers cannot be checked",
    ].filter(Boolean);
    return {
      summary: `Reboot the server now - ${reason} (${s.activeServices} services, ${s.containers.length} containers running${changed.length ? `; ${changed.length} containers get restart=unless-stopped first` : ""})`,
      autoApprove: false,
      class: "lifeline",
      irreversible: true,
      writes: ["/run/systemd", "/var/run/docker.sock"],
      network: false,
      warning: warnings.join(". "),
      details: {
        services: s.activeServices,
        containers: s.containers.length,
        policyChanges: changed,
        composeFilesToEdit: notes.filter((n) => n.update && n.composeFile).map((n) => n.composeFile),
      },
      expects: "after the reboot the same containers are running and no unit has failed - checked by Miro at its next boot, reported on the first connection",
      rollbackWhen: "never - a reboot cannot be undone; if the server does not actually reboot, the container restart policies are restored",
      scopeEvidence: "docker's socket for the restart-policy updates; systemd for the reboot itself",
      dryRunFidelity: "partial",
    };
  },

  async captureState(params) {
    // Re-gathered, not reused from describe: the owner may take minutes to approve.
    const { running, ...s } = await snapshot();
    const captured: Captured = { ...s, bootId: readBootId(), issuedAt: Date.now(), notes: await containerNotes(running) };
    plans.set(params, captured);
    return captured;
  },

  async apply(params) {
    for (const n of plans.get(params)?.notes ?? []) {
      if (n.update) await runPrivileged(["docker", "update", "--restart", "unless-stopped", n.name]);
    }
    await runPrivileged(["systemctl", "reboot"]);
    // systemctl reboot returns once the job is queued; systemd then stops this daemon. Still here
    // after two minutes means the reboot was refused (an inhibitor, a failed shutdown job) - fail
    // honestly, so the engine's rollback restores the policies and the row never claims a reboot.
    await Bun.sleep(120_000);
    throw new Error("the server did not reboot");
  },

  // Unreachable in runOperation - the daemon dies in apply. At boot, `reconcile` is the verify.
  async verify() {
    return true;
  },

  async rollback(_params, captured) {
    await restorePolicies(captured);
  },

  // Nothing lasting to re-verify; without this, prodtest would re-run verify() on the committed row forever.
  prodtest: () => null,

  async reconcile({ reason }, captured) {
    // The boot id is exact and clock-independent; the uptime rule is only for a box where it
    // could not be read at capture (a no-RTC board can boot with a lagging clock).
    const rebooted = captured.bootId ? readBootId() !== captured.bootId : uptime() * 1000 < Date.now() - captured.issuedAt;
    if (!rebooted) {
      await restorePolicies(captured);
      return { outcome: "rolledback", message: `Rolled back - ${reason}: the server did not reboot (Miro restarted, the box did not); container restart policies restored.` };
    }
    // Bounded settle: poll until everything is back, or 2 minutes. NOT `is-system-running --wait` -
    // reconcile runs before the socket binds, so the daemon is itself an unfinished unit systemd's
    // startup is waiting on; --wait would deadlock against mirod's own start until the timeout. A
    // poll of what actually matters (docker back, the containers and units that were running are
    // again) breaks in seconds when healthy and reports precisely what is missing when not.
    const deadline = Date.now() + 120_000;
    let post = await snapshot();
    while (Date.now() < deadline && rebootOutcome(reason, captured, post).outcome !== "committed") {
      await Bun.sleep(5_000);
      post = await snapshot();
    }
    return rebootOutcome(reason, captured, post);
  },
};
