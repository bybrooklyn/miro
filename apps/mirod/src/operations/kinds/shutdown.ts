import { uptime } from "node:os";
import { runPrivileged } from "../../inventory/exec";
import { snapshot, containerNotes, restorePolicies, readBootId, rebootOutcome, type Captured } from "./reboot";
import type { OperationKind } from "../engine";

// The graceful power-off (PLAN.md Power/UPS slice) - the ONLY sanctioned way the box goes down for
// power, added because a UPS low-battery event needs a clean shutdown, not a hard cut. Raw
// `poweroff`/`shutdown` commands stay forbidden by the classifier; the box can only power off
// through this tracked, confirmed, lifeline operation. It reuses reboot.ts's take-down machinery
// (capture running containers + set their restart policy so they come back when power returns,
// then systemctl poweroff), and reboot's boot-time reconcile pattern: a power-off has no undo, so
// verify runs at the NEXT boot (when mains returns and the box comes back) - a new boot id proves
// it powered off and came back, and the containers/severity are re-checked. The pre-shutdown backup
// flush lives at the call sites (the UPS monitor and the system_shutdown tool), which hold the
// backup deps - the kind itself stays pure.

interface Params {
  reason: string;
}

const plans = new WeakMap<object, Captured>();

export const shutdownKind: OperationKind<Params, Captured> = {
  kind: "system.shutdown",

  async describe({ reason }) {
    const s = await snapshot();
    const notes = await containerNotes(s.running);
    const changed = notes.filter((n) => n.update).map((n) => n.name);
    return {
      summary: `Power off the server now - ${reason} (${s.activeServices} services, ${s.containers.length} containers running${changed.length ? `; ${changed.length} containers get restart=unless-stopped first` : ""}). It stays off until power is restored.`,
      autoApprove: false,
      class: "lifeline",
      irreversible: true,
      writes: ["/run/systemd", "/var/run/docker.sock"],
      network: false,
      warning: [
        "the server powers OFF and stays off until mains or manual power returns; every connection drops",
        changed.length ? `containers set to restart=unless-stopped first: ${changed.join(", ")}` : "",
        s.dockerAvailable ? "" : "docker is not reachable - containers cannot be checked",
      ]
        .filter(Boolean)
        .join(". "),
      details: {
        services: s.activeServices,
        containers: s.containers.length,
        policyChanges: changed,
        composeFilesToEdit: notes.filter((n) => n.update && n.composeFile).map((n) => n.composeFile),
      },
      expects: "after power returns and the box boots, the same containers are running and no unit has failed - checked by Miro at its next boot, reported on the first connection",
      rollbackWhen: "never - a power-off cannot be undone; if the box does not actually power off, the container restart policies are restored",
      scopeEvidence: "docker's socket for the restart-policy updates; systemd for the poweroff itself",
      dryRunFidelity: "partial",
    };
  },

  async captureState(params) {
    const { running, ...s } = await snapshot();
    const captured: Captured = { ...s, bootId: readBootId(), issuedAt: Date.now(), notes: await containerNotes(running) };
    plans.set(params, captured);
    return captured;
  },

  async apply(params) {
    for (const n of plans.get(params)?.notes ?? []) {
      if (n.update) await runPrivileged(["docker", "update", "--restart", "unless-stopped", n.name]);
    }
    await runPrivileged(["systemctl", "poweroff"]);
    // Same honesty as reboot: poweroff returns once queued, then systemd stops this daemon. Still
    // here after two minutes means an inhibitor refused it - fail so the engine restores policies
    // and the row never falsely claims a power-off.
    await Bun.sleep(120_000);
    throw new Error("the server did not power off");
  },

  // Unreachable in runOperation - the daemon dies in apply. At the next boot, `reconcile` is the verify.
  async verify() {
    return true;
  },

  async rollback(_params, captured) {
    await restorePolicies(captured);
  },

  prodtest: () => null,

  async reconcile({ reason }, captured) {
    const cameBack = captured.bootId ? readBootId() !== captured.bootId : uptime() * 1000 < Date.now() - captured.issuedAt;
    if (!cameBack) {
      await restorePolicies(captured);
      return { outcome: "rolledback", message: `Rolled back - ${reason}: the server did not power off (Miro restarted, the box did not); container restart policies restored.` };
    }
    const deadline = Date.now() + 120_000;
    let post = await snapshot();
    while (Date.now() < deadline && rebootOutcome(reason, captured, post, "Powered off and came back").outcome !== "committed") {
      await Bun.sleep(5_000);
      post = await snapshot();
    }
    return rebootOutcome(reason, captured, post, "Powered off and came back");
  },
};
