export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface WebSearchResponse {
  available: boolean;
  results: WebSearchResult[];
}

interface BraveWebSearchResponse {
  web?: { results?: { title: string; url: string; description: string }[] };
}

/** Parses a Brave Web Search API response body into our normalized shape. */
export function parseBraveResponse(json: string): WebSearchResult[] {
  const data = JSON.parse(json) as BraveWebSearchResponse;
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, description: r.description }));
}

// ponytail: Brave only, picked because it's the plan's §18 first fallback behind
// provider-native search (which needs a connected provider we don't have yet, see agent/index.ts).
// Add Tavily/Exa/SearXNG behind the same WebSearchResponse shape if/when needed.
export async function webSearch(query: string): Promise<WebSearchResponse> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return { available: false, results: [] };

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
  // Timeout like every other network path in the daemon - a slow/unreachable Brave endpoint would
  // otherwise hang the whole chat turn with no way to cancel it (audit H3).
  const response = await fetch(url, { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return { available: true, results: [] };
  return { available: true, results: parseBraveResponse(await response.text()) };
}
