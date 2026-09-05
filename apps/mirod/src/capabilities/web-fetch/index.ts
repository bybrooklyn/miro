import { ImplementationError, type Capability, type Implementation, type Policy, type Registry, type RouteResult } from "../registry";
import { isLocalOrPrivateUrl, redactSecretsInText } from "../../operations/classify";

// web.fetch (PLAN.md §5.14 slice 2): a public web page as readable text, for research. Two
// implementations: Ollama cloud's web_fetch (cleaned content, links - when a key is on file) and a
// direct fetch with a readable-text extraction of our own. Public URLs only - a local or private
// address belongs to http_get, which carries credentials by reference; this never does.

export interface WebFetchRequest {
  url: string;
}

export interface WebFetchResponse {
  title: string;
  content: string;
  links: { text: string; url: string }[];
}

export const WEB_FETCH: Capability<WebFetchRequest, WebFetchResponse> = {
  id: "web.fetch",
  isGood: (r) => r.content.trim().length > 0,
};

export const WEB_FETCH_POLICY: Policy = { groups: [["ollama"], ["direct"]] };
export const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";
/** Bytes read from a page before extraction; pages past this are truncated, not refused. */
export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_LINKS = 50;
/** What the tool returns by default - enough of a docs page to answer from, not the whole site. */
export const DEFAULT_MAX_CHARS = 20_000;

export function ollamaFetchImplementation(getKey: () => string | null, url = OLLAMA_FETCH_URL): Implementation<WebFetchRequest, WebFetchResponse> {
  return {
    id: "ollama",
    capability: WEB_FETCH.id,
    provider: "ollama",
    meta: { auth: "key", cost: "free" },
    available: () => getKey() !== null,
    async run(req, signal) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${getKey() ?? ""}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: req.url }),
        signal,
      });
      const text = await res.text();
      if (!res.ok) throw new ImplementationError(`ollama web_fetch: HTTP ${res.status}`, res.status);
      const body = JSON.parse(text) as { title?: string; content?: string; links?: (string | { text?: string; url?: string })[] };
      return {
        title: body.title ?? "",
        content: body.content ?? "",
        links: (body.links ?? []).slice(0, MAX_LINKS).map((l) => (typeof l === "string" ? { text: "", url: l } : { text: l.text ?? "", url: l.url ?? "" })).filter((l) => l.url),
      };
    },
  };
}

export function directFetchImplementation(): Implementation<WebFetchRequest, WebFetchResponse> {
  return {
    id: "direct",
    capability: WEB_FETCH.id,
    provider: "direct",
    meta: { auth: "none", cost: "free" },
    available: () => true,
    timeoutMs: 15_000,
    async run(req, signal) {
      // Client-side redirects (a meta refresh, a canonical link, `window.location.href = ...`) are how
      // docs sites move pages - found live: jellyfin.org's hardware-acceleration URL is a 448-byte JS
      // stub whose real page is 40KB. An empty body with such a pointer is followed, a few hops at most.
      let url = req.url;
      for (let hop = 0; ; hop++) {
        const res = await fetch(url, { headers: { Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", "User-Agent": "Miro/0.0 (+self-hosted server agent)" }, redirect: "follow", signal });
        if (!res.ok) throw new ImplementationError(`GET ${url}: HTTP ${res.status}`, res.status);
        const raw = await res.text();
        const body = raw.length > MAX_PAGE_BYTES ? raw.slice(0, MAX_PAGE_BYTES) : raw;
        const type = res.headers.get("content-type") ?? "";
        if (!(/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body))) return { title: "", content: body, links: [] };
        const landed = res.url || url;
        const page = extractReadable(body, landed);
        if (page.content.length > 0 || hop >= MAX_CLIENT_REDIRECTS) return page;
        const next = clientRedirectOf(body, landed);
        if (!next || next === landed) return page;
        url = next;
      }
    },
  };
}

export const MAX_CLIENT_REDIRECTS = 3;

/** Where an empty page says its content really is: a meta refresh, a canonical link that differs
 * from the page's own URL, or a plain JS location assignment. Null when there is no such pointer. */
export function clientRedirectOf(html: string, pageUrl: string): string | null {
  const candidates = [
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"'\s;]+)/i.exec(html)?.[1],
    /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1],
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(html)?.[1],
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']/i.exec(html)?.[1],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const resolved = new URL(candidate, pageUrl).toString();
      if (resolved !== new URL(pageUrl).toString() && /^https?:/.test(resolved)) return resolved;
    } catch {
      // not a URL
    }
  }
  return null;
}

const DROP_BLOCKS = /<(script|style|noscript|svg|template|head|nav|header|footer|aside|iframe)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|blockquote|pre|hr|dt|dd|dl|figure|figcaption|main)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → the text a reader would keep: the page's title, the body with script/style/navigation
 * chrome dropped and block boundaries kept as line breaks, and its links made absolute. Not a
 * readability algorithm (ponytail: no scoring of content density) - enough for docs pages, release
 * notes and issue threads, which is what a sysadmin fetches. */
export function extractReadable(html: string, baseUrl: string): WebFetchResponse {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  // Links and text come from the same chrome-stripped body: a navigation bar's links are noise.
  const stripped = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html).replace(DROP_BLOCKS, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const links: { text: string; url: string }[] = [];
  for (const m of stripped.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break;
    const href = m[1]!.trim();
    if (/^(javascript:|mailto:|#)/i.test(href)) continue;
    try {
      links.push({ text: decodeEntities(m[2]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(), url: new URL(href, baseUrl).toString() });
    } catch {
      // an unparseable href is not a link worth keeping
    }
  }
  const body = stripped
    .replace(BLOCK_TAGS, "\n")
    // An opening inline tag becomes a space (adjacent <a>x</a><a>y</a> must not merge), a closing
    // one nothing (a space would land before the period in "<code>Playback</code>.").
    .replace(/<\/[^>]+>/g, "")
    .replace(/<[^>]+>/g, " ");
  const content = decodeEntities(body)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, content, links };
}

export interface WebFetchDeps {
  getStoredKey: (provider: string) => string | null;
}

export function registerWebFetch(registry: Registry, deps: WebFetchDeps): void {
  registry.registerCapability(WEB_FETCH, WEB_FETCH_POLICY);
  registry.registerImplementation(ollamaFetchImplementation(() => deps.getStoredKey("ollama") ?? process.env.OLLAMA_API_KEY ?? null));
  registry.registerImplementation(directFetchImplementation());
}

export interface WebFetchAnswer {
  available: boolean;
  refused?: string;
  title: string;
  content: string;
  truncated: boolean;
  links: { text: string; url: string }[];
  source: string | null;
  attempts: RouteResult<WebFetchResponse>["attempts"];
}

export async function fetchWeb(registry: Registry, url: string, maxChars = DEFAULT_MAX_CHARS): Promise<WebFetchAnswer> {
  const empty = { title: "", content: "", truncated: false, links: [], source: null, attempts: [] };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { available: true, refused: `${url} is not a URL`, ...empty };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { available: true, refused: `${url}: only http(s) can be fetched`, ...empty };
  if (isLocalOrPrivateUrl(url)) return { available: true, refused: `${url} is a local or private address - use http_get for that`, ...empty };
  const routed = await registry.route<WebFetchRequest, WebFetchResponse>(WEB_FETCH.id, { url });
  if (!routed.result) return { available: registry.implementations(WEB_FETCH.id).length > 0, ...empty, attempts: routed.attempts };
  const content = redactSecretsInText(routed.result.content);
  return {
    available: true,
    title: routed.result.title,
    content: content.length > maxChars ? content.slice(0, maxChars) : content,
    truncated: content.length > maxChars,
    links: routed.result.links,
    source: routed.impl,
    attempts: routed.attempts,
  };
}
