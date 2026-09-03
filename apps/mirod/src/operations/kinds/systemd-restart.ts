import { run } from "../../inventory/exec";
import { getServiceState } from "../../inventory/systemd";
import type { OperationKind } from "../engine";

// Restarting one of these is a `lifeline` operation: the engine forces confirmation and, after
// apply, requires the user to confirm they are still reachable or rolls back (§39, PLAN.md §5.7).
const LIFELINE_ADJACENT = new Set([
  "ssh.service",
  "sshd.service",
  "systemd-networkd.service",
  "NetworkManager.service",
  "tailscaled.service",
]);

interface Params {
  unit: string;
}

interface Captured {
  active: boolean;
  activeState: string;
}

export const systemdRestartKind: OperationKind<Params, Captured> = {
  kind: "systemd.restart",

  async describe({ unit }) {
    const state = await getServiceState(unit);
    const lifeline = LIFELINE_ADJACENT.has(unit);
    return {
      summary: `Restart ${unit} (currently ${state.activeState})`,
      autoApprove: !lifeline,
      class: lifeline ? "lifeline" : "mutate",
      writes: ["/run/systemd", "/run/dbus"],
      network: false,
      warning: lifeline ? "restarting this can drop your connection" : undefined,
      details: { unit, currentState: state.activeState },
      expects: `${unit} is active after the restart`,
      rollbackWhen: "the unit is not active afterwards — its previous state is restored",
      scopeEvidence: "systemd's runtime directories only; no files change",
      dryRunFidelity: "exact",
    };
  },

  async captureState({ unit }) {
    return getServiceState(unit);
  },

  async apply({ unit }) {
    await run("sudo", ["systemctl", "restart", unit], { timeoutMs: 30_000 });
  },

  async verify({ unit }) {
    for (let i = 0; i < 5; i++) {
      if ((await getServiceState(unit)).active) return true;
      await Bun.sleep(1000);
    }
    return false;
  },

  async rollback({ unit }, captured) {
    await run("sudo", ["systemctl", captured.active ? "start" : "stop", unit]).catch(() => {});
  },
};
