// The declarative-extension interpreter (PLAN.md §5.13). Pure logic shared by the extension-host
// subprocess (host-entry.ts) and its unit tests - kept out of host-entry.ts so a test can import it
// without pulling in that file's stdin/Bun.WebView bootstrap. A declarative `read` entry is DATA,
// not code; this turns it back into a real GET, so a purely-declarative extension runs no generated
// code at all. A captured HTTP trace maps onto a ReadBinding one-to-one, which is what will let a
// discovered API become an extension with zero codegen (slice 2).

import type { ExtensionContext, ExtensionEntry, ExtensionModule, ReadBinding } from "@miro/sdk";
import type { HostToolSpec } from "./host-protocol";

const PLACEHOLDER = /\{(\w+)\}/g;

export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

export function templatePath(path: string, args: any): string {
  return path.replace(PLACEHOLDER, (_m, name) => encodeURIComponent(String(args?.[name] ?? "")));
}

/** `Type.Object(...)` from @miro/sdk is no longer a plain JSON object (PLAN.md §5.17: the schema
 * engine's Type is a callable carrying toJsonSchema) - the manifest, the host RPC and the validator
 * all need plain JSON Schema, so this is the one place an entry's schema is turned into it. */
export function toJsonSchema(parameters: unknown): unknown {
  const schema = parameters as { toJsonSchema?: (options: unknown) => unknown } | null | undefined;
  if (typeof schema?.toJsonSchema !== "function") return parameters;
  // Same options agent-core uses for the wire, so a schema means the same thing in both places.
  return schema.toJsonSchema({ target: "draft-2020-12", fallback: (ctx: { base: unknown }) => ctx.base });
}

/** A tool's parameters as the JSON Schema the manifest stores and the model is shown - with a
 * no-argument tool spelled as the canonical `{ type: "object", properties: {} }`, never a bare `{}`.
 * A bare `{}` is a valid JSON Schema ("anything") that the wire layer legitimately collapses to the
 * boolean `true`, which OpenAI's tools API then rejects ("expected an object, but got a boolean") -
 * found live on the first Codex turn after the migration, on every no-arg extension tool. Applied
 * where a manifest is written (entryParameters) AND where one is read (agent/extension-tools.ts),
 * so extensions promoted before this fix keep working. */
export function objectSchema(parameters: unknown): unknown {
  const p = toJsonSchema(parameters);
  if (p == null || (typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0)) return { type: "object", properties: {} };
  return p;
}

/** parameters as JSON Schema: explicit if the entry gave one, else derived from a read path's
 * {placeholders} (each a required string), else the empty object schema - no hand-typed schema for
 * the declarative common case (the historical Type.Union schema-bug source). */
export function entryParameters(entry: ExtensionEntry): unknown {
  if (entry.parameters !== undefined) return objectSchema(entry.parameters);
  const names = entry.read ? pathPlaceholders(entry.read.path) : [];
  if (names.length === 0) return objectSchema(undefined);
  return { type: "object", properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])), required: names };
}

export function applyPick(value: unknown, pick?: string[]): unknown {
  if (!pick || pick.length === 0) return value;
  const one = (o: unknown) => (o && typeof o === "object" ? Object.fromEntries(pick.filter((k) => k in (o as any)).map((k) => [k, (o as any)[k]])) : o);
  return Array.isArray(value) ? value.map(one) : one(value);
}

export function moduleAuthHeaders(mod: ExtensionModule, secrets: Record<string, string>): Record<string, string> {
  if (!mod.auth) return {};
  const value = secrets[mod.auth.secret];
  return value ? { [mod.auth.header]: value } : {};
}

export async function runRead(ctx: ExtensionContext, mod: ExtensionModule, read: ReadBinding, args: any): Promise<unknown> {
  const res = await ctx.http.get(templatePath(read.path, args), { query: read.query, headers: { ...moduleAuthHeaders(mod, ctx.secrets), ...read.headers } });
  const expect = read.expectStatus ?? [200];
  if (!expect.includes(res.status)) throw new Error(`GET ${read.path} returned ${res.status}, expected ${expect.join("/")} - body: ${res.body.slice(0, 200)}`);
  return applyPick(res.json(), read.pick);
}

export function entrySpec(entry: ExtensionEntry): HostToolSpec {
  return { name: entry.name, kind: entry.kind, label: entry.label ?? entry.name, description: entry.description, parameters: entryParameters(entry) };
}

/** The model writes whatever it wants; `satisfies ExtensionModule` catches most of it at typecheck,
 * but a wrong entry shape still needs a named error - the retry never sees the file (staging is
 * discarded on failure). An operation missing `bind`, or a read without `read.path`, cost three
 * attempts in a live run when the error was only "not a function". */
export function validateEntry(entry: any): asserts entry is ExtensionEntry {
  if (!entry || typeof entry.name !== "string" || typeof entry.description !== "string" || !["tool", "diagnostic", "operation"].includes(entry.kind)) {
    throw new Error(`each entry must be { name, kind: "tool"|"diagnostic"|"operation", description, and one of read/bind/code } - got keys [${Object.keys(entry ?? {}).join(", ")}]`);
  }
  if (entry.kind === "operation") {
    if (typeof entry.bind !== "function") throw new Error(`operation "${entry.name}" needs bind(args) returning a { kind, goal, ... } binding`);
  } else if (entry.read) {
    if (typeof entry.read.path !== "string") throw new Error(`read entry "${entry.name}" needs read.path (a string, e.g. "/api/items/{id}")`);
  } else if (typeof entry.code !== "function") {
    throw new Error(`entry "${entry.name}" needs either read (a declarative GET - preferred) or code(ctx, args)`);
  }
}
