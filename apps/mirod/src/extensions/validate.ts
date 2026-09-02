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

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

export function typecheckExtension(dir: string): string[] {
  const files = GENERATED_FILES.map((f) => join(dir, f)).filter(existsSync);
  if (files.length === 0) return ["no tools.ts/diagnostics.ts/browser.ts found to typecheck"];
  const program = ts.createProgram(files, COMPILER_OPTIONS);
  const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  return diagnostics.map((d) => {
    if (!d.file) return `?: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    const line = d.file.getLineAndCharacterOfPosition(d.start ?? 0).line;
    // Quote the offending line: the retry has to fix it without seeing the file (the staging dir
    // is discarded on failure), and "',' expected" alone cost two attempts in a live run.
    const text = d.file.text.split("\n")[line]?.trim().slice(0, 160) ?? "";
    return `${d.file.fileName}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")} — in: ${text}`;
  });
}

// Allowlist, not denylist — deliberately (plan's own instruction: this is a real security
// boundary, don't be lazy with a regex/denylist that has to anticipate every future dangerous
// import). Only @miro/sdk and same-directory relative imports are permitted; everything else
// (node:child_process, bun:sqlite, an npm package that isn't @miro/sdk, ...) is denied by default.
const ALLOWED_MODULES = new Set(["@miro/sdk"]);

export function scanForbiddenImports(dir: string): string[] {
  const violations: string[] = [];
  const files = GENERATED_FILES.map((f) => join(dir, f)).filter(existsSync);
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
  // The one hard ordering dependency: never RUN code that doesn't compile or violates the import
  // allowlist. Everything past here is independent and aggregated, so one attempt surfaces every
  // remaining problem at once instead of one class per attempt (audit X1). tests.ts is no longer
  // generated or run — the live probe and dry-run below test the real code against the real kinds,
  // which is stronger and matches the no-mocks house rule (audit X4).
  if (failures.length > 0) return { ok: false, failures };

  let tools: HostToolSpec[] = [];
  try {
    tools = await hostMgr.listTools(dir, app, baseUrl, secrets);
  } catch (err) {
    failures.push(`live probe setup failed: ${String(err instanceof Error ? err.message : err)}`);
    return { ok: false, failures };
  }

  // Every spec's `parameters` becomes a tool schema the main agent calls with. A generated
  // `parameters: { name: "string" }` (not a schema) would make the provider reject the whole tool
  // list at the next chat turn — found in a real learn run.
  for (const spec of tools) {
    const failure = invalidSchema(spec.parameters);
    if (failure) failures.push(`${spec.kind} ${spec.name}: parameters ${failure} — use Type.Object({ ... }) from "@miro/sdk"`);
  }

  // A no-arg diagnostic with a valid schema is probed live; a bad-schema tool is skipped here (its
  // schema failure is already reported) rather than called with an unknown shape.
  for (const diag of tools.filter((t) => t.kind === "diagnostic")) {
    if (requiresArguments(diag.parameters) || invalidSchema(diag.parameters)) continue;
    try {
      await hostMgr.call(dir, app, baseUrl, secrets, diag.name, {});
    } catch (err) {
      failures.push(`live probe failed for ${diag.name}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  // Operation bindings never execute at validation time, but their bound params are dry-run through
  // the real kind's describe(): the classifier refuses a forbidden command, the URL guard refuses a
  // public host, a literal credential header is refused — at learn time, not in front of the user.
  for (const op of tools.filter((t) => t.kind === "operation")) {
    if (requiresArguments(op.parameters) || invalidSchema(op.parameters)) continue;
    try {
      const bound = resolveBindingUrls((await hostMgr.bind(dir, app, baseUrl, secrets, op.name, {})) as { kind?: string; goal?: string } & Record<string, unknown>, baseUrl);
      const failure = await dryRunBinding(bound);
      if (failure) failures.push(`operation ${op.name}: ${failure}`);
    } catch (err) {
      failures.push(`operation ${op.name} failed to bind: ${String(err instanceof Error ? err.message : err)}`);
    }
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

/** A binding's URLs may be app-relative ("/Startup/User"), exactly like a generated tool's
 * ctx.http.get — resolved against the extension's baseUrl here, before the kind ever sees
 * them. Found live: every absolute-URL refusal in a learn run was a relative path the model
 * had every reason to write. */
export function resolveBindingUrls<T extends Record<string, unknown>>(bound: T, baseUrl: string): T {
  if (bound.kind !== "http_mutation") return bound;
  const base = baseUrl.replace(/\/+$/, "");
  const abs = (u: unknown) => (typeof u === "string" && u.startsWith("/") ? `${base}${u}` : u);
  const rollback = bound.rollback && typeof bound.rollback === "object" ? { ...(bound.rollback as Record<string, unknown>), url: abs((bound.rollback as Record<string, unknown>).url) } : bound.rollback;
  return { ...bound, url: abs(bound.url), captureUrl: abs(bound.captureUrl), verifyUrl: abs(bound.verifyUrl), rollback };
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
