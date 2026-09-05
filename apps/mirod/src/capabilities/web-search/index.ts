import { ImplementationError, type Capability, type Implementation, type Policy, type Registry, type RouteResult } from "../registry";
import { mergeDedup, parseOllama, parseSearxng, type WebSearchResult } from "./normalize";

// web.search (PLAN.md §5.14 slice 1): the first capability. Client implementations only - the
// vendored model client can request a provider-hosted search for Anthropic alone (a tool named
// web_search maps onto its builtin), nothing for OpenAI/Codex, so provider-native search is an
// Anthropic note this slice, not a route. Order of preference, from the plan: an Ollama cloud key,
// a self-hosted SearXNG, then a fan-out over public JSON-capable SearXNG nodes.
//
// Public pool, measured rather than assumed (2026-09-05, every instance on searx.space): of 79
// healthy instances, 59 answer `format=json` with 429 (SearXNG's bot limiter blocks it by default)
// and TWO answer JSON. The pool is a last resort that keeps itself refreshed, not a tier to rely on.

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
}

export const WEB_SEARCH: Capability<WebSearchRequest, WebSearchResponse> = {
  id: "web.search",
  isGood: (r) => r.results.length > 0,
};

/** Extension-declared providers (capabilities/extensions.ts, `ext:<app>:web.search`) sit after the
 * self-hosted node and before the public pool: an app the owner runs beats a stranger's node. */
export const WEB_SEARCH_POLICY: Policy = { groups: [["ollama"], ["searxng.selfhosted"], ["ext:*"], ["searxng.public:*"]] };

export const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
export const MAX_RESULTS = 10;

/** Ollama cloud search: an account key (pasted, there is no OAuth to mint one) stored as
 * provider.ollama. Free-tier limits are undocumented; a 429 cools it for the usage store's default. */
export function ollamaImplementation(getKey: () => string | null, url = OLLAMA_SEARCH_URL): Implementation<WebSearchRequest, WebSearchResponse> {
  return {
    id: "ollama",
    capability: WEB_SEARCH.id,
    provider: "ollama",
    meta: { auth: "key", cost: "free" },
    available: () => getKey() !== null,
    async run(req, signal) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${getKey() ?? ""}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: req.query, max_results: Math.min(req.maxResults ?? MAX_RESULTS, MAX_RESULTS) }),
        signal,
      });
      const text = await res.text();
      if (!res.ok) throw new ImplementationError(`ollama web_search: HTTP ${res.status}${text ? ` ${text.slice(0, 120)}` : ""}`, res.status, resetFromHeaders(res.headers));
      return { results: parseOllama(text, "ollama") };
    },
  };
}

/** One SearXNG node - self-hosted (slice 2 sets it up) or a public one from the pool. */
export function searxngImplementation(id: string, baseUrl: string, meta: Implementation<any, any>["meta"], available: () => boolean = () => true): Implementation<WebSearchRequest, WebSearchResponse> {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    id,
    capability: WEB_SEARCH.id,
    provider: `searxng:${new URL(base).host}`,
    meta,
    available,
    async run(req, signal) {
      const res = await fetch(`${base}/search?q=${encodeURIComponent(req.query)}&format=json`, { headers: { Accept: "application/json" }, signal });
      const text = await res.text();
      if (!res.ok) throw new ImplementationError(`${id}: HTTP ${res.status}`, res.status, resetFromHeaders(res.headers));
      let results: WebSearchResult[];
      try {
        results = parseSearxng(text, id);
      } catch {
        // A node with JSON output disabled answers 200 with HTML - a configuration, not a blip.
        throw new ImplementationError(`${id}: not JSON (format=json disabled on this node)`, 200);
      }
      return { results: results.slice(0, req.maxResults ?? MAX_RESULTS) };
    },
  };
}

function resetFromHeaders(headers: Headers): number | undefined {
  const reset = headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset") ?? headers.get("retry-after");
  if (!reset) return undefined;
  const n = Number(reset);
  if (!Number.isFinite(n)) return undefined;
  // Seconds-from-now (Retry-After, RateLimit-Reset) vs an epoch (some x-ratelimit-reset headers).
  return n > 10_000_000 ? (n < 10_000_000_000 ? n * 1000 : n) : Date.now() + n * 1000;
}

// --- the public pool ---

export const SEARX_SPACE_URL = "https://searx.space/data/instances.json";
/** The JSON-capable public nodes found on 2026-09-05 - the seed until the first refresh. */
export const BUNDLED_PUBLIC_NODES = ["https://search.mectov.my.id", "https://sx.xo.st"];
export const PUBLIC_POOL_SETTING = "capabilities.web_search.public_pool";
export const PUBLIC_POOL_MAX = 8;

export interface PublicPool {
  nodes: { url: string; ms: number }[];
  refreshedAt: number;
}

/** Instances worth probing: reachable over the normal internet and answering 200 on searx.space's
 * own check. JSON support is not in the data - it has to be probed. */
export function candidatesFrom(instancesJson: string): string[] {
  const data = JSON.parse(instancesJson) as { instances?: Record<string, { network_type?: string; http?: { status_code?: number } }> };
  return Object.entries(data.instances ?? {})
    .filter(([, v]) => v.network_type === "normal" && v.http?.status_code === 200)
    .map(([url]) => url.replace(/\/+$/, ""));
}

/** Just enough of fetch to be substituted in tests (Bun's `typeof fetch` also demands preconnect). */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Probes one node for real `format=json` support; ms on success, null otherwise. */
export async function probeNode(baseUrl: string, timeoutMs = 8_000, fetchImpl: Fetcher = fetch): Promise<number | null> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/search?q=debian+stable+release&format=json`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = JSON.parse(await res.text()) as { results?: unknown };
    return Array.isArray(body.results) ? Date.now() - started : null;
  } catch {
    return null;
  }
}

/** Rebuilds the public pool from searx.space: probe every candidate (bounded concurrency), keep
 * the JSON-capable ones fastest first. The seeds are always probed too, and are all there is when
 * the list cannot be fetched. Called on the daemon's idle timer and at boot. */
export async function refreshPublicPool(fetchImpl: Fetcher = fetch, concurrency = 12, seeds: string[] = BUNDLED_PUBLIC_NODES): Promise<PublicPool> {
  let candidates: string[];
  try {
    const res = await fetchImpl(SEARX_SPACE_URL, { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json" } });
    candidates = res.ok ? candidatesFrom(await res.text()) : [];
  } catch {
    candidates = [];
  }
  for (const seed of seeds) if (!candidates.includes(seed)) candidates.push(seed);
  const nodes: { url: string; ms: number }[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (i < candidates.length) {
        const url = candidates[i++]!;
        const ms = await probeNode(url, 8_000, fetchImpl);
        if (ms !== null) nodes.push({ url, ms });
      }
    }),
  );
  nodes.sort((a, b) => a.ms - b.ms);
  return { nodes: nodes.slice(0, PUBLIC_POOL_MAX), refreshedAt: Date.now() };
}

export function publicImplementations(pool: PublicPool): Implementation<WebSearchRequest, WebSearchResponse>[] {
  return pool.nodes.map((n) => searxngImplementation(`searxng.public:${new URL(n.url).host}`, n.url, { auth: "none", cost: "free" }));
}

export interface WebSearchDeps {
  getStoredKey: (provider: string) => string | null;
  getSetting: (key: string) => string | null;
}

/** Registers web.search with its policy and the implementations that can be built statically; the
 * public pool is (re)registered by `installPublicPool`. */
export function registerWebSearch(registry: Registry, deps: WebSearchDeps): void {
  registry.registerCapability(WEB_SEARCH, WEB_SEARCH_POLICY);
  registry.registerImplementation(ollamaImplementation(() => deps.getStoredKey("ollama") ?? process.env.OLLAMA_API_KEY ?? null));
  // Slice 2's confirmed docker operation writes this setting; until then an operator can set it.
  const selfHostedUrl = () => deps.getSetting("searxng.base_url") ?? process.env.SEARXNG_URL ?? null;
  registry.registerImplementation({
    ...searxngImplementation("searxng.selfhosted", "http://searxng.invalid", { auth: "none", cost: "self-hosted" }),
    available: () => selfHostedUrl() !== null,
    async run(req: WebSearchRequest, signal: AbortSignal) {
      return searxngImplementation("searxng.selfhosted", selfHostedUrl()!, { auth: "none", cost: "self-hosted" }).run(req, signal);
    },
  });
  installPublicPool(registry, { nodes: BUNDLED_PUBLIC_NODES.map((url) => ({ url, ms: 0 })), refreshedAt: 0 });
}

export function installPublicPool(registry: Registry, pool: PublicPool): void {
  registry.unregisterImplementations("searxng.public:");
  for (const impl of publicImplementations(pool)) registry.registerImplementation(impl);
}

export interface WebSearchAnswer {
  available: boolean;
  results: WebSearchResult[];
  /** Which implementation answered, and what every attempted one did - provenance for the agent
   * and for anyone debugging a bad answer. */
  source: string | null;
  attempts: RouteResult<WebSearchResponse>["attempts"];
}

export async function searchWeb(registry: Registry, query: string, maxResults?: number): Promise<WebSearchAnswer> {
  const routed = await registry.route<WebSearchRequest, WebSearchResponse>(WEB_SEARCH.id, { query, maxResults });
  // ponytail: first-good, no cross-source merge yet - mergeDedup is the upgrade path once two
  // sources answer the same query in one route (a "merge" fan-out mode).
  const results = routed.result ? mergeDedup([routed.result.results]) : [];
  return { available: routed.attempts.length > 0 || registry.implementations(WEB_SEARCH.id).length > 0, results, source: routed.impl, attempts: routed.attempts };
}
