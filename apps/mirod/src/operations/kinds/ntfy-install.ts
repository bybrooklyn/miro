import { randomBytes } from "node:crypto";
import { commandExists, runPrivileged } from "../../inventory/exec";
import { getNetworkInterfaces, getTailscaleStatus } from "../../inventory/network";
import { readTextCapped } from "../../fetch-body";
import type { OperationKind } from "../engine";

// A self-hosted ntfy for the notification bus (PLAN.md §5.31 follow-up), as a confirmed docker
// operation - so "set up notifications on my phone" is something Miro does, not a chore left to the
// owner. Mirrors searxng-install.ts: `docker` in the daemon's own namespace, the socket declared,
// verify by a real probe, rollback removes the container. Unlike SearXNG (reached only by the
// daemon on loopback) ntfy must be reachable by the owner's PHONE, so it binds all interfaces and
// the plan shows a subscribe URL on a real address (tailscale, else the LAN IP). The daemon's own
// sink still POSTs to loopback - the same server, a more reliable address.

export const NTFY_CONTAINER = "miro-ntfy";
export const NTFY_IMAGE = "binwiederhier/ntfy:latest";
export const DEFAULT_NTFY_PORT = 8090;
export const NTFY_URL_SETTING = "notify.ntfy.url";
export const NTFY_TOPIC_SETTING = "notify.ntfy.topic";

export interface NtfyInstallParams {
  port: number;
  /** The topic the owner subscribes to - its unguessability is the access control (ponytail: no
   * ntfy auth in v1; add users/tokens if the node is ever internet-exposed). */
  topic: string;
  /** The phone-reachable base URL (tailscale or LAN), shown to the owner and passed to ntfy as
   * --base-url for the links it generates. The daemon's sink uses loopback instead. */
  baseUrl: string;
}

/** What the daemon's own ntfy sink POSTs to - the same server, reached on loopback. */
export function ntfyLocalUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** A fresh, hard-to-guess topic. */
export function generateTopic(): string {
  return `miro-${randomBytes(9).toString("base64url")}`;
}

/** The address the owner's phone will use: a tailnet IP if there is one (reachable from anywhere on
 * the tailnet), else the first non-internal IPv4 (the LAN), else loopback with a warning in the
 * plan. Async - it reads the live network. */
export async function resolveNtfyBaseUrl(port: number): Promise<{ baseUrl: string; reachable: boolean }> {
  const ts = await getTailscaleStatus().catch(() => null);
  if (ts?.connected && ts.ip) return { baseUrl: `http://${ts.ip}:${port}`, reachable: true };
  const lan = getNetworkInterfaces().find((i) => i.family === "IPv4" && !i.internal);
  if (lan) return { baseUrl: `http://${lan.address}:${port}`, reachable: true };
  return { baseUrl: ntfyLocalUrl(port), reachable: false };
}

function dockerRunArgs(p: NtfyInstallParams): string[] {
  return ["run", "-d", "--name", NTFY_CONTAINER, "--restart", "unless-stopped", "-p", `${p.port}:80`, NTFY_IMAGE, "serve", "--base-url", p.baseUrl];
}

async function containerExists(): Promise<boolean> {
  const out = await runPrivileged(["docker", "ps", "-a", "--filter", `name=^/${NTFY_CONTAINER}$`, "--format", "{{.Names}}"], { timeoutMs: 10_000 }).catch(() => "");
  return out.trim() === NTFY_CONTAINER;
}

/** Post a real message to the topic and confirm ntfy accepted it (2xx). Doubles as the owner's
 * first notification ("your phone is set up"), so a successful verify is also the proof they see. */
async function probePublish(port: number, topic: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${ntfyLocalUrl(port)}/${topic}`, {
      method: "POST",
      headers: { Title: "Miro notifications are set up", Priority: "default", Tags: "white_check_mark" },
      body: "This phone will now get Miro's needs_attention alerts.",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    await readTextCapped(res, 100_000);
    return true;
  } catch {
    return false;
  }
}

export const ntfyInstallKind: OperationKind<NtfyInstallParams, { containerExisted: boolean }> = {
  kind: "ntfy.install",

  async describe(p) {
    if (!(await commandExists("docker"))) throw new Error("refused: docker is required to self-host ntfy - install Docker first, or point notify.ntfy.url at a node you already run");
    const replaces = await containerExists();
    return {
      summary: `Self-host ntfy (${NTFY_IMAGE}) on port ${p.port} for phone notifications; subscribe at ${p.baseUrl}/${p.topic}`,
      autoApprove: false,
      class: "mutate",
      writes: ["/var/run/docker.sock"],
      network: true,
      irreversible: replaces || undefined,
      warning: replaces
        ? `a container named ${NTFY_CONTAINER} already exists and will be removed and replaced; pulls the image if absent`
        : "pulls the image if it is not present (minutes on a slow link). Bound on all interfaces so your phone can reach it - the topic is the only thing keeping it private.",
      details: { container: NTFY_CONTAINER, image: NTFY_IMAGE, port: p.port, subscribeUrl: `${p.baseUrl}/${p.topic}`, topic: p.topic, replacesExisting: replaces },
      expects: `${ntfyLocalUrl(p.port)}/${p.topic} accepts a published message`,
      rollbackWhen: replaces
        ? "never - the existing container is replaced, not preserved; a failed verify removes the new one"
        : "the node does not accept a published message within the window - the container is removed",
      scopeEvidence: "the docker socket only; ntfy stores nothing on the host in this configuration",
      dryRunFidelity: "partial",
    };
  },

  async captureState() {
    return { containerExisted: await containerExists() };
  },

  async apply(p) {
    if (await containerExists()) await runPrivileged(["docker", "rm", "-f", NTFY_CONTAINER], { timeoutMs: 60_000 });
    await runPrivileged(["docker", ...dockerRunArgs(p)], { timeoutMs: 15 * 60_000 });
  },

  async verify(p) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await probePublish(p.port, p.topic)) return true;
      await Bun.sleep(3_000);
    }
    return false;
  },

  async rollback() {
    await runPrivileged(["docker", "rm", "-f", NTFY_CONTAINER], { timeoutMs: 60_000 }).catch(() => {});
  },

  // The node keeps accepting messages - a stopped container is drift worth an incident.
  prodtest: () => NTFY_CONTAINER,
};
