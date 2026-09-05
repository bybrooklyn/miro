import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Registry } from "../registry";
import { createUsageStore } from "../usage";
import { candidatesFrom, installPublicPool, ollamaImplementation, probeNode, refreshPublicPool, registerWebSearch, searchWeb, searxngImplementation, WEB_SEARCH } from "./index";

// A real local HTTP server standing in for the remote APIs (the same fixture style kinds.test.ts
// uses for http.mutation): the request shapes, auth headers, status handling and JSON parsing are
// exercised for real; only the internet is absent.

function server() {
  const seen: { path: string; auth: string | null; body: string }[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"), body: await req.text() });
      if (url.pathname === "/api/web_search") {
        if (req.headers.get("authorization") !== "Bearer k-1") return new Response("unauthorized", { status: 401 });
        return Response.json({ results: [{ title: "Ollama hit", url: "https://a.example/x", content: "from ollama" }] });
      }
      if (url.pathname === "/good/search") return Response.json({ results: [{ title: "SearXNG hit", url: "https://b.example/y", content: "from searxng" }] });
      if (url.pathname === "/empty/search") return Response.json({ results: [] });
      if (url.pathname === "/html/search") return new Response("<html>json disabled</html>", { status: 200, headers: { "content-type": "text/html" } });
      if (url.pathname === "/limited/search") return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "120" } });
      return new Response("nope", { status: 404 });
    },
  });
  return { base: `http://127.0.0.1:${srv.port}`, seen, stop: () => srv.stop(true) };
}

test("ollama implementation: keyed request shape, parsed results, a 401 is an implementation error", async () => {
  const s = server();
  try {
    let key: string | null = "k-1";
    const impl = ollamaImplementation(() => key, `${s.base}/api/web_search`);
    const res = await impl.run({ query: "jellyfin transcoding", maxResults: 50 }, AbortSignal.timeout(5000));
    expect(res.results).toEqual([{ title: "Ollama hit", url: "https://a.example/x", description: "from ollama", sources: ["ollama"], score: 1 }]);
    expect(s.seen[0]).toMatchObject({ path: "/api/web_search", auth: "Bearer k-1" });
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ query: "jellyfin transcoding", max_results: 10 }); // capped
    key = "wrong";
    await expect(impl.run({ query: "x" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ name: "ImplementationError", status: 401 });
    key = null;
    expect(impl.available()).toBe(false);
  } finally {
    s.stop();
  }
});

test("searxng implementation: JSON results, an empty answer, HTML-instead-of-JSON and a 429 with retry-after", async () => {
  const s = server();
  try {
    const good = searxngImplementation("searxng.public:good", `${s.base}/good`, { auth: "none", cost: "free" });
    expect((await good.run({ query: "q" }, AbortSignal.timeout(5000))).results[0]).toMatchObject({ title: "SearXNG hit", sources: ["searxng.public:good"] });
    expect(s.seen.at(-1)!.path).toBe("/good/search?q=q&format=json");
    expect(good.provider).toBe(`searxng:127.0.0.1:${new URL(s.base).port}`);
    const empty = searxngImplementation("e", `${s.base}/empty`, { auth: "none", cost: "free" });
    expect((await empty.run({ query: "q" }, AbortSignal.timeout(5000))).results).toEqual([]);
    const html = searxngImplementation("h", `${s.base}/html`, { auth: "none", cost: "free" });
    await expect(html.run({ query: "q" }, AbortSignal.timeout(5000))).rejects.toThrow(/not JSON/);
    const limited = searxngImplementation("l", `${s.base}/limited`, { auth: "none", cost: "free" });
    const err = await limited.run({ query: "q" }, AbortSignal.timeout(5000)).catch((e) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(err.resetAt).toBeGreaterThan(Date.now() + 100_000);
  } finally {
    s.stop();
  }
});

test("searchWeb routes in the plan's order and reports provenance: ollama first when keyed, then self-hosted, then the public pool", async () => {
  const s = server();
  try {
    const settings: Record<string, string> = {};
    let ollamaKey: string | null = null;
    const registry = new Registry(createUsageStore(new Database(":memory:")));
    registerWebSearch(registry, { getStoredKey: (p) => (p === "ollama" ? ollamaKey : null), getSetting: (k) => settings[k] ?? null });
    // Point the static implementations at the fixture server instead of the internet.
    registry.registerImplementation(ollamaImplementation(() => ollamaKey, `${s.base}/api/web_search`));
    installPublicPool(registry, { nodes: [{ url: `${s.base}/empty`, ms: 1 }, { url: `${s.base}/good`, ms: 2 }], refreshedAt: 0 });

    // No key, no self-hosted URL: only the public pool answers, and the empty node is not an answer.
    const pool = await searchWeb(registry, "jellyfin");
    expect(pool.available).toBe(true);
    expect(pool.source).toMatch(/^searxng\.public:/);
    expect(pool.results[0]).toMatchObject({ title: "SearXNG hit" });
    // The winner is always recorded; the empty node is recorded only if it answered before the
    // winner aborted it - a fan-out loser is not an attempt.
    expect(pool.attempts.find((a) => a.impl === pool.source)).toMatchObject({ ok: true });
    expect(pool.attempts.every((a) => a.ok)).toBe(true);

    // A self-hosted node configured by setting wins over the pool.
    settings["searxng.base_url"] = `${s.base}/good`;
    expect((await searchWeb(registry, "jellyfin")).source).toBe("searxng.selfhosted");

    // A stored Ollama key wins over everything.
    ollamaKey = "k-1";
    const keyed = await searchWeb(registry, "jellyfin");
    expect(keyed.source).toBe("ollama");
    expect(keyed.results[0]).toMatchObject({ title: "Ollama hit", sources: ["ollama"] });
    expect(keyed.attempts).toEqual([{ impl: "ollama", ok: true, ms: expect.any(Number) }]);
  } finally {
    s.stop();
  }
});

test("the public pool: candidates from searx.space's shape, probing for real JSON support, and a refresh that keeps the fastest", async () => {
  const s = server();
  try {
    const instances = JSON.stringify({
      instances: {
        [`${s.base}/good/`]: { network_type: "normal", http: { status_code: 200 } },
        [`${s.base}/html/`]: { network_type: "normal", http: { status_code: 200 } },
        [`${s.base}/limited/`]: { network_type: "normal", http: { status_code: 200 } },
        "https://onion.example/": { network_type: "tor", http: { status_code: 200 } },
        "https://down.example/": { network_type: "normal", http: { status_code: 502 } },
      },
    });
    expect(candidatesFrom(instances)).toEqual([`${s.base}/good`, `${s.base}/html`, `${s.base}/limited`]);
    expect(await probeNode(`${s.base}/good`, 2000)).toBeGreaterThanOrEqual(0);
    expect(await probeNode(`${s.base}/html`, 2000)).toBeNull();
    expect(await probeNode(`${s.base}/limited`, 2000)).toBeNull();
    // A refresh with the list served locally and no bundled seeds - nothing here touches the internet.
    const pool = await refreshPublicPool((url, init) => (url.includes("searx.space") ? Promise.resolve(new Response(instances)) : fetch(url, init)), 4, []);
    expect(pool.nodes.map((n) => n.url)).toEqual([`${s.base}/good`]);
    expect(pool.refreshedAt).toBeGreaterThan(0);
    const registry = new Registry(createUsageStore(new Database(":memory:")));
    registry.registerCapability(WEB_SEARCH, { groups: [["searxng.public:*"]] });
    installPublicPool(registry, pool);
    // The id carries the mount path: two path-mounted nodes on one host are two implementations.
    expect(registry.implementations(WEB_SEARCH.id).map((i) => i.id)).toEqual([`searxng.public:127.0.0.1:${new URL(s.base).port}/good`]);
    installPublicPool(registry, { nodes: [{ url: `${s.base}/good`, ms: 1 }, { url: `${s.base}/good2`, ms: 2 }], refreshedAt: 0 });
    expect(registry.implementations(WEB_SEARCH.id)).toHaveLength(2);
  } finally {
    s.stop();
  }
}, 30_000);
