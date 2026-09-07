// Vendor the Sigstore public-good trust root that the daemon verifies against offline. Run occasionally
// (only when Sigstore rotates its root - rare, announced), MUST run under Node: tuf-js is Bun-broken
// (crypto.verify(null,...) on EC keys, §5.33). The output is checked in and read offline forever after.
//
//   node scripts/fetch-trusted-root.mjs > apps/mirod/src/self-update/trusted_root.json
import { getTrustedRoot } from "@sigstore/tuf";
import { TrustedRoot } from "@sigstore/protobuf-specs";

const root = await getTrustedRoot({ force: true }); // one network call to tuf-repo-cdn.sigstore.dev
process.stdout.write(JSON.stringify(TrustedRoot.toJSON(root), null, 2) + "\n");
