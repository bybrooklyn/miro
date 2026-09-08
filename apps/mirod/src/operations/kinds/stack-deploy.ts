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

/** Parse the compose and refuse the unambiguously dangerous shapes; collect binds/caps for the plan
 * (the operation is confirmed, so a human sees the rest). ponytail: catastrophic-only scan + human
 * confirm; tighten to a full policy if model-generated composes ever slip something subtle past. */
export function scanCompose(yamlText: string): { refuse: string | null; binds: string[]; privileged: string[] } {
  let doc: any;
  try {
    doc = Bun.YAML.parse(yamlText);
  } catch (e) {
    return { refuse: `compose is not valid YAML: ${e instanceof Error ? e.message : e}`, binds: [], privileged: [] };
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return { refuse: "compose has no services", binds: [], privileged: [] };
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
      if (src === "/" || /docker\.sock$/.test(src)) return { refuse: `service "${name}" bind-mounts ${src} - refused (full host / docker control)`, binds, privileged };
      if (/^\/(root|proc)(\/|$)/.test(src) || src === "/var/lib/miro" || src.startsWith("/var/lib/miro/")) return { refuse: `service "${name}" bind-mounts ${src} - refused (Miro state / secret material)`, binds, privileged };
    }
  }
  if (privileged.length) return { refuse: `privileged/SYS_ADMIN service(s): ${privileged.join(", ")} - refused; a self-hosted app almost never needs this`, binds, privileged };
  return { refuse: null, binds, privileged };
}

async function composePs(app: string, composePath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await runPrivileged(["docker", "compose", "-p", app, "-f", composePath, "ps", "--format", "json"], { timeoutMs: 15_000 });
    const rows = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { Service?: string; State?: string });
    if (rows.length === 0) return { ok: false, detail: "no services running" };
    const bad = rows.filter((r) => !/^(running|healthy)$/i.test(r.State ?? ""));
    return bad.length === 0 ? { ok: true, detail: `${rows.length} service(s) running` } : { ok: false, detail: `not healthy: ${bad.map((b) => `${b.Service}=${b.State}`).join(", ")}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "compose ps failed" };
  }
}

export function stackDeployKind(db: Database): OperationKind<StackDeployParams, Captured> {
  const dirFor = (app: string) => join(STACKS_ROOT, app);
  const composeFor = (app: string) => join(dirFor(app), "compose.yaml");

  return {
    kind: "stack.deploy",

    async describe(p) {
      if (!APP_RE.test(p.app)) throw new Error(`refused: "${p.app}" is not a valid app name (lowercase letters, digits, _ - only)`);
      if (!(await commandExists("docker"))) throw new Error("refused: docker is required to run a stack - install Docker first");
      const scan = scanCompose(p.compose);
      if (scan.refuse) throw new Error(`refused: ${scan.refuse}`);
      const existed = getStack(db, p.app) !== null || existsSync(composeFor(p.app));
      return {
        summary: `${existed ? "Redeploy" : "Deploy"} the "${p.app}" stack (${Buffer.byteLength(p.compose)} bytes of compose) under ${dirFor(p.app)}`,
        autoApprove: false,
        class: "mutate",
        writes: [dirFor(p.app), "/var/run/docker.sock"],
        network: true,
        warning: scan.binds.length ? `host paths this stack bind-mounts: ${scan.binds.join(", ")}` : undefined,
        details: { app: p.app, dir: dirFor(p.app), binds: scan.binds, compose: p.compose },
        expects: `the "${p.app}" compose project's services are up and healthy`,
        rollbackWhen: "the services do not come up healthy within the window - the stack is brought down (and removed if newly created)",
        scopeEvidence: "the stack's own dir + docker's socket; the compose was scanned for privileged/host-mount shapes",
        dryRunFidelity: "partial",
      };
    },

    async captureState(p) {
      const cp = composeFor(p.app);
      return { existed: getStack(db, p.app) !== null, priorCompose: existsSync(cp) ? readFileSync(cp, "utf8") : null };
    },

    async apply(p) {
      const dir = dirFor(p.app);
      mkdirSync(dir, { recursive: true });
      writeFileSync(composeFor(p.app), p.compose);
      await runPrivileged(["docker", "compose", "-p", p.app, "-f", composeFor(p.app), "up", "-d"], { timeoutMs: 15 * 60_000 });
      upsertStack(db, { app: p.app, dir, composePath: composeFor(p.app), status: "running" });
    },

    async verify(p) {
      const deadline = Date.now() + 60_000;
      let last = "";
      while (Date.now() < deadline) {
        const r = await composePs(p.app, composeFor(p.app));
        if (r.ok) return true;
        last = r.detail;
        await Bun.sleep(3_000);
      }
      console.warn(`[mirod] stack.deploy verify failed for ${p.app}: ${last}`);
      return false;
    },

    async rollback(p, captured) {
      await runPrivileged(["docker", "compose", "-p", p.app, "-f", composeFor(p.app), "down"], { timeoutMs: 5 * 60_000 }).catch(() => {});
      if (!captured.existed) {
        // A stack this operation created: remove it entirely (dir to trash, recoverable).
        removeStack(db, p.app);
        try {
          moveToTrash(trashDestination(dirFor(p.app)));
        } catch {
          // best effort
        }
      } else if (captured.priorCompose !== null) {
        // A redeploy that failed: restore the prior compose on disk (the owner can re-up it).
        try {
          writeFileSync(composeFor(p.app), captured.priorCompose);
        } catch {
          // best effort
        }
      }
    },

    // Keep confirming the stack stays up (drift -> an incident the agent sees).
    prodtest: (p) => `stack:${p.app}`,
  };
}
