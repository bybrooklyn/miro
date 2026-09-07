import { writeFile } from "node:fs/promises";

// The transport half of self-update (PLAN.md §5.16 slice 2): read GitHub Releases, pick the newest
// one for the active channel above the running version, and download a release asset. Kept separate
// from verify.ts (Sigstore) and fetch.ts (orchestration) so the pure selection logic is unit-tested
// with fixture JSON and the network is a thin edge. Private-repo aware: asset downloads go through
// the API asset URL with an octet-stream Accept and a redirect hop that must NOT carry the token.

export type Channel = "stable" | "beta";

export interface ReleaseAsset {
  name: string;
  id: number;
  /** The api.github.com asset URL - what a private-repo download must hit (browser_download_url 404s). */
  apiUrl: string;
  size: number;
}

export interface Release {
  tag: string;
  /** The tag with a leading `v` stripped - matches the version-dir naming (`/opt/miro/versions/<v>`). */
  version: string;
  prerelease: boolean;
  body: string;
  assets: ReleaseAsset[];
}

export interface GithubDeps {
  repo: string; // "owner/name"
  token: string | null;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const API = "https://api.github.com";

function headers(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "miro-self-update",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Map the GitHub Releases API payload to our shape - pure, so the selection logic is testable. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) return [];
  const out: Release[] = [];
  for (const r of json) {
    if (!r || typeof r !== "object") continue;
    const tag = typeof (r as any).tag_name === "string" ? (r as any).tag_name : null;
    if (!tag) continue;
    if ((r as any).draft === true) continue; // a draft release is not published
    const assets: ReleaseAsset[] = Array.isArray((r as any).assets)
      ? (r as any).assets
          .filter((a: any) => a && typeof a.name === "string" && typeof a.url === "string")
          .map((a: any) => ({ name: a.name, id: Number(a.id), apiUrl: a.url, size: Number(a.size ?? 0) }))
      : [];
    out.push({
      tag,
      version: tag.replace(/^v/, ""),
      prerelease: (r as any).prerelease === true,
      body: typeof (r as any).body === "string" ? (r as any).body : "",
      assets,
    });
  }
  return out;
}

/** Order two semver strings, newest last. Native Bun.semver - no dependency. Unparseable sorts low. */
function order(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b);
  } catch {
    return a === b ? 0 : a < b ? -1 : 1;
  }
}

/** The newest release for this channel strictly above the running version, or null. `stable` excludes
 * prereleases; `beta` includes them. A null currentVersion (a dev run) takes the newest outright. */
export function pickRelease(releases: Release[], channel: Channel, currentVersion: string | null): Release | null {
  const eligible = releases
    .filter((r) => (channel === "stable" ? !r.prerelease : true))
    .filter((r) => currentVersion === null || order(r.version, currentVersion) > 0)
    .sort((a, b) => order(a.version, b.version));
  return eligible.length ? eligible[eligible.length - 1]! : null;
}

/** Find one named asset on a release (the tarball, the manifest, the signature bundle). */
export function assetNamed(release: Release, name: string): ReleaseAsset | null {
  return release.assets.find((a) => a.name === name) ?? null;
}

export async function listReleases(deps: GithubDeps): Promise<Release[]> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${API}/repos/${deps.repo}/releases?per_page=30`, { headers: headers(deps.token) });
  if (!res.ok) throw new Error(`GitHub releases: ${res.status} ${res.statusText}`);
  return parseReleases(await res.json());
}

/** Download a release asset to `destPath`. Private-repo assets require Accept: octet-stream on the API
 * asset URL, which 302s to a signed storage URL that REJECTS the GitHub token - so we follow the
 * redirect by hand and drop the Authorization header on the second hop. */
export async function downloadAsset(deps: GithubDeps, asset: ReleaseAsset, destPath: string): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const first = await f(asset.apiUrl, {
    headers: { ...headers(deps.token), Accept: "application/octet-stream" },
    redirect: "manual",
  });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error(`asset ${asset.name}: ${first.status} with no redirect location`);
    // Second hop to signed storage: no auth header (it would be rejected), plain GET.
    res = await f(location, { headers: { "User-Agent": "miro-self-update" } });
  }
  if (!res.ok) throw new Error(`asset ${asset.name}: ${res.status} ${res.statusText}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}
