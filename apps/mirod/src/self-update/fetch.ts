import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_ROOT } from "./index";
import { listReleases, downloadAsset, pickRelease, assetNamed, type Channel, type Release } from "./github";
import { parseManifest, sha256File, type UpdateManifest } from "./manifest";

// The orchestration half of self-update slice 2 (PLAN.md §5.16): turn a GitHub release into a staged
// version dir under /opt/miro/versions, gated by a Sigstore signature. checkForUpdate reports what is
// available (verifying the manifest's signature before it trusts the version/summary it shows the
// owner); fetchAndStage downloads the tarball, matches its digest to the signed manifest, unpacks and
// installs it, and leaves it where the existing install_update -> stageUpdate path (slice 1) finds it.

export const MANIFEST_ASSET = "manifest.json";
export const BUNDLE_ASSET = "manifest.json.sigstore";

export interface FetchDeps {
  repo: string;
  token: string | null;
  channel: Channel;
  currentVersion: string | null;
  updateRoot?: string;
  fetchImpl?: typeof fetch;
  /** Verify the manifest's Sigstore bundle offline; true iff signature AND signer identity check out. */
  verify: (manifestBytes: Uint8Array, bundleBytes: Uint8Array) => Promise<boolean>;
  /** Unpack the tarball into a fresh version dir. Injected in tests; defaults to `tar xzf`. */
  unpack?: (tarPath: string, versionDir: string) => Promise<void>;
  /** Install workspace deps in the unpacked tree. Injected in tests; defaults to `bun install`. */
  install?: (versionDir: string) => Promise<void>;
}

export interface AvailableUpdate {
  version: string;
  summary: string;
  notes: string;
  manifest: UpdateManifest;
  release: Release;
}

/** Fetch + verify the manifest for the newest release on this channel above the running version.
 * Returns null when nothing is newer. Throws when a release exists but its signature/manifest is bad -
 * a signed-update system must fail loud on a verification failure, never fall through to "no update". */
export async function checkForUpdate(deps: FetchDeps): Promise<AvailableUpdate | null> {
  const gh = { repo: deps.repo, token: deps.token, fetchImpl: deps.fetchImpl };
  const release = pickRelease(await listReleases(gh), deps.channel, deps.currentVersion);
  if (!release) return null;

  const manifestAsset = assetNamed(release, MANIFEST_ASSET);
  const bundleAsset = assetNamed(release, BUNDLE_ASSET);
  if (!manifestAsset || !bundleAsset) throw new Error(`release ${release.tag} is missing ${MANIFEST_ASSET}/${BUNDLE_ASSET}`);

  const tmp = mkdtempSync(join(tmpdir(), "miro-update-"));
  try {
    const manifestPath = join(tmp, MANIFEST_ASSET);
    const bundlePath = join(tmp, BUNDLE_ASSET);
    await downloadAsset(gh, manifestAsset, manifestPath);
    await downloadAsset(gh, bundleAsset, bundlePath);
    const manifestBytes = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
    const bundleBytes = new Uint8Array(await Bun.file(bundlePath).arrayBuffer());

    if (!(await deps.verify(manifestBytes, bundleBytes))) throw new Error(`release ${release.tag}: signature verification failed`);
    const manifest = parseManifest(manifestBytes);
    if (manifest.version !== release.version) throw new Error(`release ${release.tag}: manifest version ${manifest.version} != tag`);

    return { version: manifest.version, summary: manifest.summary, notes: manifest.notes, manifest, release };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Download, verify, and stage the update as a version dir under /opt/miro/versions. Idempotent: an
 * already-staged version is reported ok without re-downloading. On success the version is ready for
 * install_update -> stageUpdate (slice 1) to swap in and bless/revert. */
export async function fetchAndStage(deps: FetchDeps, available?: AvailableUpdate): Promise<{ ok: boolean; version?: string; reason?: string }> {
  const up = available ?? (await checkForUpdate(deps));
  if (!up) return { ok: false, reason: "no update available on this channel" };

  const versionsDir = join(deps.updateRoot ?? UPDATE_ROOT, "versions");
  const versionDir = join(versionsDir, up.version);
  if (existsSync(versionDir)) return { ok: true, version: up.version }; // already staged

  const gh = { repo: deps.repo, token: deps.token, fetchImpl: deps.fetchImpl };
  const tarAsset = assetNamed(up.release, up.manifest.artifact.name);
  if (!tarAsset) return { ok: false, reason: `release ${up.release.tag} is missing ${up.manifest.artifact.name}` };

  const tmp = mkdtempSync(join(tmpdir(), "miro-update-"));
  const tarPath = join(tmp, up.manifest.artifact.name);
  try {
    await downloadAsset(gh, tarAsset, tarPath);
    const digest = await sha256File(tarPath);
    if (digest !== up.manifest.artifact.sha256) {
      return { ok: false, reason: `artifact digest ${digest.slice(0, 12)} != signed ${up.manifest.artifact.sha256.slice(0, 12)}` };
    }
    // Stage into the version dir. Any failure leaves NO partial dir behind (a half-unpacked version
    // would look staged but crash-loop on boot); build in a temp dir and rename into place last.
    const stagingDir = join(versionsDir, `.staging-${up.version}`);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    try {
      await (deps.unpack ?? defaultUnpack)(tarPath, stagingDir);
      await (deps.install ?? defaultInstall)(stagingDir);
      const { renameSync } = await import("node:fs");
      renameSync(stagingDir, versionDir);
    } catch (e) {
      rmSync(stagingDir, { recursive: true, force: true });
      return { ok: false, reason: `staging ${up.version} failed: ${(e as Error).message}` };
    }
    return { ok: true, version: up.version };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function defaultUnpack(tarPath: string, versionDir: string): Promise<void> {
  const p = Bun.spawn(["tar", "xzf", tarPath, "-C", versionDir], { stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`tar: ${await new Response(p.stderr).text()}`);
}

async function defaultInstall(versionDir: string): Promise<void> {
  // The daemon's own bun (process.execPath) - `bun` is not on a non-interactive PATH on the VM.
  const p = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], { cwd: versionDir, stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`bun install: ${await new Response(p.stderr).text()}`);
}
