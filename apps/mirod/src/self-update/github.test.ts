import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleases, pickRelease, assetNamed, downloadAsset, type Release } from "./github";

const REL_JSON = [
  { tag_name: "v0.2.0", prerelease: false, draft: false, body: "notes 2", assets: [
    { name: "miro-v0.2.0.tar.gz", id: 1, url: "https://api.github.com/repos/o/r/releases/assets/1", size: 100 },
    { name: "manifest.json", id: 2, url: "https://api.github.com/repos/o/r/releases/assets/2", size: 10 },
  ] },
  { tag_name: "v0.3.0-beta.1", prerelease: true, draft: false, body: "beta", assets: [] },
  { tag_name: "v0.1.0", prerelease: false, draft: false, body: "notes 1", assets: [] },
  { tag_name: "v9.9.9", prerelease: false, draft: true, body: "draft - unpublished", assets: [] },
];

test("parseReleases maps fields, strips the v, skips drafts", () => {
  const rels = parseReleases(REL_JSON);
  expect(rels.map((r) => r.version)).toEqual(["0.2.0", "0.3.0-beta.1", "0.1.0"]); // v9.9.9 draft dropped
  expect(rels[0]!.assets[0]).toMatchObject({ name: "miro-v0.2.0.tar.gz", apiUrl: "https://api.github.com/repos/o/r/releases/assets/1" });
  expect(parseReleases({}).length).toBe(0);
});

test("pickRelease: stable ignores prereleases and picks newest above current", () => {
  const rels = parseReleases(REL_JSON);
  expect(pickRelease(rels, "stable", "0.1.0")?.version).toBe("0.2.0");
  expect(pickRelease(rels, "stable", "0.2.0")).toBeNull(); // nothing stable newer
  expect(pickRelease(rels, "beta", "0.2.0")?.version).toBe("0.3.0-beta.1"); // beta sees the prerelease
  expect(pickRelease(rels, "stable", null)?.version).toBe("0.2.0"); // dev/no-version takes newest stable
});

test("assetNamed finds the tarball and manifest", () => {
  const rel = parseReleases(REL_JSON)[0]!;
  expect(assetNamed(rel, "manifest.json")?.id).toBe(2);
  expect(assetNamed(rel, "nope.bin")).toBeNull();
});

test("downloadAsset follows the API->storage redirect and drops the token on the second hop", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    seen.push({ url: u, auth });
    if (u.includes("api.github.com")) {
      return new Response(null, { status: 302, headers: { location: "https://storage.example/signed-blob" } });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  const dest = join(dir, "out.tar.gz");
  const asset = { name: "x.tar.gz", id: 1, apiUrl: "https://api.github.com/repos/o/r/releases/assets/1", size: 3 };
  await downloadAsset({ repo: "o/r", token: "ghp_secret", fetchImpl }, asset, dest);

  expect(Array.from(readFileSync(dest))).toEqual([1, 2, 3]);
  expect(seen[0]!.auth).toBe("Bearer ghp_secret"); // API hop carries the token
  expect(seen[1]!.url).toBe("https://storage.example/signed-blob");
  expect(seen[1]!.auth).toBeNull(); // storage hop must NOT
});
