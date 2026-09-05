import { test, expect } from "bun:test";
import { mergeDedup, normalizeUrl, parseOllama, parseSearxng } from "./normalize";

test("normalizeUrl collapses the variants two engines produce for one page", () => {
  expect(normalizeUrl("https://Jellyfin.org/docs/")).toBe("https://jellyfin.org/docs");
  expect(normalizeUrl("https://jellyfin.org/docs/?utm_source=x&fbclid=1#section")).toBe("https://jellyfin.org/docs");
  expect(normalizeUrl("https://jellyfin.org/")).toBe("https://jellyfin.org/");
  expect(normalizeUrl("https://jellyfin.org/docs?page=2")).toBe("https://jellyfin.org/docs?page=2");
  expect(normalizeUrl("not a url")).toBe("not a url");
});

test("parseOllama / parseSearxng tag provenance and give a position prior; entries without url or title are dropped", () => {
  const ollama = parseOllama(JSON.stringify({ results: [{ title: "A", url: "https://a", content: "aa" }, { title: "", url: "https://b" }, { title: "C", url: "https://c" }] }));
  expect(ollama).toEqual([
    { title: "A", url: "https://a", description: "aa", sources: ["ollama"], score: 1 },
    { title: "C", url: "https://c", description: "", sources: ["ollama"], score: 1 / 3 },
  ]);
  expect(parseSearxng(JSON.stringify({ results: [{ title: "A", url: "https://a", content: "x" }] }), "searxng.public:sx.example")).toEqual([
    { title: "A", url: "https://a", description: "x", sources: ["searxng.public:sx.example"], score: 1 },
  ]);
  expect(parseSearxng("{}", "s")).toEqual([]);
});

test("mergeDedup unions provenance, sums scores so corroboration ranks up, and keeps the first description", () => {
  const merged = mergeDedup([
    parseOllama(JSON.stringify({ results: [{ title: "Docs", url: "https://jellyfin.org/docs/", content: "" }, { title: "Only", url: "https://only.example" }] })),
    parseSearxng(JSON.stringify({ results: [{ title: "Other", url: "https://other.example", content: "o" }, { title: "Docs", url: "https://jellyfin.org/docs?utm_source=x", content: "the docs" }] }), "sx"),
  ]);
  expect(merged[0]).toEqual({ title: "Docs", url: "https://jellyfin.org/docs/", description: "the docs", sources: ["ollama", "sx"], score: 1.5 });
  expect(merged.map((r) => r.url)).toEqual(["https://jellyfin.org/docs/", "https://other.example", "https://only.example"]);
});
