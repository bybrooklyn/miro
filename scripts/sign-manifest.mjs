// Sign dist/manifest.json into dist/manifest.json.sigstore. Run in CI under Node with ambient GitHub
// OIDC (permissions: id-token: write). Produces a messageSignature bundle over the manifest bytes.
// Node, not Bun: the sigstore/tuf JS is Bun-broken (crypto.verify(null,...) on EC keys, §5.33).
import { sign } from "sigstore";
import { readFileSync, writeFileSync } from "node:fs";

// Paths via env so this can run from an isolated dir (sigstore is installed there, away from the repo's
// Bun `workspace:*` package.json that npm cannot parse). Defaults keep it runnable from the repo root.
const manifestPath = process.env.MANIFEST ?? "dist/manifest.json";
const bundlePath = process.env.BUNDLE ?? "dist/manifest.json.sigstore";

const manifest = readFileSync(manifestPath); // the exact bytes the daemon verifies
// sign() defaults to CIContextProvider (reads ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN) and to
// tlogUpload:true, so the bundle carries the inline Rekor entry the daemon verifies offline. This
// also publishes the signing cert (repo, workflow, tag, commit) to the PUBLIC Rekor log - see §5.33.
const bundle = await sign(manifest);
writeFileSync(bundlePath, JSON.stringify(bundle));
console.log(`wrote ${bundlePath}`);
