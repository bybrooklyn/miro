import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { typecheckExtension, scanForbiddenImports } from "./validate";
import { ensureNodeModulesSymlink, MIROD_NODE_MODULES } from "./paths";

// Real filesystem, real TypeScript compiler API, real @miro/sdk resolution through the exact
// node_modules-symlink mechanism extensions actually use — not mocked, since this is the whole
// point of the check (does the TS compiler API actually resolve @miro/sdk given how extension
// directories are wired up).
function tempExtDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "miro-validate-test-"));
  ensureNodeModulesSymlink(dir, MIROD_NODE_MODULES);
  return dir;
}

// ts.createProgram() does a real, full compilation (parsing lib.d.ts + @miro/sdk + its deps) —
// live-verified on the QEMU dev VM to take 3-6s on constrained ARM64 hardware, well over Bun's
// default 5s test timeout. Not a bug, just genuinely slow; a real characteristic of every
// extension.write validation call too (see PLAN.md), not just these tests.
test(
  "typecheckExtension passes for well-typed code that imports @miro/sdk",
  () => {
    const dir = tempExtDir();
    writeFileSync(
      join(dir, "tools.ts"),
      `import { Type, type ExtensionContext, type ExtensionTool } from "@miro/sdk";
export function buildTools(ctx: ExtensionContext): ExtensionTool[] {
  return [{
    name: "test.tool", label: "Test", description: "d",
    parameters: Type.Object({}),
    execute: async () => ctx.http.get("/health"),
  }];
}`,
    );
    const errors = typecheckExtension(dir);
    expect(errors).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  },
  15000,
);

test(
  "typecheckExtension catches a real type error",
  () => {
    const dir = tempExtDir();
    writeFileSync(
      join(dir, "tools.ts"),
      `import type { ExtensionContext } from "@miro/sdk";
export function buildTools(ctx: ExtensionContext) {
  const n: number = "not a number"; // real type error
  return [];
}`,
    );
    const errors = typecheckExtension(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /not assignable/i.test(e))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  },
  15000,
);

test("typecheckExtension reports when no generated files exist", () => {
  const dir = tempExtDir();
  expect(typecheckExtension(dir)).toEqual(["no tools.ts/diagnostics.ts/browser.ts found to typecheck"]);
  rmSync(dir, { recursive: true, force: true });
});

test(
  "typecheckExtension also typechecks tests.ts, cross-resolving its imports of tools.ts/diagnostics.ts",
  () => {
    const dir = tempExtDir();
    writeFileSync(
      join(dir, "tools.ts"),
      `import { Type, type ExtensionContext, type ExtensionTool } from "@miro/sdk";
export function buildTools(ctx: ExtensionContext): ExtensionTool[] {
  return [{ name: "t", label: "T", description: "d", parameters: Type.Object({}), execute: async () => ctx.http.get("/x") }];
}`,
    );
    writeFileSync(join(dir, "diagnostics.ts"), `export function buildDiagnostics(ctx: any) { return []; }`);
    writeFileSync(
      join(dir, "tests.ts"),
      `import { createFakeHttpClient } from "@miro/sdk";
import { buildTools } from "./tools";
const bad: number = "not a number"; // real type error, should be caught
export default async function runTests() {
  const ctx = { http: createFakeHttpClient({ "/x": {} }), browser: null as any, secrets: {} };
  const tools = buildTools(ctx);
  return [{ name: tools[0].name, passed: true }];
}`,
    );
    const errors = typecheckExtension(dir);
    expect(errors.some((e) => e.includes("tests.ts") && /not assignable/i.test(e))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  },
  15000,
);

test("scanForbiddenImports allows @miro/sdk and same-directory relative imports", () => {
  const dir = tempExtDir();
  writeFileSync(join(dir, "helper.ts"), `export const x = 1;`);
  writeFileSync(
    join(dir, "tools.ts"),
    `import { Type } from "@miro/sdk";
import { x } from "./helper";
export const y = x;`,
  );
  expect(scanForbiddenImports(dir)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("scanForbiddenImports denies node:child_process (static import)", () => {
  const dir = tempExtDir();
  writeFileSync(join(dir, "tools.ts"), `import { execFile } from "node:child_process";\nexecFile("ls", []);`);
  const violations = scanForbiddenImports(dir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("node:child_process");
  rmSync(dir, { recursive: true, force: true });
});

test("scanForbiddenImports denies an arbitrary npm package (dynamic import)", () => {
  const dir = tempExtDir();
  writeFileSync(join(dir, "tools.ts"), `export async function sneaky() { return import("bun:sqlite"); }`);
  const violations = scanForbiddenImports(dir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("bun:sqlite");
  rmSync(dir, { recursive: true, force: true });
});
