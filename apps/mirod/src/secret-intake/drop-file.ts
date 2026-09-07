import { readdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SecretStore } from "../secrets";

// Watched drop-file secret intake (PLAN.md secure-intake slice). A file dropped into
// <MIRO_DIR>/secrets.d/ whose NAME is the ref (e.g. "provider.github", "extension.gluetun.wg_private_key")
// and whose contents are the value is imported into the secret store and shredded - an out-of-band
// way to hand Miro a credential that never touches the agent/model/transcript. Generalizes the
// Codex auth drop-file to any ref. Imported at boot and on any change (a watcher), idempotently.

// A ref is "<namespace>.<name>" - guard against a stray/dotfile or a path-y name landing as a ref.
const REF_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

export function importSecretDropFiles(db: Database, store: SecretStore, dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      if (!REF_RE.test(name)) {
        console.warn(`[mirod] secrets.d: ignoring ${name} - not a valid "<namespace>.<name>" ref`);
        continue;
      }
      const value = readFileSync(path, "utf8").trim();
      if (value) {
        store.setSecret(db, name, value);
        n++;
      }
      rmSync(path, { force: true }); // shred whether empty or imported
    } catch (err) {
      console.error(`[mirod] secrets.d: could not import ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}
