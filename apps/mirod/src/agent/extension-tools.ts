import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "bun:sqlite";
import * as store from "../extensions/store";
import type { ExtensionManifest } from "../extensions/manifest";
import type { ExtensionHostManager } from "../extensions/host";
import type { RepairTrigger } from "../extensions/repair";
import { extensionDir } from "../extensions/paths";
import { runOperation, type OperationToolContext, type OperationKind } from "../operations/engine";
import { allOperationKinds } from "./operation-tools";

function textResult(details: unknown): AgentToolResult<unknown> {
  // details ?? null: JSON.stringify(undefined) returns the value undefined (not a string),
  // producing a malformed {text: undefined} block that crashes downstream message processing —
  // found live when a void-returning tool (extensions/learn-agent.ts's browser.open) hit this
  // exact bug. null is a real JSON literal; undefined coerced through here is not.
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

// Exported for extensions/repair.ts's periodic re-probe, which needs the same secret resolution
// this real-call path uses.
export function resolveSecrets(manifest: ExtensionManifest, getSecret: (ref: string) => string | null): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const decl of manifest.secrets) {
    const value = getSecret(decl.ref);
    if (value) secrets[decl.ref.split(".").pop()!] = value;
  }
  return secrets;
}

// OpenAI's Responses API rejects tool names outside ^[a-zA-Z0-9_-]+$ (found live testing Codex —
// Ollama's more lenient endpoint never caught it). manifest.app/spec.name come from generated
// extension code, not this repo's own literals, so this is a real defensive boundary, not just a
// style choice: sanitize even though the learn-agent system prompt also asks for clean names.
export function sanitizeNamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const BINDING_KIND_TO_ENGINE: Record<string, string> = {
  http_mutation: "http.mutation",
  shell_command: "shell.command",
  file_write: "file.write",
};

/** Builds the agent tools for one enabled extension: its read tools/diagnostics (executed in the
 * extension host) and its operation bindings (bound in the host, run by the daemon's engine with
 * full confirm/sandbox/verify/rollback semantics — the extension never performs a write itself).
 * Exported so a freshly promoted extension can be hot-loaded into a running agent (PLAN.md §5.4 D). */
export function buildToolsForExtension(
  row: store.ExtensionRecord,
  db: Database,
  hostMgr: ExtensionHostManager,
  getSecret: (ref: string) => string | null,
  repair: (trigger: RepairTrigger) => Promise<boolean> | void,
  operationCtx?: OperationToolContext,
) {
  const manifest: ExtensionManifest = JSON.parse(row.manifest);
  const dir = extensionDir(manifest.app);
  const prefix = `ext_${sanitizeNamePart(manifest.app)}_`;
  const kinds: Record<string, OperationKind<any, any>> = allOperationKinds(getSecret);

  const readTools = [...manifest.tools, ...manifest.diagnostics].map((spec) => ({
    name: `${prefix}${sanitizeNamePart(spec.name)}`,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as any,
    execute: async (_id: string, args: unknown) => {
      const secrets = resolveSecrets(manifest, getSecret);
      try {
        const value = await hostMgr.call(dir, manifest.app, manifest.baseUrl, secrets, spec.name, args);
        store.recordSuccess(db, manifest.app);
        return textResult(value);
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        // Inline repair (PLAN.md §5.4 D): if the repair loop fixes and re-promotes the extension
        // while we wait, retry the same call once against the new code before surfacing anything.
        const repaired = await repair({ app: manifest.app, tool: spec.name, error: message });
        if (repaired === true) {
          hostMgr.invalidate(dir);
          const value = await hostMgr.call(dir, manifest.app, manifest.baseUrl, resolveSecrets(manifest, getSecret), spec.name, args);
          store.recordSuccess(db, manifest.app);
          return textResult({ repaired: true, value });
        }
        throw err;
      }
    },
  }));

  const operationTools = (manifest.operations ?? []).map((spec) => ({
    name: `${prefix}${sanitizeNamePart(spec.name)}`,
    label: spec.label,
    description: `${spec.description} (a tracked operation: shown to you, confirmed, sandboxed, verified, rolled back on failure)`,
    parameters: spec.parameters as any,
    execute: async (_id: string, args: unknown) => {
      if (!operationCtx) return textResult({ error: "operations are not available in this context" });
      const secrets = resolveSecrets(manifest, getSecret);
      const bound = (await hostMgr.bind(dir, manifest.app, manifest.baseUrl, secrets, spec.name, args)) as { kind?: string; goal?: string } & Record<string, unknown>;
      const { kind: bindingKind, goal, ...params } = bound;
      const engineKind = bindingKind ? kinds[BINDING_KIND_TO_ENGINE[bindingKind] ?? ""] : undefined;
      if (!engineKind) return textResult({ error: `unknown binding kind ${String(bindingKind)}` });
      try {
        const result = await runOperation(operationCtx, engineKind, goal ?? spec.description, params);
        if (result.outcome === "committed") store.recordSuccess(db, manifest.app);
        return textResult(result);
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        void repair({ app: manifest.app, tool: spec.name, error: message });
        throw err;
      }
    },
  }));

  return [...readTools, ...operationTools];
}

/** Wires every enabled extension into the live agent, namespaced ext_<app>_<name> to avoid
 * collisions with builtins or other extensions. Reads the enabled-extension list fresh on every
 * call (agent/index.ts's createMiroAgent). Between rebuilds, app_learn hot-loads a newly promoted
 * extension's tools into the running agent via buildToolsForExtension (PLAN.md §5.4 D).
 *
 * `repair` (plan §36, Dreaming) is awaited on a real call failure: when it reports the extension
 * was repaired and re-promoted, the failing call is retried once against the new code; otherwise
 * the original error propagates to the model/user this turn. Success resets the failure streak. */
export function buildExtensionTools(
  db: Database,
  hostMgr: ExtensionHostManager,
  getSecret: (ref: string) => string | null,
  repair: (trigger: RepairTrigger) => Promise<boolean> | void,
  operationCtx?: OperationToolContext,
) {
  return store.listEnabled(db).flatMap((row) => buildToolsForExtension(row, db, hostMgr, getSecret, repair, operationCtx));
}
