// Bun's node:crypto (BoringSSL) rejects crypto.verify(null/undefined, data, ecKey, sig) with
// NO_DEFAULT_DIGEST, whereas Node infers the digest from the EC curve. Sigstore's Rekor SET
// verification (@sigstore/core) and tuf-js both call verify() with no explicit digest for ECDSA
// keys, so bundle verification silently fails CLOSED under Bun (found live, PLAN.md §5.33). This
// shim supplies the digest Node would have inferred, and ONLY when the algorithm is absent and the
// key is EC - otherwise a pure pass-through (ed25519 MUST keep null). Import once, before any
// sigstore code runs (verify.ts does, as its first import).
//
// ponytail: monkeypatch of a global, guarded to the exact null-algo+EC case Node already handles.
// Upgrade path: drop it if Bun starts inferring EC digests, or vendor @sigstore/core.
import crypto, { KeyObject } from "node:crypto";

const CURVE_DIGEST: Record<string, string> = {
  prime256v1: "sha256", // P-256 (Fulcio, Rekor public-good)
  secp384r1: "sha384", // P-384
  secp521r1: "sha512", // P-521
};

function keyObjectOf(key: unknown): KeyObject | undefined {
  if (key instanceof KeyObject) return key;
  if (key && typeof key === "object" && (key as any).key instanceof KeyObject) {
    return (key as any).key;
  }
  return undefined;
}

const orig = crypto.verify;
const patched: typeof crypto.verify = function (
  this: unknown,
  algorithm: any,
  data: any,
  key: any,
  signature: any,
  callback?: any,
) {
  if (algorithm == null) {
    const ko = keyObjectOf(key);
    if (ko?.asymmetricKeyType === "ec") {
      const curve = (ko.asymmetricKeyDetails as any)?.namedCurve as string | undefined;
      algorithm = CURVE_DIGEST[curve ?? ""] ?? "sha256";
    }
  }
  return (orig as any).call(crypto, algorithm, data, key, signature, callback);
} as any;

Object.defineProperty(crypto, "verify", { value: patched, writable: true, configurable: true });

export {}; // side-effecting module
