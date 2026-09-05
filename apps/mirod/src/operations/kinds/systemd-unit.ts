import { run } from "../../inventory/exec";
import { getServiceState, getUnitEnabled } from "../../inventory/systemd";
import type { OperationKind } from "../engine";
import { LIFELINE_ADJACENT } from "./systemd-restart";

// Every systemctl change other than a restart (PLAN.md §5.23). It exists because `systemctl` can
// never run as a sandboxed shell command: bubblewrap gives the command its own PID namespace
// (deliberately - it hides host processes' environments), and systemctl refuses to talk to PID 1
// from another one ("Failed to connect to system scope bus via local transport", found live). So,
// like systemd.restart, this kind runs `sudo systemctl` in the daemon's own namespace, with the
// capture/verify/rollback the engine gives every operation - the classifier refuses the shell
// route and points here.

export const UNIT_ACTIONS = ["start", "stop", "enable", "disable", "daemon-reload"] as const;
export type UnitAction = (typeof UNIT_ACTIONS)[number];

export interface SystemdUnitParams {
  action: UnitAction;
  /** Required for every action but daemon-reload. */
  unit?: string;
}

interface Captured {
  active: boolean;
  enabled: boolean;
}

/** Unit names are passed as argv (never through a shell), so this is a sanity check, not an
 * injection guard: a stray space or quote is a model mistake worth naming early. */
const UNIT_NAME = /^[A-Za-z0-9@._:\\-]+$/;

function unitFor(p: SystemdUnitParams): string {
  if (p.action === "daemon-reload") return "";
  if (!p.unit || !UNIT_NAME.test(p.unit)) throw new Error(`refused: "${p.unit ?? ""}" is not a systemd unit name (e.g. jellyfin.service)`);
  return p.unit;
}

export const systemdUnitKind: OperationKind<SystemdUnitParams, Captured> = {
  kind: "systemd.unit",

  async describe(p) {
    const unit = unitFor(p);
    if (p.action === "daemon-reload") {
      return {
        summary: "systemctl daemon-reload (re-read unit files)",
        autoApprove: true,
        class: "mutate",
        writes: ["/run/systemd"],
        network: false,
        expects: "systemd has re-read every unit file",
        rollbackWhen: "never - reloading unit definitions is not undone, the files are what they are",
        scopeEvidence: "systemd's runtime directory only",
        dryRunFidelity: "exact",
      };
    }
    const lifeline = LIFELINE_ADJACENT.has(unit) && (p.action === "stop" || p.action === "disable");
    const state = await getServiceState(unit);
    const enabled = await getUnitEnabled(unit);
    const expects: Record<UnitAction, string> = {
      start: `${unit} is active`,
      stop: `${unit} is inactive`,
      enable: `${unit} is enabled at boot`,
      disable: `${unit} is not enabled at boot`,
      "daemon-reload": "",
    };
    return {
      summary: `${p.action} ${unit} (currently ${state.activeState}, ${enabled ? "enabled" : "not enabled"})`,
      autoApprove: !lifeline,
      class: lifeline ? "lifeline" : "mutate",
      writes: p.action === "enable" || p.action === "disable" ? ["/run/systemd", "/etc/systemd/system"] : ["/run/systemd", "/run/dbus"],
      network: false,
      warning: lifeline ? `stopping ${unit} can drop your connection` : undefined,
      details: { unit, action: p.action, currentState: state.activeState, enabled },
      expects: expects[p.action],
      rollbackWhen: "the expected state is not observed afterwards - the previous active/enabled state is restored",
      scopeEvidence: p.action === "enable" || p.action === "disable" ? "systemd's runtime directory and the /etc/systemd/system symlinks enable/disable manage" : "systemd's runtime directories only; no files change",
      dryRunFidelity: "exact",
    };
  },

  async captureState(p) {
    if (p.action === "daemon-reload") return { active: false, enabled: false };
    const unit = unitFor(p);
    return { active: (await getServiceState(unit)).active, enabled: await getUnitEnabled(unit) };
  },

  async apply(p) {
    const unit = unitFor(p);
    await run("sudo", ["systemctl", p.action, ...(unit ? [unit] : [])], { timeoutMs: 60_000 });
  },

  async verify(p) {
    if (p.action === "daemon-reload") return true;
    const unit = unitFor(p);
    for (let i = 0; i < 5; i++) {
      const ok =
        p.action === "start" ? (await getServiceState(unit)).active
        : p.action === "stop" ? !(await getServiceState(unit)).active
        : p.action === "enable" ? await getUnitEnabled(unit)
        : !(await getUnitEnabled(unit));
      if (ok) return true;
      await Bun.sleep(1000);
    }
    return false;
  },

  async rollback(p, captured) {
    if (p.action === "daemon-reload") return;
    const unit = unitFor(p);
    const undo = p.action === "start" || p.action === "stop" ? (captured.active ? "start" : "stop") : captured.enabled ? "enable" : "disable";
    await run("sudo", ["systemctl", undo, unit]).catch(() => {});
  },
};
