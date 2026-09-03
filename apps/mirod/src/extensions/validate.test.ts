import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { typecheckExtension, scanForbiddenImports, resolveBindingUrls, dryRunBinding, annotateFailures } from "./validate";
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

// Compiler-as-teacher (PLAN.md §5.13): a raw failure names the symptom; annotateFailures appends the
// fix so a weak learn model converges instead of looping. Unit-tested so the hints can't silently rot.
test("annotateFailures appends the concrete fix for known failure shapes", () => {
  const [postFix] = annotateFailures([`extension.ts:5: Property 'post' does not exist - in: ctx.http.post("/x")`]);
  expect(postFix).toMatch(/GET-only/);
  expect(postFix).toMatch(/bind\(args\)/);

  const [importFix] = annotateFailures([`extension.ts: forbidden import "node:fs"`]);
  expect(importFix).toMatch(/@miro\/sdk/);

  const [schemaFix] = annotateFailures([`tool list: parameters has type "string" - must be "object"`]);
  expect(schemaFix).toMatch(/OMIT `parameters`|Type\.Object/);

  // An unrecognised failure is passed through unchanged (no false hint).
  expect(annotateFailures(["something totally unrelated"])).toEqual(["something totally unrelated"]);
});
