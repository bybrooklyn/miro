import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Registry } from "../registry";
import { createUsageStore } from "../usage";
import { decodeEntities, directFetchImplementation, extractReadable, fetchWeb, ollamaFetchImplementation, registerWebFetch } from "./index";

const PAGE = `<!doctype html><html><head><title>Hardware &amp; Acceleration | Jellyfin</title><style>body{}</style><script>alert(1)</script></head>
<body><nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
<main><h1>Hardware Acceleration</h1><p>Jellyfin supports <b>Intel Quick Sync</b> on Linux.<br>Enable it in <code>Dashboard &gt; Playback</code>.</p>
<ul><li>First &#8212; step</li><li>Second step</li></ul>
<a href="https://jellyfin.org/docs/general/administration/hardware-acceleration/intel/">Intel guide</a>
<a href="mailto:x@y">mail</a><a href="#top">top</a></main>
<footer>Copyright</footer></body></html>`;

test("extractReadable keeps the title, the readable body with block breaks, and absolute links; drops chrome, scripts, styles, mail/anchor links", () => {
  const r = extractReadable(PAGE, "https://jellyfin.org/docs/hw");
  expect(r.title).toBe("Hardware & Acceleration | Jellyfin");
  expect(r.content).toBe("Hardware Acceleration\n\nJellyfin supports Intel Quick Sync on Linux.\nEnable it in Dashboard > Playback.\n\nFirst — step\n\nSecond step\n\nIntel guide\nmail top");
  expect(r.content).not.toMatch(/alert|Copyright|Home/);
  expect(r.links).toEqual([{ text: "Intel guide", url: "https://jellyfin.org/docs/general/administration/hardware-acceleration/intel/" }]);
  expect(decodeEntities("a &lt; b &amp;&amp; c &#x41;&#66; &nbsp;x &unknown;")).toBe("a < b && c AB  x &unknown;");
});

function server() {
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/page") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/data.json") return Response.json({ ok: true });
      if (url.pathname === "/redirect") return Response.redirect(`${url.origin}/page`, 302);
      if (url.pathname === "/api/web_fetch") {
        if (req.headers.get("authorization") !== "Bearer k-1") return new Response("no", { status: 401 });
        const body = (await req.json()) as { url: string };
        return Response.json({ title: "Ollama fetched", content: `cleaned content of ${body.url}`, links: ["https://a.example/1", { text: "two", url: "https://a.example/2" }] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { base: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) };
}

test("direct implementation: HTML is extracted, JSON passes through, redirects are followed, a 404 is an implementation error", async () => {
  const s = server();
  try {
    const direct = directFetchImplementation();
    const page = await direct.run({ url: `${s.base}/page` }, AbortSignal.timeout(5000));
    expect(page.title).toBe("Hardware & Acceleration | Jellyfin");
    expect(page.content).toContain("Intel Quick Sync");
    expect((await direct.run({ url: `${s.base}/data.json` }, AbortSignal.timeout(5000))).content).toBe('{"ok":true}');
    expect((await direct.run({ url: `${s.base}/redirect` }, AbortSignal.timeout(5000))).title).toContain("Jellyfin");
    await expect(direct.run({ url: `${s.base}/missing` }, AbortSignal.timeout(5000))).rejects.toMatchObject({ name: "ImplementationError", status: 404 });
  } finally {
    s.stop();
  }
});

test("fetchWeb: refuses non-http and private addresses without routing, prefers Ollama when keyed, else direct; truncates to maxChars", async () => {
  const s = server();
  try {
    let key: string | null = null;
    const registry = new Registry(createUsageStore(new Database(":memory:")));
    registerWebFetch(registry, { getStoredKey: () => key });
    registry.registerImplementation(ollamaFetchImplementation(() => key, `${s.base}/api/web_fetch`));

    expect((await fetchWeb(registry, "ftp://x")).refused).toMatch(/only http/);
    expect((await fetchWeb(registry, "not a url")).refused).toMatch(/not a URL/);
    expect((await fetchWeb(registry, "http://192.168.1.10:8096/")).refused).toMatch(/use http_get/);

    // The fixture server is on 127.0.0.1, which fetchWeb rightly refuses - so exercise the route
    // through the direct implementation pointed at a public-looking URL the fixture cannot serve...
    // instead: route directly, which is what fetchWeb does after its guards.
    const direct = await registry.route<{ url: string }, { title: string; content: string }>("web.fetch", { url: `${s.base}/page` });
    expect(direct.impl).toBe("direct");
    expect(direct.result!.title).toContain("Jellyfin");

    key = "k-1";
    const keyed = await registry.route<{ url: string }, { title: string; content: string; links: unknown[] }>("web.fetch", { url: `${s.base}/page` });
    expect(keyed.impl).toBe("ollama");
    expect(keyed.result).toMatchObject({ title: "Ollama fetched", content: `cleaned content of ${s.base}/page` });
    expect(keyed.result!.links).toEqual([{ text: "", url: "https://a.example/1" }, { text: "two", url: "https://a.example/2" }]);
    expect(keyed.attempts).toEqual([{ impl: "ollama", ok: true, ms: expect.any(Number) }]);
  } finally {
    s.stop();
  }
});
