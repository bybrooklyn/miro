import { writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { commandExists, run, runPrivileged } from "../../inventory/exec";
import type { OperationKind } from "../engine";

// Set up UPS monitoring via NUT (PLAN.md Power/UPS slice), as a confirmed docker-free apt operation
// so "watch my UPS" is something Miro does. Defaults to NUT's dummy-ups (a file-driven simulator)
// so the whole monitor -> shutdown flow is testable with no hardware; pass a real driver/port for
// physical hardware (e.g. driver "usbhid-ups"). Monitor-only: it runs upsd + the driver so `upsc`
// answers, but NOT upsmon - Miro owns the shutdown decision (the power monitor + system.shutdown),
// not upsmon's SHUTDOWNCMD. The recipe (dummy-loop reflecting live file edits, upsc unauthenticated
// reads) was proven live on the dev VM before this was written.

export const NUT_DIR = "/etc/nut";
export const NUT_UPS_SETTING = "power.ups"; // "<name>@localhost", read by the monitor and power_ups

export interface NutInstallParams {
  reason: string;
  /** NUT driver, default the file-driven simulator. Real hardware: e.g. "usbhid-ups". */
  driver?: string;
  /** Driver port. For dummy-ups a state file (relative -> under /etc/nut); for USB, "auto". */
  port?: string;
  /** The UPS name in ups.conf (upsc addresses "<name>@localhost"). */
  name?: string;
}

function resolved(p: NutInstallParams) {
  return { driver: p.driver ?? "dummy-ups", port: p.port ?? "dummy.dev", name: p.name ?? "ups" };
}

function statePath(port: string): string {
  return isAbsolute(port) ? port : join(NUT_DIR, port);
}

async function upscStatus(name: string): Promise<string> {
  return (await run("upsc", [`${name}@localhost`, "ups.status"], { timeoutMs: 5_000 }).catch(() => "")).trim();
}

export const nutInstallKind: OperationKind<NutInstallParams, { hadConf: boolean }> = {
  kind: "nut.install",

  async describe(p) {
    const r = resolved(p);
    const hasNut = await commandExists("upsc");
    const isDummy = r.driver === "dummy-ups";
    return {
      summary: `Set up UPS monitoring via NUT (driver ${r.driver}, UPS "${r.name}")${isDummy ? " - a simulated UPS for testing the power-loss flow" : ""}`,
      autoApprove: false,
      class: "mutate",
      writes: [NUT_DIR, "/run/systemd"],
      network: !hasNut,
      warning: hasNut ? "" : "installs the `nut` package if absent (needs network, minutes on a slow link)",
      details: { driver: r.driver, port: r.port, ups: r.name, simulated: isDummy },
      expects: `upsc ${r.name}@localhost reports a status`,
      rollbackWhen: "upsc does not report a status within the window - the NUT services are stopped",
      scopeEvidence: "NUT's config dir and systemd; upsd binds loopback only, reads are unauthenticated",
      dryRunFidelity: "partial",
    };
  },

  async captureState() {
    return { hadConf: existsSync(join(NUT_DIR, "ups.conf")) };
  },

  async apply(p) {
    const r = resolved(p);
    if (!(await commandExists("upsc"))) {
      await runPrivileged(["apt-get", "install", "-y", "nut"], { timeoutMs: 15 * 60_000 });
    }
    writeFileSync(join(NUT_DIR, "nut.conf"), "MODE=standalone\n", { mode: 0o644 });
    const upsConf =
      `[${r.name}]\n    driver = ${r.driver}\n    port = ${r.port}\n` +
      (r.driver === "dummy-ups" ? "    mode = dummy-loop\n" : "") +
      `    desc = "Miro-managed UPS"\n`;
    writeFileSync(join(NUT_DIR, "ups.conf"), upsConf, { mode: 0o644 });
    writeFileSync(join(NUT_DIR, "upsd.conf"), "LISTEN 127.0.0.1 3493\n", { mode: 0o644 });
    if (r.driver === "dummy-ups") {
      const sp = statePath(r.port);
      // Seed a healthy state only on first setup, so a re-run never clobbers an in-progress sim.
      if (!existsSync(sp)) writeFileSync(sp, "ups.status: OL\nbattery.charge: 100\nbattery.runtime: 3600\nups.mfr: Miro\nups.model: SimUPS\n", { mode: 0o644 });
    }
    // upsd, then the per-UPS driver via Debian's enumerator (which generates nut-driver@<name>).
    await runPrivileged(["systemctl", "restart", "nut-server"]).catch(() => {});
    await runPrivileged(["systemctl", "restart", "nut-driver-enumerator.service"]).catch(() => {});
    await runPrivileged(["systemctl", "start", `nut-driver@${r.name}.service`]).catch(() => {});
  },

  async verify(p) {
    const { name } = resolved(p);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await upscStatus(name)) return true;
      await Bun.sleep(2_000);
    }
    return false;
  },

  async rollback(p) {
    const { name } = resolved(p);
    await runPrivileged(["systemctl", "stop", `nut-driver@${name}.service`]).catch(() => {});
    await runPrivileged(["systemctl", "stop", "nut-server"]).catch(() => {});
  },

  // The UPS keeps needing to answer - a dead upsd is drift worth an incident.
  prodtest: (p) => `nut:${resolved(p).name}`,
};
