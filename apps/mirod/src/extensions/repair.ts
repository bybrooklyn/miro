import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry } from "../agent/models";
import type { ServerEvent } from "@miro/protocol";
import type { ExtensionHostManager } from "./host";
import type { CodegenSelection } from "./learn";
import type { ExtensionManifest } from "./manifest";
import { spawnLearningAgent } from "./learn-agent";
import { extensionDir } from "./paths";
import { assertPinned, PinMismatchError } from "./pin";
import * as store from "./store";

// Dreaming's repair half (plan §36, §8 of PLAN.md's self-extension design) - the OTHER real event
// trigger from §36's list ("extension error", "useful idle period"), alongside the reflection pass
// Stage C slice 1 already built for Memory. Reuses the learning agent / extension_write / the full
// validation pipeline wholesale (see extensions/learn-agent.ts) - a repair is just a
// differently-worded goal, never a parallel implementation.

export const REPAIR_THRESHOLD = 2;
export const MAX_REPAIR_ATTEMPTS = 3;

export interface RepairTrigger {
  app: string;
  tool: string;
  error: string;
}

/** Called on every real extension tool-call failure (agent/extension-tools.ts) and on every
 * periodic re-probe failure (reprobeExtensions below) - one counter (consecutive_failures), two
 * ways to trip it, per plan §36. Resolves true when a repair ran and re-promoted the extension -
 * agent/extension-tools.ts awaits that to retry the failing call inline (PLAN.md §5.4 D). */
export async function maybeTriggerRepair(
  trigger: RepairTrigger,
  db: Database,
  hostMgr: ExtensionHostManager,
  setSecret: (ref: string, value: string) => void,
  getSecret: (ref: string) => string | null,
  models: ModelRegistry,
  resolveCodegenModel: () => Promise<CodegenSelection | null>,
  getStoredKey: (provider: string) => string | null,
  send: (event: ServerEvent) => void,
): Promise<boolean> {
  const failures = store.recordFailure(db, trigger.app, trigger.error);
  if (failures < REPAIR_THRESHOLD) return false;

  const ext = store.getExtension(db, trigger.app);
  if (!ext || ext.state !== "enabled") return false; // already disabled (or never existed) - nothing to repair

  // Tampered code is never repaired into trust: the validator never saw what is on disk now.
  const dir = extensionDir(trigger.app);
  try {
    assertPinned(db, trigger.app, dir);
  } catch (err) {
    if (!(err instanceof PinMismatchError)) throw err;
    send({ type: "notice", level: "warn", text: err.message });
    return false;
  }

  // Circuit breaker, checked BEFORE attempting - never lets a 4th attempt start.
  if (ext.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
    store.disable(db, trigger.app, `Exceeded max repair attempts (${MAX_REPAIR_ATTEMPTS}): ${trigger.error}`);
    send({ type: "notice", level: "warn", text: `Gave up repairing ${trigger.app} after ${MAX_REPAIR_ATTEMPTS} attempts - disabled.` });
    return false;
  }

  const selection = await resolveCodegenModel();
  if (!selection) return false; // no model available - leave enabled but broken; the next failure retries this same check

  const attempts = store.incrementRepairAttempts(db, trigger.app);
  send({ type: "notice", level: "warn", text: `${trigger.app}'s ${trigger.tool} tool is failing - attempting a repair...` });

  const goal = `Extension "${trigger.app}"'s "${trigger.tool}" is failing: ${trigger.error}. Diagnose against the app as
it runs right now (container_inspect, shell_inspect, http_get, net_capture if needed), re-research if its API or
interface changed, then call extension_write with a corrected extension.ts. Keep entry names and behaviour the
same wherever the app still supports them.`;

  // The repair agent cannot read its own live extension.ts (the extensions directory is refused to
  // every read tool as Miro's own state), so the current code is handed to it as the draft to start
  // from, with the runtime failure in the same structured shape a validation failure has.
  const livePath = join(dir, "extension.ts");
  const seed = existsSync(livePath)
    ? { draft: readFileSync(livePath, "utf8"), failures: [{ rule: "probe" as const, entry: trigger.tool, message: trigger.error }] }
    : undefined;

  const result = await spawnLearningAgent({
    goal,
    app: trigger.app,
    depth: 0,
    db,
    hostMgr,
    setSecret,
    getSecret,
    models,
    model: selection.model,
    reasoning: selection.reasoning,
    getStoredKey,
    send,
    resolveCodegenModel,
    seed,
    // Autonomous: no user to ask, no operations - a repair regenerates code, it does not reconfigure the app.
  });

  // promote() (called inside extension_write on success) already resets both counters - nothing
  // to do here on success. On failure, only disable once the circuit breaker's own threshold hits;
  // a failed attempt short of MAX_REPAIR_ATTEMPTS just leaves the extension enabled, still broken,
  // waiting for the next real failure or re-probe to try again.
  if (!result.promoted && attempts >= MAX_REPAIR_ATTEMPTS) {
    store.disable(db, trigger.app, `Repair failed after ${MAX_REPAIR_ATTEMPTS} attempts: ${trigger.error}`);
    send({ type: "notice", level: "warn", text: `Gave up repairing ${trigger.app} after ${MAX_REPAIR_ATTEMPTS} attempts - disabled.` });
  }
  return result.promoted;
}

/** The "useful idle period" trigger from plan §36 - a coarse, fixed-interval health check of
 * every enabled extension's diagnostics (no-arg ones only, same scope limit as the live-probe
 * validation check), feeding failures into the same maybeTriggerRepair path a real call failure
 * would. Intended to be run from a long-period setInterval in index.ts. */
export async function reprobeExtensions(
  db: Database,
  hostMgr: ExtensionHostManager,
  setSecret: (ref: string, value: string) => void,
  getSecret: (ref: string) => string | null,
  models: ModelRegistry,
  resolveCodegenModel: () => Promise<CodegenSelection | null>,
  getStoredKey: (provider: string) => string | null,
  send: (event: ServerEvent) => void,
  requiresArguments: (parameters: unknown) => boolean,
): Promise<void> {
  for (const row of store.listEnabled(db)) {
    // One extension's corrupt manifest or vanished directory must not end the sweep for every
    // other extension (audit B4): reported, skipped, next.
    let manifest: ExtensionManifest;
    let dir: string;
    try {
      manifest = JSON.parse(row.manifest);
      dir = extensionDir(manifest.app);
      assertPinned(db, manifest.app, dir);
    } catch (err) {
      const text = err instanceof PinMismatchError ? err.message : `extension "${row.app}" skipped by the health sweep: ${String(err instanceof Error ? err.message : err)}`;
      send({ type: "notice", level: "warn", text });
      continue; // disabled by the check, or unreadable; nothing to probe
    }
    const secrets: Record<string, string> = {};
    for (const decl of manifest.secrets) {
      const value = getSecret(decl.ref);
      if (value) secrets[decl.ref.split(".").pop()!] = value;
    }
    for (const diag of manifest.diagnostics) {
      if (requiresArguments(diag.parameters)) continue;
      try {
        await hostMgr.call(dir, manifest.app, manifest.baseUrl, secrets, diag.name, {});
        store.recordProbeSuccess(db, manifest.app);
      } catch (err) {
        await maybeTriggerRepair(
          { app: manifest.app, tool: diag.name, error: String(err instanceof Error ? err.message : err) },
          db,
          hostMgr,
          setSecret,
          getSecret,
          models,
          resolveCodegenModel,
          getStoredKey,
          send,
        );
      }
    }
  }
}
