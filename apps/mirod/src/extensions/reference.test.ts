import { test, expect } from "bun:test";
import { join } from "node:path";
import { typecheckExtension, scanForbiddenImports, invalidSchema } from "./validate";

// The reference extension (audit X3) must pass the real static validators, so the pipeline is
// proven to accept a correct extension and stays proven against every future SDK/validator/prompt
// change. The live-probe and dry-run halves need a subprocess + a live app and are verified on the
// dev VM; these are the checks that run in CI.
const dir = join(import.meta.dir, "reference");

test("the reference extension typechecks cleanly through the real typechecker", () => {
  expect(typecheckExtension(dir)).toEqual([]);
});

test("the reference extension imports only @miro/sdk (passes the allowlist scan)", () => {
  expect(scanForbiddenImports(dir)).toEqual([]);
});

test("the reference extension's tool schemas are valid object schemas", async () => {
  // Load the real generated modules and check every parameters schema the way validateExtension does.
  const tools = await import("./reference/tools");
  const diags = await import("./reference/diagnostics");
  const ops = await import("./reference/operations");
  const fakeCtx: any = { http: { get: async () => ({ ok: true, status: 200, body: "{}", json: () => ({}) }) }, secrets: { api_key: "x" }, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => "" };
  for (const t of [...tools.buildTools(fakeCtx), ...diags.buildDiagnostics(fakeCtx)]) {
    expect(invalidSchema(t.parameters)).toBeNull();
    expect(typeof t.execute).toBe("function");
  }
  for (const op of ops.buildOperations(fakeCtx)) {
    expect(invalidSchema(op.parameters)).toBeNull();
    const bound = op.bind({ label: "x" }) as { kind: string; goal: string };
    expect(bound.kind).toBe("http_mutation");
    expect(bound.goal).toContain("widget");
  }
});
