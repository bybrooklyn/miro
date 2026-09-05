import { test, expect } from "bun:test";
import { createFakeHttpClient, type ExtensionContext, type ExtensionModule } from "@miro/sdk";
import { templatePath, pathPlaceholders, entryParameters, objectSchema, applyPick, moduleAuthHeaders, runRead, validateEntry } from "./declarative";

// The declarative-read interpreter (PLAN.md §5.13) is what makes a purely-declarative extension run
// zero generated code. Real fake HTTP client (no mocks), pure logic - the checks that guard the
// interpreter without needing a live app.

function ctx(routes: Record<string, unknown>, secrets: Record<string, string> = {}): ExtensionContext {
  return { http: createFakeHttpClient(routes), secrets, browser: {} as any, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => "" };
}

test("templatePath extracts, substitutes, and URL-encodes path placeholders", () => {
  expect(pathPlaceholders("/Items/{id}/x/{kind}")).toEqual(["id", "kind"]);
  expect(templatePath("/Items/{id}", { id: "a b/c" })).toBe("/Items/a%20b%2Fc");
  expect(templatePath("/no/params", {})).toBe("/no/params");
});

test("entryParameters derives a required-string schema from read placeholders, else the canonical empty object schema", () => {
  expect(entryParameters({ name: "a", kind: "tool", description: "d", read: { path: "/Items/{id}" } })).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
  // Never a bare {} - the wire layer collapses that to the boolean `true`, which OpenAI rejects (found live).
  expect(entryParameters({ name: "b", kind: "tool", description: "d", read: { path: "/all" } })).toEqual({ type: "object", properties: {} });
  expect(entryParameters({ name: "b2", kind: "tool", description: "d", parameters: {}, code: async () => 1 })).toEqual({ type: "object", properties: {} });
  const explicit = { type: "object", properties: { q: { type: "string" } } };
  expect(entryParameters({ name: "c", kind: "tool", description: "d", parameters: explicit, code: async () => 1 })).toBe(explicit);
});

test("entrySpec records how an entry is implemented, for the validator's dead-app check", async () => {
  const { entrySpec } = await import("./declarative");
  expect(entrySpec({ name: "a", kind: "diagnostic", description: "d", read: { path: "/health" } }).impl).toBe("read");
  expect(entrySpec({ name: "b", kind: "diagnostic", description: "d", code: async () => 1 }).impl).toBe("code");
  expect(entrySpec({ name: "c", kind: "operation", description: "d", bind: () => ({ kind: "http_mutation", goal: "g" }) } as any).impl).toBe("bind");
});

test("objectSchema turns a Type.Object(...) schema into plain JSON Schema and a legacy {} into the canonical empty object schema", async () => {
  const { Type } = await import("@miro/sdk");
  expect(objectSchema(Type.Object({ id: Type.String() }))).toMatchObject({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
  expect(objectSchema({})).toEqual({ type: "object", properties: {} });
  expect(objectSchema(undefined)).toEqual({ type: "object", properties: {} });
});

test("applyPick keeps only picked fields, over an object or an array response", () => {
  expect(applyPick({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
  expect(applyPick([{ a: 1, b: 2 }, { a: 3, b: 4 }], ["a"])).toEqual([{ a: 1 }, { a: 3 }]);
  expect(applyPick({ a: 1 }, undefined)).toEqual({ a: 1 }); // no pick → passthrough
});

test("moduleAuthHeaders sends the named secret under the declared header, or nothing", () => {
  const mod = { auth: { header: "X-Emby-Token", secret: "api_key" }, entries: [] } as ExtensionModule;
  expect(moduleAuthHeaders(mod, { api_key: "tok" })).toEqual({ "X-Emby-Token": "tok" });
  // The scheme word an Authorization-style header needs in front of the token (found live: Jellyfin's
  // "MediaBrowser Token=" has no way to be expressed otherwise).
  const prefixed: ExtensionModule = { auth: { header: "Authorization", secret: "api_key", prefix: "Bearer " }, entries: [] };
  expect(moduleAuthHeaders(prefixed, { api_key: "tok" })).toEqual({ Authorization: "Bearer tok" });
  expect(moduleAuthHeaders({ entries: [] } as ExtensionModule, { api_key: "tok" })).toEqual({});
  expect(moduleAuthHeaders(mod, {})).toEqual({}); // secret absent → no header (never send the literal "undefined")
});

test("runRead GETs, applies pick, and enforces expectStatus", async () => {
  const mod = { auth: { header: "X-Api-Key", secret: "api_key" }, entries: [] } as ExtensionModule;
  const c = ctx({ "/api/widgets": [{ id: 1, label: "a", extra: "x" }], "/down": { status: 503, body: "loading" } }, { api_key: "k" });
  expect(await runRead(c, mod, { path: "/api/widgets", pick: ["id", "label"] }, {})).toEqual([{ id: 1, label: "a" }]);
  await expect(runRead(c, mod, { path: "/down" }, {})).rejects.toThrow(/returned 503, expected 200/);
});

test("validateEntry names the exact shape problem, and accepts well-formed entries", () => {
  expect(() => validateEntry({ name: "x", kind: "operation", description: "d" })).toThrow(/needs bind/);
  expect(() => validateEntry({ name: "x", kind: "tool", description: "d" })).toThrow(/either read .* or code/);
  expect(() => validateEntry({ name: "x", kind: "tool", description: "d", read: {} })).toThrow(/needs read\.path/);
  expect(() => validateEntry({ kind: "tool" })).toThrow(/must be \{ name/);
  validateEntry({ name: "ok", kind: "tool", description: "d", read: { path: "/x" } });
  validateEntry({ name: "ok", kind: "operation", description: "d", bind: () => ({ kind: "http_mutation", goal: "g" }) });
});
