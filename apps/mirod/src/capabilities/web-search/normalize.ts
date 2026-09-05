// web.search result normalization (PLAN.md §5.14). Every implementation (Ollama cloud search, a
// SearXNG node, a public-pool node) returns a provider-specific JSON body; these pure functions
// parse each into ONE normalized shape and merge many sources with provenance preserved, deduped,
// and ranked. Pure and unit-tested — the network-touching impls that call these are thin wrappers
// (same pure-vs-shell split the rest of the codebase uses, e.g. inventory/containers.ts).

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  /** Which implementation(s) produced this result — provenance is kept, never flattened away. */
  sources: string[];
  /** Merge score: higher = corroborated by more sources and/or ranked higher by them. */
  score: number;
}

export interface WebSearchResponse {
  available: boolean;
  results: WebSearchResult[];
  /** Per-source outcome, so a caller (and the router's health scoring) can see what actually ran. */
  provenance?: { source: string; ok: boolean; count: number; error?: string }[];
}

// --- provider response shapes (only the fields we read) ---
interface OllamaSearchBody {
  results?: { title?: string; url?: string; content?: string }[];
}
interface SearxngBody {
  results?: { title?: string; url?: string; content?: string }[];
}

/** Normalize a URL for dedup: lowercase host, strip a trailing slash, drop the fragment and common
 * tracking params. Not a canonicalizer — just enough that the same page from two engines collapses. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const drop = /^(utm_|fbclid$|gclid$|ref$|ref_src$)/;
    for (const key of [...u.searchParams.keys()]) if (drop.test(key)) u.searchParams.delete(key);
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/** Ollama `/api/web_search` → normalized results tagged with the source id. */
export function parseOllama(json: string, source = "ollama"): WebSearchResult[] {
  const body = JSON.parse(json) as OllamaSearchBody;
  return fromRaw(body.results, source);
}

/** SearXNG `/search?format=json` → normalized results tagged with the source id. */
export function parseSearxng(json: string, source: string): WebSearchResult[] {
  const body = JSON.parse(json) as SearxngBody;
  return fromRaw(body.results, source);
}

function fromRaw(raw: { title?: string; url?: string; content?: string }[] | undefined, source: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  raw?.forEach((r, i) => {
    if (!r.url || !r.title) return;
    // Rank prior from position: 1.0 for the top hit, decaying down the list, so a result several
    // engines agree on near the top beats a lone deep hit after mergeDedup sums these.
    out.push({ title: r.title, url: r.url, description: r.content ?? "", sources: [source], score: 1 / (i + 1) });
  });
  return out;
}

/** Merge results from many sources: dedup by normalized URL, union the provenance, sum the
 * per-source scores (corroboration ranks a result up), and return sorted by score desc. */
export function mergeDedup(lists: WebSearchResult[][]): WebSearchResult[] {
  const byUrl = new Map<string, WebSearchResult>();
  for (const list of lists) {
    for (const r of list) {
      const key = normalizeUrl(r.url);
      const existing = byUrl.get(key);
      if (existing) {
        existing.score += r.score;
        for (const s of r.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
        if (!existing.description && r.description) existing.description = r.description;
      } else {
        byUrl.set(key, { ...r, sources: [...r.sources] });
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}
