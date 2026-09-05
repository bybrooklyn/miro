import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Registry } from "./registry";
import { createUsageStore } from "./usage";
import { registerWebSearch, searchWeb, WEB_SEARCH } from "./web-search";
import { registerWebFetch, WEB_FETCH } from "./web-fetch";
import { extensionImplementations, registerExtensionImplementations } from "./extensions";
import { ensureExtensionsTable, promote, disable } from "../extensions/store";
import type { ExtensionHostManager } from "../extensions/host";

// A promoted extension row in a real :memory: DB whose manifest declares implementations; the host
// manager is the one function boundary substituted - a `call` that answers like the extension host
// would (the real host spawns a subprocess; the routing and normalization here do not need it).

function hostAnswering(answers: Record<string, (args: any) => unknown>, calls: { entry: string; args: unknown }[] = []): ExtensionHostManager {
  return {
    call: async (_dir: string, _app: string, _baseUrl: string, _secrets: Record<string, string>, entry: string, args: unknown) => {
      calls.push({ entry, args });
      const fn = answers[entry];
      if (!fn) throw new Error(`Unknown tool: ${entry}`);
      return fn(args);
    },
  } as unknown as ExtensionHostManager;
}

function promoted(db: Database, app: string, implementsDecls: { capability: string; entry: string }[]) {
  ensureExtensionsTable(db);
  const manifest = { app, displayName: app, baseUrl: "http://127.0.0.1:1", secrets: [], tools: [{ name: "search", kind: "tool", label: "s", description: "d", parameters: {} }], diagnostics: [], operations: [], implements: implementsDecls, version: 1, generatedAt: 0 };
  promote(db, app, JSON.stringify(manifest), 1, manifest.baseUrl);
  return db.query("SELECT * FROM extensions WHERE app = ?").get(app) as any;
}

test("an extension's web.search implementation is registered under ext:<app>:web.search, normalized with provenance, and routed after the self-hosted node", async () => {
  const db = new Database(":memory:");
  const calls: { entry: string; args: unknown }[] = [];
  const host = hostAnswering({ search: (args) => ({ results: [{ title: `hit for ${args.query}`, url: "https://x.example/1" }, { url: "no title" }, { title: "two", url: "https://x.example/2", description: "d2" }] }) }, calls);
  const registry = new Registry(createUsageStore(db));
  registerWebSearch(registry, { getStoredKey: () => null, getSetting: () => null });
  registry.unregisterImplementations("searxng.public:"); // offline here
  const row = promoted(db, "mysearch", [{ capability: "web.search", entry: "search" }]);
  expect(registerExtensionImplementations(registry, row, db, host, () => null)).toEqual(["ext:mysearch:web.search"]);

  const answer = await searchWeb(registry, "debian");
  expect(answer.source).toBe("ext:mysearch:web.search");
  expect(calls).toEqual([{ entry: "search", args: { query: "debian" } }]);
  expect(answer.results.map((r) => [r.title, r.sources[0]])).toEqual([["hit for debian", "ext:mysearch:web.search"], ["two", "ext:mysearch:web.search"]]); // the untitled hit dropped
  expect(answer.results[1]!.description).toBe("d2");
  expect(registry.policy(WEB_SEARCH.id)!.groups).toEqual([["ollama"], ["searxng.selfhosted"], ["ext:*"], ["searxng.public:*"]]);

  // Disabled (a failed pin, a tripped breaker): the implementation drops out on the next route with no unregister.
  disable(db, "mysearch", "test");
  expect((await searchWeb(registry, "debian")).source).toBeNull();
});

test("a web.fetch implementation normalizes links; an unknown capability declaration registers nothing", async () => {
  const db = new Database(":memory:");
  const host = hostAnswering({ read: (args) => ({ title: "T", content: `body of ${args.url}`, links: ["https://a.example/", { text: "b", url: "https://b.example/" }] }) });
  const registry = new Registry(createUsageStore(db));
  registerWebFetch(registry, { getStoredKey: () => null });
  const row = promoted(db, "reader", [{ capability: "web.fetch", entry: "read" }, { capability: "web.mail", entry: "x" }]);
  const impls = extensionImplementations(row, db, host, () => null);
  expect(impls.map((i) => i.id)).toEqual(["ext:reader:web.fetch"]);
  const res = await impls[0]!.run({ url: "https://p.example/page" }, AbortSignal.timeout(1000));
  expect(res).toEqual({ title: "T", content: "body of https://p.example/page", links: [{ text: "", url: "https://a.example/" }, { text: "b", url: "https://b.example/" }] });
  registerExtensionImplementations(registry, row, db, host, () => null);
  expect(registry.policy(WEB_FETCH.id)!.groups).toEqual([["ollama"], ["ext:*"], ["direct"]]);
  const routed = await registry.route<{ url: string }, { title: string }>(WEB_FETCH.id, { url: "https://p.example/page" });
  expect(routed.impl).toBe("ext:reader:web.fetch"); // ahead of the direct fetch
});
