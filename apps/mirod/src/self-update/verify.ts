import "./bun-crypto-shim"; // MUST be first - patches node:crypto before @sigstore/* loads
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { getRepo } from "./config";

// Offline Sigstore verification of a release manifest's signing bundle (PLAN.md §5.16 / §5.33). No
// network at install time: the Sigstore public-good trust root is vendored as trusted_root.json
// (regenerated under Node via scripts/fetch-trusted-root.mjs) and read from disk. We deliberately
// use the low-level @sigstore/verify path (not the high-level sigstore.verify() or @sigstore/tuf,
// both Bun-broken), which routes verification through @sigstore/core with the vendored root and
// never touches tuf-js. The EC-digest shim above is load-bearing: without it every verify silently
// fails.

export type ExpectedIdentity = {
  /** OIDC token issuer, e.g. "https://token.actions.githubusercontent.com". */
  issuer: string;
  /** Certificate SAN (the signing workflow URI). Exact string or a RegExp. */
  san: string | RegExp;
};

export type VerifyResult =
  | { ok: true; identity: { san?: string; issuer?: string } }
  | { ok: false; error: string };

/** Verify a Sigstore bundle over `signedData` (the manifest.json bytes) offline against the vendored
 * trust root. Throws are caught and returned as { ok:false } - and @sigstore/core itself fails closed
 * on any crypto error, so a missing shim can only cause false REJECTS, never a false accept. */
export function verifyManifestBundle(
  bundleBytes: Uint8Array | string,
  signedData: Uint8Array,
  expected: ExpectedIdentity,
  trustedRootJson: unknown,
): VerifyResult {
  try {
    const trustMaterial = toTrustMaterial(TrustedRoot.fromJSON(trustedRootJson));
    // GitHub keyless flow: one Rekor entry, one CT-log SCT.
    const verifier = new Verifier(trustMaterial, { tlogThreshold: 1, ctlogThreshold: 1 });
    const bundle = bundleFromJSON(
      JSON.parse(typeof bundleBytes === "string" ? bundleBytes : Buffer.from(bundleBytes).toString("utf8")),
    );
    const entity = toSignedEntity(bundle, Buffer.from(signedData));
    // Throws on any failure: bad sig, untrusted CA, missing/!=threshold tlog, cert-not-valid-at-sign,
    // wrong SAN, wrong issuer, tampered payload.
    const signer = verifier.verify(entity, {
      subjectAlternativeName: expected.san,
      extensions: { issuer: expected.issuer },
    });
    return { ok: true, identity: { san: signer.identity?.subjectAlternativeName, issuer: signer.identity?.extensions?.issuer } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** SAN matcher for a repo's release workflow across all version tags. */
export function releaseWorkflowSan(repo = "bybrooklyn/miro", workflow = ".github/workflows/release.yml"): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // e.g. https://github.com/bybrooklyn/miro/.github/workflows/release.yml@refs/tags/v1.2.3
  return new RegExp(`^https://github\\.com/${esc(repo)}/${esc(workflow)}@refs/tags/v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`);
}

let cachedRoot: unknown;
/** The vendored public-good trust root, read once from beside this module (offline). */
export async function loadTrustedRoot(): Promise<unknown> {
  if (cachedRoot === undefined) {
    cachedRoot = await Bun.file(new URL("./trusted_root.json", import.meta.url)).json();
  }
  return cachedRoot;
}

/** The verify function fetch.ts injects: true iff the manifest's signature AND signer identity (this
 * repo's release workflow, GitHub OIDC issuer) check out. Logs the reason on failure - a rejected
 * update must be diagnosable without leaking anything (the manifest carries no secrets). */
export function makeVerifyManifest(getSetting: (k: string) => string | null): (manifestBytes: Uint8Array, bundleBytes: Uint8Array) => Promise<boolean> {
  const expected: ExpectedIdentity = { issuer: GITHUB_OIDC_ISSUER, san: releaseWorkflowSan(getRepo(getSetting)) };
  return async (manifestBytes, bundleBytes) => {
    const res = verifyManifestBundle(bundleBytes, manifestBytes, expected, await loadTrustedRoot());
    if (!res.ok) console.error(`[self-update] manifest signature verification failed: ${res.error}`);
    return res.ok;
  };
}
