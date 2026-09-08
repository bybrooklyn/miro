import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPrivileged, commandExists } from "../../inventory/exec";
import { moveToTrash, trashDestination } from "../trash";
import { getStack, upsertStack, removeStack } from "../../stacks/store";
import type { Database } from "bun:sqlite";
import type { OperationKind } from "../engine";

// The first-class managed-stack deploy (PLAN.md compose-killer slice 1). Miro OWNS the compose project
// under /var/lib/miro/stacks/<app>/, stands it up through the engine (plan -> confirm -> verify ->
// rollback), and tracks it in the managed_stacks registry - replacing the ad-hoc file.write + shell
// `docker compose up` with something durable, verifiable, and reversible. Compose is agent-generated
// for now (slice 2 makes it self-learning). The classifier does NOT parse compose YAML, so this kind
// scans it for the catastrophic shapes before running (a model-authored compose runs on the real box).

export const STACKS_ROOT = "/var/lib/miro/stacks";
const APP_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/; // a valid compose project + dir name (lowercased)

export interface StackDeployParams {
  app: string;
  /** The full compose YAML. Shown in the plan - "compose visible on demand". */
  compose: string;
  reason?: string;
}

interface Captured {
  existed: boolean;
  priorCompose: string | null;
}

/** The compose CLI on this box, either the v2 plugin (`docker compose`) or the v1 standalone
 * (`docker-compose`, what Debian's docker.io ships) - both accept `-p`/`-f`/up/down/stop/start.
 * Null when neither is present. Resolving both is what lets Miro run "for everyone", not just on
 * Docker-CE boxes. */
export async function resolveCompose(): Promise<string[] | null> {
  if (await runPrivileged(["docker", "compose", "version"], { timeoutMs: 10_000 }).then(() => true).catch(() => false)) return ["docker", "compose"];
  if (await commandExists("docker-compose")) return ["docker-compose"];
  return null;
}

/** Services declared in a compose doc + the catastrophic-shape refusal (privileged/host-mount).
 * The operation is confirmed, so the plan shows the rest for a human. */
export function scanCompose(yamlText: string): { refuse: string | null; binds: string[]; serviceCount: number } {
  let doc: any;
  try {
    doc = Bun.YAML.parse(yamlText);
  } catch (e) {
    return { refuse: `compose is not valid YAML: ${e instanceof Error ? e.message : e}`, binds: [], serviceCount: 0 };
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return { refuse: "compose has no services", binds: [], serviceCount: 0 };
  const names = Object.keys(services);
  const binds: string[] = [];
  const privileged: string[] = [];
  for (const [name, svc] of Object.entries<any>(services)) {
    if (svc?.privileged === true) privileged.push(name);
    const caps: string[] = Array.isArray(svc?.cap_add) ? svc.cap_add.map(String) : [];
    if (caps.some((c) => /^(SYS_ADMIN|ALL)$/i.test(c))) privileged.push(`${name} (cap ${caps.join(",")})`);
    for (const v of Array.isArray(svc?.volumes) ? svc.volumes : []) {
      const src = typeof v === "string" ? v.split(":")[0] : v?.source;
      if (typeof src !== "string" || !src.startsWith("/")) continue; // named volume or relative - fine
      binds.push(src);
      if (src === "/" || /docker\.sock$/.test(src)) return { refuse: `service "${name}" bind-mounts ${src} - refused (full host / docker control)`, binds, serviceCount: names.length };
      if (/^\/(root|proc)(\/|$)/.test(src) || src === "/var/lib/miro" || src.startsWith("/var/lib/miro/")) return { refuse: `service "${name}" bind-mounts ${src} - refused (Miro state / secret material)`, binds, serviceCount: names.length };
    }
  }
  if (privileged.length) return { refuse: `privileged/SYS_ADMIN service(s): ${privileged.join(", ")} - refused; a self-hosted app almost never needs this`, binds, serviceCount: names.length };
  return { refuse: null, binds, serviceCount: names.length };
}

/** Running containers of a compose project, by label - works for v1 AND v2 (both stamp
 * com.docker.compose.project), so verify doesn't depend on the compose CLI's ps output format. */
async function projectRunning(app: string): Promise<number> {
  const out = await runPrivileged(["docker", "ps", "--filter", `label=com.docker.compose.project=${app}`, "--filter", "status=running", "-q"], { timeoutMs: 15_000 }).catch(() => "");
  return out.split("\n").filter((l) => l.trim()).length;
}

export function stackDeployKind(db: Database): OperationKind<StackDeployParams, Captured> {
  const dirFor = (app: string) => join(STACKS_ROOT, app);
  const composeFor = (app: string) => join(dirFor(app), "compose.yaml");

  return {
    kind: "stack.deploy",

    async describe(p) {
      if (!APP_RE.test(p.app)) throw new Error(`refused: "${p.app}" is not a valid app name (lowercase letters, digits, _ - only)`);
      if (!(await commandExists("docker"))) throw new Error("refused: docker is required to run a stack - install Docker first");
      if (!(await resolveCompose())) throw new Error("refused: a docker compose CLI is required (the v2 plugin `docker compose`, or the v1 `docker-compose`)");
      const scan = scanCompose(p.compose);
      if (scan.refuse) throw new Error(`refused: ${scan.refuse}`);
      const existed = getStack(db, p.app) !== null || existsSync(composeFor(p.app));
      return {
        summary: `${existed ? "Redeploy" : "Deploy"} the "${p.app}" stack (${scan.serviceCount} service(s), ${Buffer.byteLength(p.compose)} bytes of compose) under ${dirFor(p.app)}`,
        autoApprove: false,
        class: "mutate",
        writes: [dirFor(p.app), "/var/run/docker.sock"],
        network: true,
        warning: scan.binds.length ? `host paths this stack bind-mounts: ${scan.binds.join(", ")}` : undefined,
        details: { app: p.app, dir: dirFor(p.app), services: scan.serviceCount, binds: scan.binds, compose: p.compose },
        expects: `the "${p.app}" compose project's ${scan.serviceCount} service(s) are running`,
        rollbackWhen: "the services do not come up within the window - the stack is brought down (and removed if newly created)",
        scopeEvidence: "the stack's own dir + docker's socket; the compose was scanned for privileged/host-mount shapes",
        dryRunFidelity: "partial",
      };
    },

    async captureState(p) {
      const cp = composeFor(p.app);
      return { existed: getStack(db, p.app) !== null, priorCompose: existsSync(cp) ? readFileSync(cp, "utf8") : null };
    },

    async apply(p) {
      const cc = (await resolveCompose())!;
      const dir = dirFor(p.app);
      mkdirSync(dir, { recursive: true });
      writeFileSync(composeFor(p.app), p.compose);
      await runPrivileged([...cc, "-p", p.app, "-f", composeFor(p.app), "up", "-d"], { timeoutMs: 15 * 60_000 });
      upsertStack(db, { app: p.app, dir, composePath: composeFor(p.app), status: "running" });
    },

    async verify(p) {
      const want = scanCompose(readFileSync(composeFor(p.app), "utf8").toString()).serviceCount || 1;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if ((await projectRunning(p.app)) >= want) return true;
        await Bun.sleep(3_000);
      }
      console.warn(`[mirod] stack.deploy verify failed for ${p.app}: fewer than ${want} service(s) running`);
      return false;
    },

    async rollback(p, captured) {
      const cc = await resolveCompose();
      if (cc) await runPrivileged([...cc, "-p", p.app, "-f", composeFor(p.app), "down"], { timeoutMs: 5 * 60_000 }).catch(() => {});
      if (!captured.existed) {
        removeStack(db, p.app);
        try {
          moveToTrash(trashDestination(dirFor(p.app)));
        } catch {
          // best effort
        }
      } else if (captured.priorCompose !== null) {
        // A failed REDEPLOY (an edit): restore the previous compose AND bring it back up, so a bad
        // edit leaves the stack running what it ran before - not merely the old file on disk.
        try {
          writeFileSync(composeFor(p.app), captured.priorCompose);
          if (cc) await runPrivileged([...cc, "-p", p.app, "-f", composeFor(p.app), "up", "-d"], { timeoutMs: 10 * 60_000 });
        } catch {
          // best effort
        }
      }
    },

    prodtest: (p) => `stack:${p.app}`,
  };
}
