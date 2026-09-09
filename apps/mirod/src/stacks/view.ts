import type { Database } from "bun:sqlite";
import type { StackSummary } from "@miro/protocol";
import { listStacks } from "./store";
import { resolveCompose } from "../operations/kinds/stack-deploy";
import { runPrivileged } from "../inventory/exec";

// The read side of the managed-stack view (PLAN.md deploy-anywhere PR 3b): the registry's record plus
// what is actually running, and a log tail. Read-only by construction - every mutation still goes
// through the operation engine, so nothing here needs a confirmation or a rollback.

/** Containers up for a compose project, by the label compose stamps on them - version-agnostic, so it
 * works with both the v2 plugin and the v1 script (PLAN.md §5.45). The project name is the app name,
 * exactly as the deploy/control/update kinds use it (`-p <app>`) - found live: an invented `miro-` prefix
 * here reported a healthy stack as nothing-running. */
async function runningContainers(app: string): Promise<{ count: number; images: string[] }> {
  try {
    const out = await runPrivileged(["docker", "ps", "--filter", `label=com.docker.compose.project=${app}`, "--format", "{{.Image}}"]);
    const images = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return { count: images.length, images: [...new Set(images)] };
  } catch {
    // Docker unreachable: report nothing running rather than failing the whole view.
    return { count: 0, images: [] };
  }
}

/** How many services the stack's compose declares - the denominator that makes "2 of 3 up" sayable. */
async function declaredServices(composePath: string): Promise<number> {
  try {
    const text = await Bun.file(composePath).text();
    // Deliberately the same shallow shape scanCompose uses: top-level keys under `services:`. A real
    // YAML parser is not worth a dependency for a count that only feeds a status line.
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^services:\s*$/.test(l));
    if (start < 0) return 0;
    let count = 0;
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // dedented out of `services:`
      if (/^\s{2}\S[^:]*:\s*$/.test(line)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function stackSummaries(db: Database): Promise<{ stacks: StackSummary[]; unavailable?: string }> {
  const registered = listStacks(db);
  if (registered.length === 0) return { stacks: [] };
  if (!(await resolveCompose())) {
    // The registry still knows what it owns; say why the live numbers are missing rather than showing
    // everything as stopped.
    return {
      stacks: registered.map((s) => ({ app: s.app, status: s.status, dir: s.dir, running: 0, declared: 0, images: [], updatedAt: s.updatedAt })),
      unavailable: "no docker compose CLI on this box - showing the registry only",
    };
  }
  const stacks: StackSummary[] = [];
  for (const s of registered) {
    const [live, declared] = await Promise.all([runningContainers(s.app), declaredServices(s.composePath)]);
    stacks.push({ app: s.app, status: s.status, dir: s.dir, running: live.count, declared, images: live.images, updatedAt: s.updatedAt });
  }
  return { stacks };
}

export const MAX_LOG_LINES = 500;

/** Strip ANSI escapes. `--no-color` stops compose colouring its own prefixes but not the cursor-control
 * sequences it still emits (an erase-line before each line), which a terminal swallows and a browser
 * renders as garbage - found live, reading real logs in the web UI. */
export function stripAnsi(line: string): string {
  return line.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "");
}

/** The tail of one stack's logs. Refuses an unknown app rather than shelling out with whatever it was
 * handed: `app` arrives from a client, and this is the one place here that touches a path. */
export async function stackLogs(db: Database, app: string, lines = 200): Promise<{ lines: string[]; error?: string }> {
  const stack = listStacks(db).find((s) => s.app === app);
  if (!stack) return { lines: [], error: `${app} is not a stack Miro manages` };
  const cc = await resolveCompose();
  if (!cc) return { lines: [], error: "no docker compose CLI on this box" };
  const tail = String(Math.max(1, Math.min(Math.trunc(lines) || 200, MAX_LOG_LINES)));
  try {
    const out = await runPrivileged([...cc, "-p", app, "-f", stack.composePath, "logs", "--no-color", "--tail", tail]);
    return { lines: out.split("\n").map(stripAnsi).filter((l) => l.trim().length > 0).slice(-MAX_LOG_LINES) };
  } catch (err) {
    return { lines: [], error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  }
}
