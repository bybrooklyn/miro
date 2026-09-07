import { test, expect } from "bun:test";
import { X509Certificate } from "node:crypto";
import { verifyManifestBundle, GITHUB_OIDC_ISSUER } from "./verify";

// Proves the whole offline verify path under Bun (crypto shim + trust material + cert chain + SCT +
// Rekor SET + identity policy + tamper detection) against a REAL GitHub-Actions keyless bundle - npm's
// own provenance attestation for sigstore-js, checked in as verify-fixture.json. It carries
// sigstore-js's workflow identity, not Miro's, so it proves the machinery, not Miro's exact SAN regex
// (that is Tier-2, live-verified in CI on the first real release, PLAN.md §5.33). No network, no OIDC.

const fixture = await Bun.file(new URL("./verify-fixture.json", import.meta.url)).json();
const trustedRootJson = await Bun.file(new URL("./trusted_root.json", import.meta.url)).json();
const bundle = fixture.attestations.find((a: any) => a.predicateType === "https://slsa.dev/provenance/v1").bundle;

const cert = new X509Certificate(Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64"));
const realSan = (cert.subjectAltName ?? "").replace(/^URI:/, "");
const exactSan = new RegExp("^" + realSan.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
const NO_DATA = new Uint8Array(); // a DSSE bundle embeds its payload; toSignedEntity ignores this arg

test("a real keyless bundle verifies offline under Bun for the correct identity", () => {
  const res = verifyManifestBundle(JSON.stringify(bundle), NO_DATA, { issuer: GITHUB_OIDC_ISSUER, san: exactSan }, trustedRootJson);
  expect(res.ok).toBe(true);
});

test("verification fails for a wrong SAN", () => {
  const res = verifyManifestBundle(JSON.stringify(bundle), NO_DATA, { issuer: GITHUB_OIDC_ISSUER, san: /^https:\/\/github\.com\/attacker\/evil.*$/ }, trustedRootJson);
  expect(res.ok).toBe(false);
});

test("verification fails for a wrong issuer", () => {
  const res = verifyManifestBundle(JSON.stringify(bundle), NO_DATA, { issuer: "https://accounts.google.com", san: exactSan }, trustedRootJson);
  expect(res.ok).toBe(false);
});

test("verification fails when the signed payload is tampered", () => {
  const tampered = structuredClone(bundle);
  const p = Buffer.from(tampered.dsseEnvelope.payload, "base64");
  p[0] ^= 0xff;
  tampered.dsseEnvelope.payload = p.toString("base64");
  const res = verifyManifestBundle(JSON.stringify(tampered), NO_DATA, { issuer: GITHUB_OIDC_ISSUER, san: exactSan }, trustedRootJson);
  expect(res.ok).toBe(false);
});
