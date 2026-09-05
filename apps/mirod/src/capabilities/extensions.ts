import type { Database } from "bun:sqlite";
import type { Registry, Implementation } from "./registry";
import type { ExtensionHostManager } from "../extensions/host";
import type { ExtensionManifest } from "../extensions/manifest";
import * as store from "../extensions/store";
import { extensionDir } from "../extensions/paths";
import { resolveSecrets } from "../agent/extension-tools";
import type { WebSearchRequest, WebSearchResponse } from "./web-search";
import type { WebFetchRequest, WebFetchResponse } from "./web-fetch";

// Extension-declared capability implementations (PLAN.md §5.14 slice 3): a learned app that is a
// search engine or a page reader becomes a provider the router can pick, with no core change. The
// entry runs in the extension host like any other tool; the validator already proved it answers in
// the canonical shape (extensions/validate.ts checkCapabilityResult), so the normalizers here only
// fill defaults. Registered whenever the extension's tools are built (agent build, hot-load after
// a promotion); availability is read from the DB on every route, so a disabled extension - a
// failed pin, a tripped circuit breaker - drops out without an explicit unregister.

export const EXTENSION_IMPL_PREFIX = "ext:";

function normalizeSearch(value: unknown, source: string): WebSearchResponse {
  const raw = ((value as { results?: unknown[] })?.results ?? []) as { title?: string; url?: string; description?: string }[];
  const results = raw.filter((r) => r && typeof r.url === "string" && typeof r.title === "string");
  return { results: results.map((r, i) => ({ title: r.title!, url: r.url!, description: r.description ?? "", sources: [source], score: 1 / (i + 1) })) };
}

function normalizeFetch(value: unknown): WebFetchResponse {
  const v = (value ?? {}) as { title?: string; content?: string; links?: (string | { text?: string; url?: string })[] };
  return {
    title: v.title ?? "",
    content: typeof v.content === "string" ? v.content : "",
    links: (v.links ?? []).map((l) => (typeof l === "string" ? { text: "", url: l } : { text: l.text ?? "", url: l.url ?? "" })).filter((l) => l.url),
  };
}

export function extensionImplementations(row: store.ExtensionRecord, db: Database, hostMgr: ExtensionHostManager, getSecret: (ref: string) => string | null): Implementation<any, any>[] {
  const manifest: ExtensionManifest = JSON.parse(row.manifest);
  const dir = extensionDir(manifest.app);
  const provider = `${EXTENSION_IMPL_PREFIX}${manifest.app}`;
  const call = (entry: string, args: unknown) => hostMgr.call(dir, manifest.app, manifest.baseUrl, resolveSecrets(manifest, getSecret), entry, args);
  const available = () => store.getExtension(db, manifest.app)?.state === "enabled";
  return (manifest.implements ?? []).flatMap((decl): Implementation<any, any>[] => {
    const id = `${provider}:${decl.capability}`;
    if (decl.capability === "web.search") {
      return [{ id, capability: "web.search", provider, meta: { auth: "none", cost: "self-hosted" }, available, run: async (req: WebSearchRequest) => normalizeSearch(await call(decl.entry, { query: req.query }), id) }];
    }
    if (decl.capability === "web.fetch") {
      return [{ id, capability: "web.fetch", provider, meta: { auth: "none", cost: "self-hosted" }, available, run: async (req: WebFetchRequest) => normalizeFetch(await call(decl.entry, { url: req.url })) }];
    }
    return [];
  });
}

/** (Re)registers every implementation an enabled extension declares. Idempotent - the same ids
 * replace themselves - so it is safe to call on every agent build. */
export function registerExtensionImplementations(registry: Registry, row: store.ExtensionRecord, db: Database, hostMgr: ExtensionHostManager, getSecret: (ref: string) => string | null): string[] {
  const impls = extensionImplementations(row, db, hostMgr, getSecret);
  for (const impl of impls) registry.registerImplementation(impl);
  return impls.map((i) => i.id);
}
