import { existsSync } from "node:fs";
import { join } from "node:path";
import { runPrivileged } from "../../inventory/exec";
import { moveToTrash, trashDestination } from "../trash";
import { getStack, setStackStatus, removeStack } from "../../stacks/store";
import { STACKS_ROOT, resolveCompose } from "./stack-deploy";
import type { Database } from "bun:sqlite";
import type { OperationKind } from "../engine";

async function projectRunning(app: string): Promise<number> {
  const out = await runPrivileged(["docker", "ps", "--filter", `label=com.docker.compose.project=${app}`, "--filter", "status=running", "-q"], { timeoutMs: 15_000 }).catch(() => "");
  return out.split("\n").filter((l) => l.trim()).length;
}

// Lifecycle control of an already-managed stack (PLAN.md compose-killer slice 1): stop / start /
// down / remove, through the engine. `remove` moves the compose dir to trash (recoverable) and drops
// the registry row - the file.delete "never a hard delete" discipline applied to a whole stack.

export const STACK_ACTIONS = ["stop", "start", "down", "remove"] as const;
export type StackAction = (typeof STACK_ACTIONS)[number];

export interface StackControlParams {
  app: string;
  action: StackAction;
  reason?: string;
}

export function stackControlKind(db: Database): OperationKind<StackControlParams, { priorStatus: string | null }> {
  const dirFor = (app: string) => join(STACKS_ROOT, app);
  const composeFor = (app: string) => join(dirFor(app), "compose.yaml");
  const compose = async (app: string, ...args: string[]) => {
    const cc = (await resolveCompose()) ?? ["docker", "compose"];
    return runPrivileged([...cc, "-p", app, "-f", composeFor(app), ...args], { timeoutMs: 5 * 60_000 });
  };

  return {
    kind: "stack.control",

    async describe(p) {
      const s = getStack(db, p.app);
      if (!s) throw new Error(`refused: "${p.app}" is not a stack Miro manages (see stack_list)`);
      const verb = { stop: "Stop", start: "Start", down: "Bring down", remove: "Remove (to trash)" }[p.action];
      return {
        summary: `${verb} the "${p.app}" stack`,
        autoApprove: false,
        class: "mutate",
        writes: [dirFor(p.app), "/var/run/docker.sock"],
        network: p.action === "start",
        warning: p.action === "remove" ? "the stack's containers are brought down and its compose dir moves to Miro's trash (recoverable)" : undefined,
        details: { app: p.app, action: p.action },
        expects: p.action === "start" ? "the stack's services are running again" : p.action === "remove" ? "the stack is gone from Miro's registry and its dir is trashed" : "the stack's services are stopped",
        rollbackWhen: "the action does not take effect within the window",
        scopeEvidence: "the stack's own dir + docker's socket",
        dryRunFidelity: "partial",
      };
    },

    async captureState(p) {
      const s = getStack(db, p.app);
      return { priorStatus: s?.status ?? null };
    },

    async apply(p) {
      if (p.action === "stop") {
        await compose(p.app, "stop");
        setStackStatus(db, p.app, "stopped");
      } else if (p.action === "start") {
        await compose(p.app, "start");
        setStackStatus(db, p.app, "running");
      } else if (p.action === "down") {
        await compose(p.app, "down");
        setStackStatus(db, p.app, "stopped");
      } else {
        await compose(p.app, "down").catch(() => {});
        removeStack(db, p.app);
        try {
          moveToTrash(trashDestination(dirFor(p.app)));
        } catch {
          // best effort - the containers are already down
        }
      }
    },

    async verify(p) {
      if (p.action === "remove") return getStack(db, p.app) === null && !existsSync(dirFor(p.app));
      const running = await projectRunning(p.app);
      return p.action === "start" ? running > 0 : running === 0;
    },

    async rollback(p, captured) {
      // Best-effort: undo a stop/start; down/remove are not cleanly reversible (remove's dir is in trash).
      if (p.action === "stop" && captured.priorStatus === "running") await compose(p.app, "start").catch(() => {});
      else if (p.action === "start" && captured.priorStatus === "stopped") await compose(p.app, "stop").catch(() => {});
    },

    prodtest: () => null,
  };
}
