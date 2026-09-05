import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Registry } from "../registry";
import { createUsageStore } from "../usage";
import { clientRedirectOf, decodeEntities, directFetchImplementation, extractReadable, fetchWeb, ollamaFetchImplementation, registerWebFetch } from "./index";

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
      // The jellyfin.org shape: an empty document whose canonical link and JS assignment name the real page.
      if (url.pathname === "/moved") return new Response(`<!doctype html><html><head><link rel="canonical" href="/page" /></head><script>window.location.href = '/page' + window.location.search;</script></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/refresh") return new Response(`<html><head><meta http-equiv="refresh" content="0; url=/moved"></head><body></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/loop") return new Response(`<html><head><meta http-equiv="refresh" content="0; url=/loop2"></head></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/loop2") return new Response(`<html><head><meta http-equiv="refresh" content="0; url=/loop"></head></html>`, { headers: { "content-type": "text/html" } });
      // SSRF shapes: a 302 into a private address, and an empty stub whose canonical link names one.
      if (url.pathname === "/to-private") return Response.redirect("http://127.0.0.1:9/admin", 302);
      if (url.pathname === "/canonical-private") return new Response(`<!doctype html><html><head><link rel="canonical" href="http://10.0.0.5:8096/System/Info" /></head></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/hops") return Response.redirect(`${url.origin}/hops`, 302);
      if (url.pathname === "/big") return new Response("x".repeat(3_000_000), { headers: { "content-type": "text/plain" } });
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
    // The fixture is on loopback, which the real guard refuses on every hop - so the happy paths
    // run with the guard off; the SSRF test below runs with it on.
    const direct = directFetchImplementation(() => false);
    const page = await direct.run({ url: `${s.base}/page` }, AbortSignal.timeout(5000));
    expect(page.title).toBe("Hardware & Acceleration | Jellyfin");
    expect(page.content).toContain("Intel Quick Sync");
    expect((await direct.run({ url: `${s.base}/data.json` }, AbortSignal.timeout(5000))).content).toBe('{"ok":true}');
    expect((await direct.run({ url: `${s.base}/redirect` }, AbortSignal.timeout(5000))).title).toContain("Jellyfin");
    await expect(direct.run({ url: `${s.base}/missing` }, AbortSignal.timeout(5000))).rejects.toMatchObject({ name: "ImplementationError", status: 404 });
    // Client-side redirects: an empty JS/canonical stub, a meta refresh chain, and a loop that ends after the hop cap.
    expect((await direct.run({ url: `${s.base}/moved` }, AbortSignal.timeout(5000))).title).toContain("Jellyfin");
    expect((await direct.run({ url: `${s.base}/refresh` }, AbortSignal.timeout(5000))).content).toContain("Intel Quick Sync");
    expect((await direct.run({ url: `${s.base}/loop` }, AbortSignal.timeout(5000))).content).toBe("");
    // A server-side redirect loop ends at the hop cap; a 3MB body is read to the cap, not whole.
    await expect(direct.run({ url: `${s.base}/hops` }, AbortSignal.timeout(5000))).rejects.toThrow(/more than 8 redirects/);
    expect((await direct.run({ url: `${s.base}/big` }, AbortSignal.timeout(5000))).content).toHaveLength(1_000_000);
  } finally {
    s.stop();
  }
});

test("a redirect - HTTP or client-side - into a local or private address is refused, never fetched (SSRF)", async () => {
  const s = server();
  try {
    const direct = directFetchImplementation(); // the real guard
    await expect(direct.run({ url: `${s.base}/to-private` }, AbortSignal.timeout(5000))).rejects.toThrow(/redirects to http:\/\/127\.0\.0\.1:9\/admin, a local or private address/);
    await expect(direct.run({ url: `${s.base}/canonical-private` }, AbortSignal.timeout(5000))).rejects.toThrow(/redirects to http:\/\/10\.0\.0\.5:8096\/System\/Info/);
  } finally {
    s.stop();
  }
});

test("clientRedirectOf reads meta refresh, a differing canonical, and JS location assignments; ignores a self-canonical", () => {
  expect(clientRedirectOf(`<meta http-equiv="refresh" content="0; url=/new">`, "https://a.example/old")).toBe("https://a.example/new");
  expect(clientRedirectOf(`<link rel="canonical" href="https://a.example/old/" />`, "https://a.example/old")).toBe("https://a.example/old/");
  expect(clientRedirectOf(`<link rel="canonical" href="https://a.example/old" />`, "https://a.example/old")).toBeNull();
  expect(clientRedirectOf(`<script>window.location.href = '/x' + window.location.search;</script>`, "https://a.example/old")).toBe("https://a.example/x");
  expect(clientRedirectOf(`<script>location.replace("https://b.example/y")</script>`, "https://a.example/old")).toBe("https://b.example/y");
  expect(clientRedirectOf(`<p>nothing here</p>`, "https://a.example/old")).toBeNull();
  expect(clientRedirectOf(`<meta http-equiv="refresh" content="0; url=javascript:alert(1)">`, "https://a.example/old")).toBeNull();
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

    // The fixture server is on loopback, so fetchWeb's own entry guard is turned off for the rest.
    const direct = await fetchWeb(registry, `${s.base}/page`, 40, () => false);
    expect(direct.source).toBe("direct");
    expect(direct.title).toContain("Jellyfin");
    expect(direct.content).toHaveLength(40);
    expect(direct.truncated).toBe(true);
    const whole = await fetchWeb(registry, `${s.base}/page`, undefined, () => false);
    expect(whole.truncated).toBe(false);
    expect(whole.content).toContain("Intel Quick Sync");

    key = "k-1";
    const keyed = await fetchWeb(registry, `${s.base}/page`, undefined, () => false);
    expect(keyed.source).toBe("ollama");
    expect(keyed).toMatchObject({ title: "Ollama fetched", content: `cleaned content of ${s.base}/page` });
    expect(keyed.links).toEqual([{ text: "", url: "https://a.example/1" }, { text: "two", url: "https://a.example/2" }]);
    expect(keyed.attempts).toEqual([{ impl: "ollama", ok: true, ms: expect.any(Number) }]);
  } finally {
    s.stop();
  }
});
