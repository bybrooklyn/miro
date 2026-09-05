import { runPrivileged } from "../../inventory/exec";
import { getServiceState } from "../../inventory/systemd";
import { LIFELINE_UNITS, SELF_UNIT } from "../classify";
import type { OperationKind } from "../engine";

// Restarting (or stopping/disabling - systemd-unit.ts) a lifeline unit is a `lifeline` operation:
// the engine forces confirmation and, after apply, requires the user to confirm they are still
// reachable or rolls back (§39, PLAN.md §5.7). The unit list is the classifier's LIFELINE_UNITS -
// one source of truth (audit A7: a five-entry copy here let `stop docker` run unattended).

interface Params {
  unit: string;
}

interface Captured {
  active: boolean;
  activeState: string;
}

/** Miro's own unit is never an operation target: the daemon dies mid-operation, so it can neither
 * verify nor roll back, and the crash reconcile at boot would judge a half-done change. */
export function refuseSelf(unit: string): void {
  if (SELF_UNIT.test(unit)) throw new Error(`refused: ${unit} is Miro itself - it cannot verify or roll back its own stop/restart; tell the owner to run systemctl themselves`);
}

export const systemdRestartKind: OperationKind<Params, Captured> = {
  kind: "systemd.restart",

  async describe({ unit }) {
    refuseSelf(unit);
    const state = await getServiceState(unit);
    const lifeline = LIFELINE_UNITS.test(unit);
    return {
      summary: `Restart ${unit} (currently ${state.activeState})`,
      autoApprove: !lifeline,
      class: lifeline ? "lifeline" : "mutate",
      writes: ["/run/systemd", "/run/dbus"],
      network: false,
      warning: lifeline ? "restarting this can drop your connection" : undefined,
      details: { unit, currentState: state.activeState },
      expects: `${unit} is active after the restart`,
      rollbackWhen: "the unit is not active afterwards - its previous state is restored",
      scopeEvidence: "systemd's runtime directories only; no files change",
      dryRunFidelity: "exact",
    };
  },

  async captureState({ unit }) {
    return getServiceState(unit);
  },

  async apply({ unit }) {
    await runPrivileged(["systemctl", "restart", unit], { timeoutMs: 30_000 });
  },

  async verify({ unit }) {
    for (let i = 0; i < 5; i++) {
      if ((await getServiceState(unit)).active) return true;
      await Bun.sleep(1000);
    }
    return false;
  },

  async rollback({ unit }, captured) {
    await runPrivileged(["systemctl", captured.active ? "start" : "stop", unit]).catch(() => {});
  },

  prodtest: ({ unit }) => unit,
};
