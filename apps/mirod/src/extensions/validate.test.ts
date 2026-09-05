import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { typecheckExtension, scanForbiddenImports, resolveBindingUrls, dryRunBinding, annotateFailures, failure, formatFailure, checkCapabilityResult } from "./validate";
import { ensureNodeModulesSymlink, MIROD_NODE_MODULES } from "./paths";

test("binding URLs may be app-relative; they resolve against baseUrl before the kind's URL guard", async () => {
  const bound = { kind: "http_mutation", goal: "create admin", method: "POST", url: "/Startup/User", verifyUrl: "/Startup/User", rollback: { method: "DELETE", url: "/Users/x" } };
  expect(await dryRunBinding(bound)).toMatch(/not a local or private-network address/);
  const resolved = resolveBindingUrls(bound, "http://127.0.0.1:8096/");
  expect(resolved.url).toBe("http://127.0.0.1:8096/Startup/User");
  expect(resolved.verifyUrl).toBe("http://127.0.0.1:8096/Startup/User");
  expect((resolved.rollback as { url: string }).url).toBe("http://127.0.0.1:8096/Users/x");
  expect(await dryRunBinding(resolved)).toBeNull();
  // Absolute URLs and other kinds pass through untouched.
  expect(resolveBindingUrls({ kind: "http_mutation", url: "http://10.0.0.5/x" }, "http://127.0.0.1:8096").url).toBe("http://10.0.0.5/x");
  expect(resolveBindingUrls({ kind: "shell_command", command: "ls /" }, "http://127.0.0.1:8096")).toEqual({ kind: "shell_command", command: "ls /" });
});

// Real filesystem, real TypeScript compiler API, real @miro/sdk resolution through the exact
// node_modules-symlink mechanism extensions actually use - not mocked, since this is the whole
// point of the check (does the TS compiler API actually resolve @miro/sdk given how extension
// directories are wired up).
function tempExtDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "miro-validate-test-"));
  ensureNodeModulesSymlink(dir, MIROD_NODE_MODULES);
  return dir;
}

// ts.createProgram() does a real, full compilation (parsing lib.d.ts + @miro/sdk + its deps) -
// live-verified on the QEMU dev VM to take 3-6s on constrained ARM64 hardware, well over Bun's
// default 5s test timeout. Not a bug, just genuinely slow; a real characteristic of every
// extension_write validation call too (see PLAN.md), not just these tests.
test(
  "typecheckExtension accepts a correct single-file declarative extension importing @miro/sdk",
  () => {
    const dir = tempExtDir();
    writeFileSync(
      join(dir, "extension.ts"),
      `import { Type, type ExtensionModule, type ExtensionContext } from "@miro/sdk";
export default {
  auth: { header: "X-Api-Key", secret: "api_key" },
  entries: [
    { name: "list_widgets", kind: "tool", description: "List widgets.", read: { path: "/api/widgets", pick: ["id"] } },
    { name: "get_widget", kind: "tool", description: "Get a widget.", read: { path: "/api/widgets/{id}" } },
    { name: "reachable", kind: "diagnostic", description: "Health.", code: async (ctx: ExtensionContext) => ({ ok: (await ctx.http.get("/health")).ok }) },
  ],
} satisfies ExtensionModule;`,
    );
    expect(typecheckExtension(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  },
  15000,
);

test(
  "typecheckExtension catches a real type error",
  () => {
    const dir = tempExtDir();
    writeFileSync(
      join(dir, "extension.ts"),
      `import type { ExtensionModule } from "@miro/sdk";
const n: number = "not a number"; // real type error
export default { entries: [] } satisfies ExtensionModule;`,
    );
    const errors = typecheckExtension(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /not assignable/i.test(e))).toBe(true);
    expect(errors.some((e) => e.includes("extension.ts"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  },
  15000,
);

test("typecheckExtension reports when no generated file exists", () => {
  const dir = tempExtDir();
  expect(typecheckExtension(dir)).toEqual(["no extension.ts found to typecheck"]);
  rmSync(dir, { recursive: true, force: true });
});

test(
  "typecheckExtension resolves a relative import from extension.ts and still catches a type error",
  () => {
    const dir = tempExtDir();
    writeFileSync(join(dir, "helper.ts"), `export const widgetCount: number = 3;`);
    writeFileSync(
      join(dir, "extension.ts"),
      `import type { ExtensionModule } from "@miro/sdk";
import { widgetCount } from "./helper";
const bad: string = widgetCount; // number not assignable to string
export default { entries: [] } satisfies ExtensionModule;`,
    );
    const errors = typecheckExtension(dir);
    expect(errors.some((e) => /not assignable/i.test(e))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  },
  15000,
);

test("scanForbiddenImports allows @miro/sdk and same-directory relative imports", () => {
  const dir = tempExtDir();
  writeFileSync(join(dir, "helper.ts"), `export const x = 1;`);
  writeFileSync(
    join(dir, "extension.ts"),
    `import { Type } from "@miro/sdk";
import { x } from "./helper";
export const y = x;`,
  );
  expect(scanForbiddenImports(dir)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("scanForbiddenImports denies node:child_process (static import)", () => {
  const dir = tempExtDir();
  writeFileSync(join(dir, "extension.ts"), `import { execFile } from "node:child_process";\nexecFile("ls", []);`);
  const violations = scanForbiddenImports(dir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("node:child_process");
  rmSync(dir, { recursive: true, force: true });
});

test("scanForbiddenImports denies an arbitrary npm package (dynamic import)", () => {
  const dir = tempExtDir();
  writeFileSync(join(dir, "extension.ts"), `export async function sneaky() { return import("bun:sqlite"); }`);
  const violations = scanForbiddenImports(dir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("bun:sqlite");
  rmSync(dir, { recursive: true, force: true });
});

test("scanForbiddenImports denies a computed import() specifier, a parent-directory import, and a re-export (audit A8)", () => {
  const dir = tempExtDir();
  writeFileSync(
    join(dir, "extension.ts"),
    `import { x } from "../../secrets";
export * from "node:fs";
export async function sneaky(m: string) { return import("node:" + m); }`,
  );
  const violations = scanForbiddenImports(dir);
  expect(violations.map((v) => v.replace(/^.*: /, ""))).toEqual([
    'forbidden import "../../secrets"',
    'forbidden import "node:fs"',
    'forbidden import "<computed>" - a dynamic import() needs a string literal',
  ]);
  rmSync(dir, { recursive: true, force: true });
});

// Compiler-as-teacher (PLAN.md §5.13, structured per §5.15): a raw failure names the symptom; the
// concrete fix (and an example) ride alongside as their own fields, so a weak learn model converges
// instead of looping. Unit-tested so the hints can't silently rot.
test("annotateFailures attaches the concrete fix and example for known failure shapes", () => {
  const [postFix] = annotateFailures([failure("typecheck", `Property 'post' does not exist - in: ctx.http.post("/x")`, { entry: "extension.ts:5" })]);
  expect(postFix!.fix).toMatch(/GET-only/);
  expect(postFix!.fix).toMatch(/bind\(args\)/);
  expect(postFix!.example).toMatch(/kind: "operation"/);
  expect(postFix!.entry).toBe("extension.ts:5");

  const [importFix] = annotateFailures([failure("forbidden-import", `forbidden import "node:fs"`, { entry: "extension.ts", field: 'import "node:fs"' })]);
  expect(importFix!.fix).toMatch(/@miro\/sdk/);

  const [schemaFix] = annotateFailures([failure("schema", `parameters has type "string" - must be "object"`, { entry: "list", field: "parameters" })]);
  expect(schemaFix!.fix).toMatch(/OMIT `parameters`|Type\.Object/);

  const [deadApp] = annotateFailures([failure("dead-app", "diagnostic still succeeds when the app is unreachable (http://127.0.0.1:9)", { entry: "health" })]);
  expect(deadApp!.fix).toMatch(/THROWING/);

  // An unrecognised failure is passed through unchanged (no false hint).
  const [unknown] = annotateFailures([failure("probe", "something totally unrelated", { entry: "x" })]);
  expect(unknown).toEqual({ rule: "probe", entry: "x", message: "something totally unrelated" });
});

// The REST→MCP failure taxonomy (auth scheme, base URL, headers, param types, rest): an auth failure
// makes everything after it unobservable, so it comes first regardless of where the checks ran.
test("annotateFailures orders failures most-likely-root-cause first, stable within a rank", () => {
  const ordered = annotateFailures([
    failure("schema", `parameters has type "string" - must be "object"`, { entry: "b", field: "parameters" }),
    failure("probe", "live probe failed: GET /x returned 404, expected 200", { entry: "c" }),
    failure("probe", "live probe failed: GET /y returned 401, expected 200", { entry: "a" }),
    failure("probe", "live probe failed: something else entirely", { entry: "d" }),
    failure("probe", "live probe failed: GET /z returned 403, expected 200", { entry: "e" }),
  ]);
  expect(ordered.map((f) => f.entry)).toEqual(["a", "e", "c", "b", "d"]);
  expect(ordered[0]!.fix).toMatch(/auth SCHEME/);
  expect(ordered[2]!.fix).toMatch(/base URL/);
});

// A declared capability implementation must answer in the canonical shape (PLAN.md §5.14 slice 3).
test("checkCapabilityResult accepts the canonical shapes and names what is wrong otherwise", () => {
  expect(checkCapabilityResult("web.search", { results: [{ title: "a", url: "https://a", description: "d" }, { title: "b", url: "https://b" }] })).toBeNull();
  expect(checkCapabilityResult("web.search", { results: [] })).toBeNull();
  expect(checkCapabilityResult("web.search", { hits: [] })).toBe("must return { results: [...] }");
  expect(checkCapabilityResult("web.search", { results: [{ title: "a" }] })).toBe("results[0] must be { title: string, url: string, description?: string }");
  expect(checkCapabilityResult("web.search", "text")).toMatch(/must return an object/);
  expect(checkCapabilityResult("web.fetch", { content: "x" })).toBeNull();
  expect(checkCapabilityResult("web.fetch", { title: "t" })).toMatch(/content: string/);
  expect(checkCapabilityResult("web.mail", {})).toMatch(/not a capability an extension can implement/);
  const [hinted] = annotateFailures([failure("capability", "search implements web.search but must return { results: [...] }", { entry: "search", field: "implements" })]);
  expect(hinted!.fix).toMatch(/takes \{ query \}/);
});

test("formatFailure renders one human line per failure", () => {
  expect(formatFailure({ rule: "schema", entry: "list", field: "parameters", message: "is not an object schema", fix: "use Type.Object" })).toBe("[schema] list.parameters: is not an object schema\n    → fix: use Type.Object");
  expect(formatFailure({ rule: "probe-setup", message: "live probe setup failed: boom" })).toBe("[probe-setup]: live probe setup failed: boom");
});
