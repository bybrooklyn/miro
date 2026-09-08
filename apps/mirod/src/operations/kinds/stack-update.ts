import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPrivileged } from "../../inventory/exec";
import { getStack } from "../../stacks/store";
import { STACKS_ROOT, resolveCompose, scanCompose } from "./stack-deploy";
import type { Database } from "bun:sqlite";
import type { OperationKind } from "../engine";

// Update a managed stack (PLAN.md compose-killer slice 3): pull newer images and recreate, with an
// EXACT rollback. The prior image digests are captured before the pull, so a bad update is reverted by
// re-tagging those exact images back and recreating - not by hoping the old tag still points where it
// did. This is the ongoing chore the compose grind is made of, and the one people fear most.

export interface StackUpdateParams {
  app: string;
  reason?: string;
}

interface Captured {
  /** Per running container: the tag its compose asked for, and the image ID actually running. */
  images: { tag: string; id: string }[];
}

async function currentImages(app: string): Promise<{ tag: string; id: string }[]> {
  const ids = (await runPrivileged(["docker", "ps", "--filter", `label=com.docker.compose.project=${app}`, "-q"], { timeoutMs: 15_000 }).catch(() => ""))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: { tag: string; id: string }[] = [];
  for (const cid of ids) {
    const line = await runPrivileged(["docker", "inspect", "--format", "{{.Config.Image}} {{.Image}}", cid], { timeoutMs: 15_000 }).catch(() => "");
    const [tag, id] = line.trim().split(/\s+/);
    if (tag && id) out.push({ tag, id });
  }
  return out;
}

async function projectRunning(app: string): Promise<number> {
  const out = await runPrivileged(["docker", "ps", "--filter", `label=com.docker.compose.project=${app}`, "--filter", "status=running", "-q"], { timeoutMs: 15_000 }).catch(() => "");
  return out.split("\n").filter((l) => l.trim()).length;
}

export function stackUpdateKind(db: Database): OperationKind<StackUpdateParams, Captured> {
  const dirFor = (app: string) => join(STACKS_ROOT, app);
  const composeFor = (app: string) => join(dirFor(app), "compose.yaml");
  const compose = async (app: string, ...args: string[]) => {
    const cc = (await resolveCompose()) ?? ["docker", "compose"];
    return runPrivileged([...cc, "-p", app, "-f", composeFor(app), ...args], { timeoutMs: 15 * 60_000 });
  };
  const wantServices = (app: string) => scanCompose(readFileSync(composeFor(app), "utf8")).serviceCount || 1;

  return {
    kind: "stack.update",

    async describe(p) {
      const s = getStack(db, p.app);
      if (!s) throw new Error(`refused: "${p.app}" is not a stack Miro manages (see stack_list)`);
      if (!existsSync(composeFor(p.app))) throw new Error(`refused: ${composeFor(p.app)} is missing - redeploy the stack first`);
      if (!(await resolveCompose())) throw new Error("refused: a docker compose CLI is required (the v2 plugin `docker compose`, or the v1 `docker-compose`)");
      const running = await currentImages(p.app);
      return {
        summary: `Update the "${p.app}" stack: pull newer images and recreate (${running.length} container(s) running)`,
        autoApprove: false,
        class: "mutate",
        writes: [dirFor(p.app), "/var/run/docker.sock"],
        network: true,
        warning: "the stack restarts; if it does not come back healthy the exact previous images are re-tagged and restored",
        details: { app: p.app, currentImages: running.map((r) => `${r.tag}@${r.id.slice(0, 19)}`) },
        expects: `the "${p.app}" services are running again after the pull + recreate`,
        rollbackWhen: "the services do not come back - the captured image IDs are re-tagged and the stack recreated from them",
        scopeEvidence: "the stack's own dir + docker's socket",
        dryRunFidelity: "partial",
      };
    },

    async captureState(p) {
      return { images: await currentImages(p.app) };
    },

    async apply(p) {
      await compose(p.app, "pull");
      await compose(p.app, "up", "-d");
    },

    async verify(p) {
      const want = wantServices(p.app);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if ((await projectRunning(p.app)) >= want) return true;
        await Bun.sleep(3_000);
      }
      return false;
    },

    async rollback(p, captured) {
      // Exact revert: point each tag back at the image ID that was running, then recreate from it.
      for (const { tag, id } of captured.images) {
        await runPrivileged(["docker", "tag", id, tag], { timeoutMs: 60_000 }).catch(() => {});
      }
      await compose(p.app, "up", "-d", "--force-recreate").catch(() => {});
    },

    prodtest: (p) => `stack:${p.app}`,
  };
}
