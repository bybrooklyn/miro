import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MIRO_DIR } from "@miro/protocol";
import { commandExists, runPrivileged } from "../../inventory/exec";
import { readTextCapped } from "../../fetch-body";
import type { OperationKind } from "../engine";
import { moveToTrash, trashDestination } from "../trash";

// A self-hosted SearXNG for web.search (PLAN.md §5.14 slice 2), as a confirmed docker operation:
// the public pool is a last resort (two JSON-capable nodes on the whole of searx.space, §5.25), an
// Ollama key needs an account, and a local node under Miro's control is what makes web_search
// reliable. Runs `docker` in the daemon's own namespace like the systemd kinds do - the sandbox's
// PID namespace is not the issue here, the docker socket is simply declared. Binds 127.0.0.1 only;
// JSON output is enabled in the settings this writes (SearXNG disables it by default, which is the
// whole reason the public pool is empty).

export const SEARXNG_CONTAINER = "miro-searxng";
export const SEARXNG_IMAGE = "searxng/searxng:latest";
export const DEFAULT_SEARXNG_PORT = 8888;
export const SEARXNG_SETTING = "searxng.base_url";

export interface SearxngInstallParams {
  port?: number;
  /** Where settings.yml lives (mounted at /etc/searxng). Default: <MIRO_DIR>/searxng. */
  dataDir?: string;
}

interface Captured {
  containerExisted: boolean;
  dirExisted: boolean;
}

export function searxngBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The minimal settings.yml: defaults for everything, JSON output on, the bot limiter off (every
 * request comes from this daemon on loopback), a fresh secret key. */
export function settingsYaml(secretKey = randomBytes(24).toString("hex")): string {
  return ["use_default_settings: true", "server:", `  secret_key: "${secretKey}"`, "  limiter: false", '  bind_address: "0.0.0.0"', "search:", "  formats:", "    - html", "    - json", ""].join("\n");
}

export function dockerRunArgs(port: number, dataDir: string): string[] {
  return ["run", "-d", "--name", SEARXNG_CONTAINER, "--restart", "unless-stopped", "-p", `127.0.0.1:${port}:8080`, "-v", `${dataDir}:/etc/searxng`, SEARXNG_IMAGE];
}

function resolved(p: SearxngInstallParams): { port: number; dataDir: string } {
  const port = p.port ?? DEFAULT_SEARXNG_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`refused: port ${p.port} is not a usable unprivileged port`);
  return { port, dataDir: p.dataDir ?? join(MIRO_DIR, "searxng") };
}

async function containerExists(): Promise<boolean> {
  const out = await runPrivileged(["docker", "ps", "-a", "--filter", `name=^/${SEARXNG_CONTAINER}$`, "--format", "{{.Names}}"], { timeoutMs: 10_000 }).catch(() => "");
  return out.trim() === SEARXNG_CONTAINER;
}

/** The node answers JSON with a results array - engines may still be warming up, so any array
 * counts; what is being verified is JSON output and reachability, not search quality. */
export async function probeJson(baseUrl: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/search?q=debian&format=json`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = JSON.parse(await readTextCapped(res, 1_000_000)) as { results?: unknown };
    return Array.isArray(body.results);
  } catch {
    return false;
  }
}

export const searxngInstallKind: OperationKind<SearxngInstallParams, Captured> = {
  kind: "searxng.install",

  async describe(p) {
    if (!(await commandExists("docker"))) throw new Error("refused: docker is required for a self-hosted SearXNG - install Docker first, or point searxng.base_url at a node you already run");
    const { port, dataDir } = resolved(p);
    // A container of that name already there is REPLACED by apply (rm -f) and rollback removes
    // the replacement, never restores the original - so the plan says so and the engine treats
    // it as irreversible (audit A18: it used to promise a rollback it could not give).
    const replaces = await containerExists();
    return {
      summary: `Run a self-hosted SearXNG (${SEARXNG_IMAGE}) on 127.0.0.1:${port} for web_search, JSON output on`,
      autoApprove: false,
      class: "mutate",
      writes: [dataDir, "/var/run/docker.sock"],
      network: true,
      irreversible: replaces || undefined,
      warning: replaces
        ? `a container named ${SEARXNG_CONTAINER} already exists and will be removed and replaced - its own configuration is not restored on rollback; pulls the image if it is not present`
        : "pulls the image if it is not present (minutes on a slow link)",
      details: { container: SEARXNG_CONTAINER, image: SEARXNG_IMAGE, port, dataDir, baseUrl: searxngBaseUrl(port), replacesExisting: replaces },
      expects: `${searxngBaseUrl(port)}/search?format=json answers with a results array`,
      rollbackWhen: replaces
        ? "never - the existing container is replaced, not preserved; a failed verify removes the new one"
        : "no JSON answer within 90s - the container is removed and a data directory this operation created is moved to the trash",
      scopeEvidence: "the SearXNG data directory (settings.yml) and the docker socket; the container listens on loopback only",
      dryRunFidelity: "partial",
    };
  },

  async captureState(p) {
    const { dataDir } = resolved(p);
    return { containerExisted: await containerExists(), dirExisted: existsSync(dataDir) };
  },

  async apply(p) {
    const { port, dataDir } = resolved(p);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "settings.yml"), settingsYaml());
    if (await containerExists()) await runPrivileged(["docker", "rm", "-f", SEARXNG_CONTAINER], { timeoutMs: 60_000 });
    await runPrivileged(["docker", ...dockerRunArgs(port, dataDir)], { timeoutMs: 15 * 60_000 });
  },

  async verify(p) {
    const { port } = resolved(p);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await probeJson(searxngBaseUrl(port))) return true;
      await Bun.sleep(3_000);
    }
    return false;
  },

  async rollback(p, captured) {
    const { dataDir } = resolved(p);
    await runPrivileged(["docker", "rm", "-f", SEARXNG_CONTAINER], { timeoutMs: 60_000 }).catch(() => {});
    if (!captured.dirExisted && existsSync(dataDir)) moveToTrash(trashDestination(dataDir));
  },

  // Prodtest: the node keeps answering JSON - a stopped container is drift worth an incident.
  prodtest: () => SEARXNG_CONTAINER,
};
