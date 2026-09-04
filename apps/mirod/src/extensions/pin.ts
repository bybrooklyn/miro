import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as store from "./store";

// Hash-pinning of promoted extensions (PLAN.md §5.15 "hide the judge": tool poisoning / rug pull).
// The code the validator passed is the code that runs: extension.ts + manifest are hashed at
// promotion and re-checked before every host call. A mismatch disables the extension outright -
// it is never repaired into trust, because the validator never saw what is on disk now.

export class PinMismatchError extends Error {
  constructor(app: string) {
    super(`refused: extension "${app}"'s code on disk does not match what was validated and promoted - disabled; re-learn it to re-validate`);
    this.name = "PinMismatchError";
  }
}

/** sha256 over the two files the validator judged. Throws if either is missing. */
export function hashExtension(dir: string): string {
  const hash = createHash("sha256");
  for (const file of ["extension.ts", "manifest"]) hash.update(readFileSync(join(dir, file)));
  return hash.digest("hex");
}

/** Before running any promoted code: the on-disk hash must equal the promoted one. An extension
 * promoted before pinning existed (contentHash null) is pinned as it stands - the migration window's
 * first-seen-is-trusted, since its code was validated the same way, just never recorded. */
export function assertPinned(db: Database, app: string, dir: string): void {
  const record = store.getExtension(db, app);
  if (!record || record.state !== "enabled") return; // nothing to protect; the caller's own checks apply
  const actual = hashExtension(dir);
  if (record.contentHash === null) {
    store.setContentHash(db, app, actual);
    return;
  }
  if (record.contentHash !== actual) {
    store.disable(db, app, "content hash mismatch: extension.ts/manifest changed after promotion");
    throw new PinMismatchError(app);
  }
}
