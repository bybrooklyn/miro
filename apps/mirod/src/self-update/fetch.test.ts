import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, fetchAndStage, type FetchDeps } from "./fetch";

const tarBytes = new Uint8Array([9, 8, 7, 6, 5]);
const tarSha = new Bun.CryptoHasher("sha256").update(tarBytes).digest("hex");

function manifestJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1, version: "0.2.0", channel: "stable", summary: "faster boot", notes: "full notes here",
    commit: "abc123", artifact: { name: "miro-v0.2.0.tar.gz", sha256: tarSha, size: tarBytes.length }, createdAt: 1,
    ...over,
  });
}

const releases = [{
  tag_name: "v0.2.0", prerelease: false, draft: false, body: "b",
  assets: [
    { name: "miro-v0.2.0.tar.gz", id: 12, url: "https://api.github.com/a/12", size: 5 },
    { name: "manifest.json", id: 10, url: "https://api.github.com/a/10", size: 1 },
    { name: "manifest.json.sigstore", id: 11, url: "https://api.github.com/a/11", size: 1 },
  ],
}];

function fakeFetch(manifest = manifestJson()): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/releases")) return new Response(JSON.stringify(releases), { status: 200 });
    if (u.endsWith("/10")) return new Response(new TextEncoder().encode(manifest), { status: 200 });
    if (u.endsWith("/11")) return new Response(new Uint8Array([0, 1]), { status: 200 });
    if (u.endsWith("/12")) return new Response(tarBytes, { status: 200 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

function deps(over: Partial<FetchDeps> = {}, manifest?: string): FetchDeps {
  return {
    repo: "o/r", token: null, channel: "stable", currentVersion: "0.1.0",
    updateRoot: mkdtempSync(join(tmpdir(), "root-")),
    fetchImpl: fakeFetch(manifest), verify: async () => true,
    unpack: async () => {}, install: async () => {},
    ...over,
  };
}

test("checkForUpdate returns the verified newer release's summary/notes", async () => {
  const up = await checkForUpdate(deps());
  expect(up).toMatchObject({ version: "0.2.0", summary: "faster boot", notes: "full notes here" });
});

test("checkForUpdate fails LOUD on a bad signature - never falls through to no-update", async () => {
  await expect(checkForUpdate(deps({ verify: async () => false }))).rejects.toThrow(/verification failed/);
});

test("checkForUpdate rejects a manifest whose version disagrees with the tag", async () => {
  await expect(checkForUpdate(deps({}, manifestJson({ version: "9.9.9" })))).rejects.toThrow(/!= tag/);
});

test("fetchAndStage: digest match -> unpack + install + version dir appears", async () => {
  let unpacked = false, installed = false;
  const d = deps({
    unpack: async (_tar, dir) => { unpacked = true; mkdirSync(dir, { recursive: true }); },
    install: async () => { installed = true; },
  });
  const res = await fetchAndStage(d);
  expect(res).toEqual({ ok: true, version: "0.2.0" });
  expect(unpacked && installed).toBe(true);
  expect(existsSync(join(d.updateRoot!, "versions", "0.2.0"))).toBe(true);
});

test("fetchAndStage refuses a tarball whose digest != the signed manifest, leaving no dir", async () => {
  const d = deps({}, manifestJson({ artifact: { name: "miro-v0.2.0.tar.gz", sha256: "0".repeat(64), size: 5 } }));
  const res = await fetchAndStage(d);
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/digest/);
  expect(existsSync(join(d.updateRoot!, "versions", "0.2.0"))).toBe(false);
});

test("fetchAndStage is idempotent: an already-staged version is not re-downloaded", async () => {
  let unpacked = false;
  const d = deps({ unpack: async () => { unpacked = true; } });
  mkdirSync(join(d.updateRoot!, "versions", "0.2.0"), { recursive: true });
  const res = await fetchAndStage(d);
  expect(res).toEqual({ ok: true, version: "0.2.0" });
  expect(unpacked).toBe(false); // no staging work
});
