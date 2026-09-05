import * as ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionHostManager } from "./host";
import type { HostToolSpec } from "./host-protocol";
import { httpMutationKind } from "../operations/kinds/http-mutation";
import { shellCommandKind } from "../operations/kinds/shell-command";
import { fileWriteKind } from "../operations/kinds/file-write";

// Extension validation (plan §35). Static checks (typecheck, forbidden-import scan) run here, in
// the main daemon process - nothing generated is executed, so there's no isolation concern, and
// it's faster with no subprocess spin-up. Execution checks (tests, live probe) run inside the
// extension-host subprocess via ExtensionHostManager, under the same isolation boundary they'll
// actually run under at real runtime.

// One generated file now (PLAN.md §5.13). Kept as an array so typecheck/import-scan stay uniform.
const GENERATED_FILES = ["extension.ts"];

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  // No ambient @types/*: without this every @types package in the monorepo (react, csstype ...) is
  // pulled into every validation - measured 23s → 17s on the reference extension (audit #7). The
  // DOM lib stays: @miro/sdk's schema engine references File/FormDataEntryValue (Vendoring note).
  types: [],
};

export function typecheckExtension(dir: string): string[] {
  const files = GENERATED_FILES.map((f) => join(dir, f)).filter(existsSync);
  if (files.length === 0) return ["no extension.ts found to typecheck"];
  const program = ts.createProgram(files, COMPILER_OPTIONS);
  const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  return diagnostics.map((d) => {
    if (!d.file) return `?: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    const line = d.file.getLineAndCharacterOfPosition(d.start ?? 0).line;
    // Quote the offending line: the retry has to fix it without seeing the file (the staging dir
    // is discarded on failure), and "',' expected" alone cost two attempts in a live run.
    const text = d.file.text.split("\n")[line]?.trim().slice(0, 160) ?? "";
    return `${d.file.fileName}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")} - in: ${text}`;
  });
}

// Allowlist, not denylist - deliberately (plan's own instruction: this is a real security
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
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text; // `export * from "x"` is an import too
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        // A computed specifier (`import("node:" + "fs")`) cannot be judged, so it is refused
        // outright rather than passed as unseen (audit A8).
        if (arg && ts.isStringLiteral(arg)) specifier = arg.text;
        else violations.push(`${file}: forbidden import "<computed>" - a dynamic import() needs a string literal`);
      }
      if (specifier !== null) {
        // Same-directory only, as documented: "../" walked out of the extension directory and
        // into the daemon's own source, which tsc resolved happily (audit A8).
        const isRelative = /^\.\/[^/]+$/.test(specifier);
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

// Exported for extensions/repair.ts's periodic re-probe - same "no-arg diagnostics only" scope
// limit the live-probe validation check already uses.
export function requiresArguments(parameters: unknown): boolean {
  const schema = parameters as { required?: string[] } | undefined;
  return Boolean(schema?.required && schema.required.length > 0);
}

// --- Structured failures (PLAN.md §5.15: "validator failures become STRUCTURED objects, ordered by
// the REST→MCP failure taxonomy, passed back verbatim - not appended prose") ---
// The failures ARE the retry contract with the (possibly weak) learn model. Weak models converge on
// external, concrete, machine-readable feedback and not on prose; a raw compiler message names the
// symptom, so the concrete fix rides alongside it as its own field. Pure and unit-tested.

export type ValidationRule = "typecheck" | "forbidden-import" | "probe-setup" | "schema" | "probe" | "dead-app" | "binding" | "capability" | "budget";

export interface ValidationFailure {
  /** The entry (tool/diagnostic/operation name) or `extension.ts:<line>` the failure is about. */
  entry?: string;
  /** The field of that entry (`parameters`, `read.path`, `bind`, an import specifier) when known. */
  field?: string;
  /** Stable rule id - what kind of check failed. */
  rule: ValidationRule;
  /** What is wrong, as reported by the check. */
  message: string;
  /** The concrete change that fixes it (compiler-as-teacher, PLAN.md §5.13). */
  fix?: string;
  /** A correct example for the rule, when one exists. */
  example?: string;
}

export function failure(rule: ValidationRule, message: string, where: { entry?: string; field?: string } = {}): ValidationFailure {
  return { ...where, rule, message };
}

const HINTS: { match: RegExp; fix: string; example?: string }[] = [
  {
    match: /http\s*\.\s*(post|put|patch|delete)|\.(post|put|patch|delete)\s*\(/i,
    fix: "ctx.http is GET-only. A write is an entry with `bind(args)` returning a { kind: \"http_mutation\", method, url, ... } binding - the daemon runs it through its engine. Never fetch a write from code.",
    example: '{ name: "create_widget", kind: "operation", description: "Create a widget.", parameters: Type.Object({ label: Type.String() }), bind: (args: { label: string }) => ({ kind: "http_mutation", goal: `Create widget ${args.label}`, method: "POST", url: "/api/widgets", body: JSON.stringify({ label: args.label }), contentType: "application/json", verifyUrl: "/api/widgets" }) }',
  },
  {
    match: /forbidden import/i,
    fix: "Only \"@miro/sdk\" and same-directory relative imports are allowed. Delete the import; use ctx.http / ctx.exec / ctx.readFile / ctx.secrets instead.",
    example: 'import { Type, type ExtensionModule, type ExtensionContext } from "@miro/sdk";',
  },
  {
    match: /must be \"object\"|is not an object schema|is not a schema|non-object properties/i,
    fix: "For a declarative `read`, OMIT `parameters` (it is derived from the {placeholders} in read.path). For a `code` entry, write a real schema: Type.Object({ field: Type.String() }) from \"@miro/sdk\".",
    example: 'parameters: Type.Object({ id: Type.String({ description: "Item id" }) })',
  },
  {
    match: /no extension\.ts found/i,
    fix: "Call extension_write with a single `extensionTs` that does `export default { auth?, entries } satisfies ExtensionModule` (import type ExtensionModule from \"@miro/sdk\").",
  },
  {
    match: /has no exported member|Cannot find name|is not exported/i,
    fix: "Import the symbol from \"@miro/sdk\": ExtensionModule, ExtensionEntry, ExtensionContext, ReadBinding, OperationBinding, Type.",
  },
  {
    match: /needs (bind|read\.path|either read)/i,
    fix: "Each entry carries exactly one of: `read` (declarative GET, preferred), `bind` (a write), or `code` (a read that needs logic). A \"operation\" entry uses bind; a \"tool\"/\"diagnostic\" uses read or code.",
    example: '{ name: "list_widgets", kind: "tool", description: "List all widgets.", read: { path: "/api/widgets", pick: ["id", "label"] } }',
  },
  {
    match: /implements web\.(search|fetch) but/i,
    fix: "An entry that implements web.search takes { query } and returns { results: [{ title, url, description }] }; one that implements web.fetch takes { url } and returns { title, content, links? }. Return exactly that shape (a code entry can reshape the app's response), or drop the implements declaration.",
    example: 'implements: [{ capability: "web.search", entry: "search" }] with { name: "search", kind: "tool", description: "...", parameters: Type.Object({ query: Type.String() }), code: async (ctx, args: { query: string }) => { const r = await ctx.http.get("/search", { query: { q: args.query, format: "json" } }); return { results: r.json<{ results: { title: string; url: string; content?: string }[] }>().results.map((x) => ({ title: x.title, url: x.url, description: x.content ?? "" })) }; } }',
  },
  {
    match: /still succeeds when the app is unreachable/i,
    fix: "A diagnostic signals a problem by THROWING - the daemon treats any returned value as healthy. Observe the app through ctx.http.get on its baseUrl and let a connection error propagate (or throw when the response is not ok). Something that checks a container, a process or a file is a \"tool\", not a \"diagnostic\".",
    example: '{ name: "reachable", kind: "diagnostic", description: "App answers on its health endpoint.", read: { path: "/health" } }',
  },
  {
    match: /\b(401|403)\b|unauthori[sz]ed|forbidden(?! import)|invalid (api )?key|authentication/i,
    fix: "The app rejected the credential. Check the auth SCHEME first: the exact header name the app documents (X-Api-Key vs Authorization vs a vendor header), any scheme word it needs in front of the token (auth.prefix: \"Bearer \", \"MediaBrowser Token=\"), and that auth.secret names a secret you actually stored. In a code entry, read the real value from ctx.secrets.<name> or pass {{secret:<ref>}} in the header - never a literal.",
    example: 'auth: { header: "Authorization", secret: "api_key", prefix: "Bearer " }',
  },
  {
    match: /ECONNREFUSED|ENOTFOUND|\b404\b|not found|Unable to connect|fetch failed/i,
    fix: "The URL is wrong before anything else can be. Re-check the base URL (port, http vs https, a path prefix the app serves under) and that read.path is app-relative (\"/api/...\"), then re-run.",
  },
];

/** Where a failure sits in the REST→MCP failure taxonomy (auth scheme 39%, base URL 22%,
 * undocumented headers/prefixes 18%, param types 12%, everything else) - the order the model
 * should fix things in, because the earlier ones make the later ones unobservable. */
function taxonomyRank(f: ValidationFailure): number {
  const text = `${f.message} ${f.field ?? ""}`;
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden(?! import)|invalid (api )?key|authentication|auth\b/i.test(text)) return 0;
  if (/ECONNREFUSED|ENOTFOUND|\b404\b|not found|Unable to connect|fetch failed|base ?url/i.test(text)) return 1;
  if (/header|content-type|prefix/i.test(text)) return 2;
  if (f.rule === "schema" || f.rule === "binding" || /parameter|schema|\btype\b/i.test(text)) return 3;
  return 4;
}

/** Attach the concrete fix (and example) to each failure that matches a known pattern, and order
 * the list most-likely-root-cause first. Stable within a rank, so file order is kept. */
export function annotateFailures(failures: ValidationFailure[]): ValidationFailure[] {
  return failures
    .map((f) => {
      const hint = HINTS.find((h) => h.match.test(f.message));
      return hint ? { ...f, fix: f.fix ?? hint.fix, ...(hint.example ? { example: f.example ?? hint.example } : {}) } : f;
    })
    .map((f, i) => ({ f, i }))
    .sort((a, b) => taxonomyRank(a.f) - taxonomyRank(b.f) || a.i - b.i)
    .map(({ f }) => f);
}

/** One line per failure for logs and notices - the model gets the objects, humans get this. */
export function formatFailure(f: ValidationFailure): string {
  const where = [f.entry, f.field].filter(Boolean).join(".");
  return `[${f.rule}]${where ? ` ${where}` : ""}: ${f.message}${f.fix ? `\n    → fix: ${f.fix}` : ""}`;
}

/** `typecheckExtension`'s "<file>:<line>: <message> - in: <text>" strings, as structured failures. */
function typecheckFailure(text: string): ValidationFailure {
  const m = /^(.+?\.ts):(\d+): ([\s\S]*)$/.exec(text);
  return m ? failure("typecheck", m[3]!, { entry: `${basename(m[1]!)}:${m[2]}` }) : failure("typecheck", text);
}

function importFailure(text: string): ValidationFailure {
  const m = /forbidden import "([^"]+)"/.exec(text);
  return failure("forbidden-import", text.replace(/^.*?: /, ""), m ? { entry: "extension.ts", field: `import "${m[1]}"` } : { entry: "extension.ts" });
}

export interface ValidationResult {
  ok: boolean;
  failures: ValidationFailure[];
  /** Populated once the live-probe step successfully lists tools - reused by extensions/learn.ts
   * to build the manifest without a second, redundant listTools round-trip. */
  tools?: HostToolSpec[];
  /** The module's validated capability implementations, for the manifest. */
  implements?: { capability: string; entry: string }[];
}

/** The capabilities an extension may implement, with the request the validator probes each with
 * and the check on what comes back (PLAN.md §5.14 slice 3). */
export const IMPLEMENTABLE_CAPABILITIES: Record<string, { probe: (baseUrl: string) => Record<string, unknown> }> = {
  "web.search": { probe: () => ({ query: "debian" }) },
  "web.fetch": { probe: (baseUrl) => ({ url: baseUrl }) },
};

/** Why `value` is not the capability's canonical response, or null. The router's normalizers
 * (capabilities/extensions.ts) accept exactly what passes here. */
export function checkCapabilityResult(capability: string, value: unknown): string | null {
  if (value === null || typeof value !== "object") return `returned ${JSON.stringify(value)} - must return an object`;
  const v = value as Record<string, unknown>;
  if (capability === "web.search") {
    if (!Array.isArray(v.results)) return "must return { results: [...] }";
    const bad = (v.results as unknown[]).findIndex((r) => !r || typeof r !== "object" || typeof (r as { title?: unknown }).title !== "string" || typeof (r as { url?: unknown }).url !== "string");
    return bad >= 0 ? `results[${bad}] must be { title: string, url: string, description?: string }` : null;
  }
  if (capability === "web.fetch") {
    if (typeof v.content !== "string") return "must return { title?: string, content: string, links?: [...] }";
    return null;
  }
  return `"${capability}" is not a capability an extension can implement (web.search, web.fetch)`;
}

/** A URL nothing answers on (the discard port) - the "app is down" the dead-app check simulates. */
const DEAD_BASE_URL = "http://127.0.0.1:9";

export async function validateExtension(
  dir: string,
  app: string,
  baseUrl: string,
  secrets: Record<string, string>,
  hostMgr: ExtensionHostManager,
): Promise<ValidationResult> {
  const failures: ValidationFailure[] = [];

  failures.push(...typecheckExtension(dir).map(typecheckFailure));
  failures.push(...scanForbiddenImports(dir).map(importFailure));
  // The one hard ordering dependency: never RUN code that doesn't compile or violates the import
  // allowlist. Everything past here is independent and aggregated, so one attempt surfaces every
  // remaining problem at once instead of one class per attempt (audit X1). tests.ts is no longer
  // generated or run - the live probe and dry-run below test the real code against the real kinds,
  // which is stronger and matches the no-mocks house rule (audit X4).
  if (failures.length > 0) return { ok: false, failures: annotateFailures(failures) };

  let tools: HostToolSpec[] = [];
  let implementsDecls: { capability: string; entry: string }[] = [];
  try {
    const mod = await hostMgr.listModule(dir, app, baseUrl, secrets);
    tools = mod.tools;
    implementsDecls = mod.implements;
  } catch (err) {
    failures.push(failure("probe-setup", `live probe setup failed: ${String(err instanceof Error ? err.message : err)}`));
    return { ok: false, failures: annotateFailures(failures) };
  }

  // Every spec's `parameters` becomes a tool schema the main agent calls with. A generated
  // `parameters: { name: "string" }` (not a schema) would make the provider reject the whole tool
  // list at the next chat turn - found in a real learn run.
  for (const spec of tools) {
    const why = invalidSchema(spec.parameters);
    if (why) failures.push(failure("schema", `parameters ${why}`, { entry: spec.name, field: "parameters" }));
  }

  // A no-arg diagnostic with a valid schema is probed live; a bad-schema tool is skipped here (its
  // schema failure is already reported) rather than called with an unknown shape.
  const probed = new Set<string>();
  for (const diag of tools.filter((t) => t.kind === "diagnostic")) {
    if (requiresArguments(diag.parameters) || invalidSchema(diag.parameters)) continue;
    try {
      await hostMgr.call(dir, app, baseUrl, secrets, diag.name, {});
      probed.add(diag.name);
    } catch (err) {
      failures.push(failure("probe", `live probe failed: ${String(err instanceof Error ? err.message : err)}`, { entry: diag.name }));
    }
  }

  // Admission check (PLAN.md §5.15): a diagnostic must FAIL when the app is down. A code diagnostic
  // that never really observes the app - returns {healthy: true} unconditionally, or swallows the
  // connection error into a returned value - passes the live probe and would report a dead app as
  // healthy forever. Probed in a throwaway session against a URL nothing answers on. A declarative
  // read cannot pass this by construction (its GET fails), so only code diagnostics are checked.
  for (const diag of tools.filter((t) => t.kind === "diagnostic" && t.impl === "code" && probed.has(t.name))) {
    let survived = false;
    try {
      await hostMgr.probe(dir, app, DEAD_BASE_URL, secrets, diag.name, {});
      survived = true;
    } catch {
      // correct: it failed with the app unreachable
    }
    if (survived) failures.push(failure("dead-app", `diagnostic still succeeds when the app is unreachable (${DEAD_BASE_URL}) - it does not actually observe the app`, { entry: diag.name }));
  }

  // A declared capability implementation (PLAN.md §5.14 slice 3): the entry must exist as a tool,
  // the capability must be one an extension can implement, and a live probe with the capability's
  // request must come back in its canonical shape - a provider the router will pick has to answer
  // like Miro's own.
  for (const decl of implementsDecls) {
    const where = { entry: decl.entry, field: "implements" };
    const known = IMPLEMENTABLE_CAPABILITIES[decl.capability];
    if (!known) {
      failures.push(failure("capability", checkCapabilityResult(decl.capability, {}) ?? `unknown capability ${decl.capability}`, where));
      continue;
    }
    const spec = tools.find((t) => t.name === decl.entry);
    if (!spec || spec.kind !== "tool") {
      failures.push(failure("capability", `implements ${decl.capability} names "${decl.entry}", which is not a tool entry of this extension`, where));
      continue;
    }
    try {
      const value = await hostMgr.call(dir, app, baseUrl, secrets, decl.entry, known.probe(baseUrl));
      const why = checkCapabilityResult(decl.capability, value);
      if (why) failures.push(failure("capability", `${decl.entry} implements ${decl.capability} but ${why}`, where));
    } catch (err) {
      failures.push(failure("capability", `${decl.entry} implements ${decl.capability} but the probe failed: ${String(err instanceof Error ? err.message : err)}`, where));
    }
  }

  // Operation bindings never execute at validation time, but the NO-ARGUMENT ones are dry-run through
  // the real kind's describe(): the classifier refuses a forbidden command, the URL guard refuses a
  // public host, a literal credential header is refused - at learn time, not in front of the user.
  // A binding that takes arguments is bound for the first time when the agent calls it and meets
  // the same checks then (audit C7: the comment used to claim every binding was dry-run).
  for (const op of tools.filter((t) => t.kind === "operation")) {
    if (requiresArguments(op.parameters) || invalidSchema(op.parameters)) continue;
    try {
      const bound = resolveBindingUrls((await hostMgr.bind(dir, app, baseUrl, secrets, op.name, {})) as { kind?: string; goal?: string } & Record<string, unknown>, baseUrl);
      const why = await dryRunBinding(bound);
      if (why) failures.push(failure("binding", why, { entry: op.name, field: "bind" }));
    } catch (err) {
      failures.push(failure("binding", `failed to bind: ${String(err instanceof Error ? err.message : err)}`, { entry: op.name, field: "bind" }));
    }
  }

  return { ok: failures.length === 0, failures: annotateFailures(failures), tools, implements: implementsDecls };
}

/** A tool/operation `parameters` value must be a JSON Schema object schema. Returns why it isn't,
 * or null. `{}` (no parameters) is accepted as the empty object schema. */
export function invalidSchema(parameters: unknown): string | null {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return "is not an object schema";
  const p = parameters as Record<string, unknown>;
  if (Object.keys(p).length === 0) return null;
  if (p.type !== "object") return `has type ${JSON.stringify(p.type)} - must be "object"`;
  if (p.properties !== undefined && (typeof p.properties !== "object" || p.properties === null)) return "has a non-object properties field";
  for (const [name, prop] of Object.entries((p.properties ?? {}) as Record<string, unknown>)) {
    if (prop === null || typeof prop !== "object" || Array.isArray(prop)) return `property ${name} is not a schema (got ${JSON.stringify(prop)})`;
  }
  return null;
}

/** A binding's URLs may be app-relative ("/Startup/User"), exactly like a generated tool's
 * ctx.http.get - resolved against the extension's baseUrl here, before the kind ever sees
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
