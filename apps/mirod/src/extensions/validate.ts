import * as ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionHostManager } from "./host";
import type { HostToolSpec } from "./host-protocol";
import { httpMutationKind } from "../operations/kinds/http-mutation";
import { shellCommandKind } from "../operations/kinds/shell-command";
import { fileWriteKind } from "../operations/kinds/file-write";

// Extension validation (plan §35). Static checks (typecheck, forbidden-import scan) run here, in
// the main daemon process — nothing generated is executed, so there's no isolation concern, and
// it's faster with no subprocess spin-up. Execution checks (tests, live probe) run inside the
// extension-host subprocess via ExtensionHostManager, under the same isolation boundary they'll
// actually run under at real runtime.

const GENERATED_FILES = ["tools.ts", "diagnostics.ts", "browser.ts", "operations.ts"];
const ALL_GENERATED_FILES = [...GENERATED_FILES, "tests.ts"];

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

export function typecheckExtension(dir: string): string[] {
  // Includes tests.ts too — a syntax/type error there should surface here, not only at
  // run_tests execution time inside the subprocess.
  const files = ALL_GENERATED_FILES.map((f) => join(dir, f)).filter(existsSync);
  if (files.length === 0) return ["no tools.ts/diagnostics.ts/browser.ts found to typecheck"];
  const program = ts.createProgram(files, COMPILER_OPTIONS);
  const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  return diagnostics.map((d) => {
    const file = d.file ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : "?";
    return `${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

// Allowlist, not denylist — deliberately (plan's own instruction: this is a real security
// boundary, don't be lazy with a regex/denylist that has to anticipate every future dangerous
// import). Only @miro/sdk and same-directory relative imports are permitted; everything else
// (node:child_process, bun:sqlite, an npm package that isn't @miro/sdk, ...) is denied by default.
const ALLOWED_MODULES = new Set(["@miro/sdk"]);

export function scanForbiddenImports(dir: string): string[] {
  const violations: string[] = [];
  const files = ALL_GENERATED_FILES.map((f) => join(dir, f)).filter(existsSync);
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    const visit = (node: ts.Node): void => {
      let specifier: string | null = null;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) specifier = arg.text;
      }
      if (specifier !== null) {
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!isRelative && !ALLOWED_MODULES.has(specifier)) {
          violations.push(`${file}: forbidden import "${specifier}"`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

// Exported for extensions/repair.ts's periodic re-probe — same "no-arg diagnostics only" scope
// limit the live-probe validation check already uses.
export function requiresArguments(parameters: unknown): boolean {
  const schema = parameters as { required?: string[] } | undefined;
  return Boolean(schema?.required && schema.required.length > 0);
}

export interface ValidationResult {
  ok: boolean;
  failures: string[];
  /** Populated once the live-probe step successfully lists tools — reused by extensions/learn.ts
   * to build the manifest without a second, redundant listTools round-trip. */
  tools?: HostToolSpec[];
}

export async function validateExtension(
  dir: string,
  app: string,
  baseUrl: string,
  secrets: Record<string, string>,
  hostMgr: ExtensionHostManager,
): Promise<ValidationResult> {
  const failures: string[] = [];

  failures.push(...typecheckExtension(dir));
  failures.push(...scanForbiddenImports(dir));
  // Don't bother running code that doesn't even typecheck or pass the import scan.
  if (failures.length > 0) return { ok: false, failures };

  try {
    const testResults = await hostMgr.runTests(dir, app);
    for (const r of testResults) {
      if (!r.passed) failures.push(`test failed: ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    }
  } catch (err) {
    failures.push(`tests.ts failed to run: ${String(err instanceof Error ? err.message : err)}`);
  }
  if (failures.length > 0) return { ok: false, failures };

  let tools: HostToolSpec[] = [];
  try {
    tools = await hostMgr.listTools(dir, app, baseUrl, secrets);
    // Every spec's `parameters` becomes a tool schema the main agent calls with. A generated
    // `parameters: { name: "string" }` (not a schema) passed everything else and would have made
    // the provider reject the whole tool list at the next chat turn — found in a real learn run.
    for (const spec of tools) {
      const failure = invalidSchema(spec.parameters);
      if (failure) failures.push(`${spec.kind} ${spec.name}: parameters ${failure} — use Type.Object({ ... }) from "@miro/sdk"`);
    }
    if (failures.length > 0) return { ok: false, failures, tools };
    for (const diag of tools.filter((t) => t.kind === "diagnostic")) {
      if (requiresArguments(diag.parameters)) continue; // scope limit: no-arg diagnostics only, see module comment
      try {
        await hostMgr.call(dir, app, baseUrl, secrets, diag.name, {});
      } catch (err) {
        failures.push(`live probe failed for ${diag.name}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    // Operation bindings never execute at validation time, but their bound params can be dry-run
    // through the real kind's describe(): the classifier refuses a forbidden command, the URL guard
    // refuses a public host, a literal credential header is refused — at learn time, not in front
    // of the user later. No-arg operations only (same scope limit as the live probe).
    for (const op of tools.filter((t) => t.kind === "operation")) {
      if (requiresArguments(op.parameters)) continue;
      try {
        const bound = (await hostMgr.bind(dir, app, baseUrl, secrets, op.name, {})) as { kind?: string; goal?: string } & Record<string, unknown>;
        const failure = await dryRunBinding(bound);
        if (failure) failures.push(`operation ${op.name}: ${failure}`);
      } catch (err) {
        failures.push(`operation ${op.name} failed to bind: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  } catch (err) {
    failures.push(`live probe setup failed: ${String(err instanceof Error ? err.message : err)}`);
  }

  return { ok: failures.length === 0, failures, tools };
}

/** A tool/operation `parameters` value must be a JSON Schema object schema. Returns why it isn't,
 * or null. `{}` (no parameters) is accepted as the empty object schema. */
export function invalidSchema(parameters: unknown): string | null {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return "is not an object schema";
  const p = parameters as Record<string, unknown>;
  if (Object.keys(p).length === 0) return null;
  if (p.type !== "object") return `has type ${JSON.stringify(p.type)} — must be "object"`;
  if (p.properties !== undefined && (typeof p.properties !== "object" || p.properties === null)) return "has a non-object properties field";
  for (const [name, prop] of Object.entries((p.properties ?? {}) as Record<string, unknown>)) {
    if (prop === null || typeof prop !== "object" || Array.isArray(prop)) return `property ${name} is not a schema (got ${JSON.stringify(prop)})`;
  }
  return null;
}

/** Describe a bound operation through the daemon's own kind without applying anything. Returns a
 * failure message, or null if the binding is acceptable. */
export async function dryRunBinding(bound: { kind?: string; goal?: string } & Record<string, unknown>): Promise<string | null> {
  const { kind, goal, ...params } = bound;
  if (!kind || !goal) return "binding must include kind and goal";
  try {
    if (kind === "http_mutation") await httpMutationKind(() => "dry-run").describe(params as any);
    else if (kind === "shell_command") await shellCommandKind.describe(params as any);
    else if (kind === "file_write") await fileWriteKind.describe(params as any);
    else return `unknown binding kind ${kind}`;
    return null;
  } catch (err) {
    return String(err instanceof Error ? err.message : err);
  }
}
