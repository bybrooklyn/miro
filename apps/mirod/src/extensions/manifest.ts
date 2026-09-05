import type { HostToolSpec } from "./host-protocol";

export interface ExtensionSecretDecl {
  ref: string; // "extension.<app>.<name>"
  description: string;
}

export interface ExtensionManifest {
  app: string;
  displayName: string;
  baseUrl: string;
  secrets: ExtensionSecretDecl[];
  // Mechanically derived from the live host's list_tools RPC, never hand-typed by the model -
  // the direct lesson from Stage C slice 1's live-found Type.Union-of-Literal schema bug: one
  // source of truth, derived once, never hand-duplicated.
  tools: HostToolSpec[];
  diagnostics: HostToolSpec[];
  /** Declarative write bindings (PLAN.md §5.5 decision 2) - run by the daemon's engine. Absent
   * on extensions promoted before operations existed; readers treat it as []. */
  operations?: HostToolSpec[];
  /** Capabilities this extension implements (PLAN.md §5.14 slice 3) - validated at learn time,
   * registered with the capability router when the extension is enabled. */
  implements?: { capability: string; entry: string }[];
  version: number;
  generatedAt: number;
}

export function buildManifest(
  app: string,
  displayName: string,
  baseUrl: string,
  secretNames: { name: string; description: string }[],
  toolSpecs: HostToolSpec[],
  version: number,
  implementsDecls: { capability: string; entry: string }[] = [],
): ExtensionManifest {
  return {
    app,
    displayName,
    baseUrl,
    secrets: secretNames.map((s) => ({ ref: `extension.${app}.${s.name}`, description: s.description })),
    tools: toolSpecs.filter((t) => t.kind === "tool"),
    diagnostics: toolSpecs.filter((t) => t.kind === "diagnostic"),
    operations: toolSpecs.filter((t) => t.kind === "operation"),
    ...(implementsDecls.length > 0 ? { implements: implementsDecls } : {}),
    version,
    generatedAt: Date.now(),
  };
}
