import { readFileSync } from "node:fs";
import { verifyManifestBundle, GITHUB_OIDC_ISSUER, releaseWorkflowSan, loadTrustedRoot } from "./verify";
import { DEFAULT_REPO } from "./config";

// `mirod verify-manifest <manifest.json> <manifest.json.sigstore>` - the installer's signature gate
// (PLAN.md deploy-anywhere slice). install.sh cannot verify a release before unpacking it, because the
// verifier's own @sigstore/* dependencies live inside the release it is checking; so it unpacks with
// --ignore-scripts, installs, and then calls this before anything is started or symlinked. Exits 0 only
// on a good signature from this repo's release workflow.
//
// It lives beside verify.ts and is dispatched from index.ts with the other CLIs so it inherits the
// "bun-crypto-shim must be imported first" ordering that verify.ts depends on - a standalone script
// that got that wrong would fail closed, but confusingly.
export async function maybeRunVerifyManifestCli(): Promise<boolean> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "verify-manifest") return false;
  const [, manifestPath, bundlePath] = argv;
  if (!manifestPath || !bundlePath) {
    console.error("usage: mirod verify-manifest <manifest.json> <manifest.json.sigstore>");
    process.exit(2);
  }
  // The repo is read from the environment rather than the settings DB: the installer runs this before
  // any daemon state exists, and the expected signer identity must not be settable by a half-installed box.
  const repo = process.env.MIRO_UPDATE_REPO ?? DEFAULT_REPO;
  const res = verifyManifestBundle(
    readFileSync(bundlePath),
    readFileSync(manifestPath),
    { issuer: GITHUB_OIDC_ISSUER, san: releaseWorkflowSan(repo) },
    await loadTrustedRoot(),
  );
  if (!res.ok) {
    console.error(`signature verification FAILED: ${res.error}`);
    process.exit(1);
  }
  console.log(`signature OK - signed by ${res.identity.san ?? "?"} via ${res.identity.issuer ?? "?"}`);
  return true;
}
