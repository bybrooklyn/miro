import { test, expect } from "bun:test";
import { join } from "node:path";
import { typecheckExtension, scanForbiddenImports, invalidSchema } from "./validate";
import { entrySpec, validateEntry } from "./declarative";
import type { ExtensionModule } from "@miro/sdk";

// The reference extension (PLAN.md §5.13) must pass the real static validators, so the pipeline is
// proven to accept a correct single-file declarative extension and stays proven against every future
// SDK/validator/prompt change. The live-probe half needs a subprocess + a live app and is verified on
// the dev VM; these are the checks that run in CI.
const dir = join(import.meta.dir, "reference");

test("the reference extension typechecks cleanly through the real typechecker", () => {
  expect(typecheckExtension(dir)).toEqual([]);
});

test("the reference extension imports only @miro/sdk (passes the allowlist scan)", () => {
  expect(scanForbiddenImports(dir)).toEqual([]);
});

test("every reference entry is well-formed and derives a valid tool schema", async () => {
  const mod = (await import("./reference/extension")).default as ExtensionModule;
  expect(Array.isArray(mod.entries)).toBe(true);
  for (const entry of mod.entries) {
    validateEntry(entry); // throws if the entry shape is wrong
    expect(invalidSchema(entrySpec(entry).parameters)).toBeNull(); // derived or explicit schema is valid
  }
  // The get_widget declarative read auto-derives {id} as a required string param — no hand-typed schema.
  expect(entrySpec(mod.entries.find((e) => e.name === "get_widget")!).parameters).toEqual({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  // The declarative write binds to an http_mutation the daemon's engine runs.
  const bound = mod.entries.find((e) => e.name === "create_widget")!.bind!({ label: "x" }) as { kind: string; goal: string };
  expect(bound.kind).toBe("http_mutation");
  expect(bound.goal).toContain("widget");
});
