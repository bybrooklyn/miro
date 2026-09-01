import { test, expect } from "bun:test";
import { parseBraveResponse, webSearch } from "./web";

test("parseBraveResponse extracts title/url/description from a Brave Web Search API response", () => {
  const fixture = JSON.stringify({
    web: {
      results: [
        { title: "Jellyfin", url: "https://jellyfin.org", description: "The Free Software Media System" },
      ],
    },
  });
  expect(parseBraveResponse(fixture)).toEqual([
    { title: "Jellyfin", url: "https://jellyfin.org", description: "The Free Software Media System" },
  ]);
});

test("parseBraveResponse returns an empty list when there's no web results block", () => {
  expect(parseBraveResponse("{}")).toEqual([]);
});

test("webSearch reports unavailable without BRAVE_API_KEY (real check, no key in this environment)", async () => {
  expect(await webSearch("jellyfin gpu transcoding")).toEqual({ available: false, results: [] });
});
