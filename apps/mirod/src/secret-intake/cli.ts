import { Database } from "bun:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIRO_DIR, DB_PATH } from "@miro/protocol";
import { createSecretStore } from "../secrets";

// `mirod secret set <ref> [--file <path>]` - store a credential WITHOUT the value ever passing
// through the agent, the model, or the transcript (PLAN.md secure-intake slice). The value comes
// from --file, else stdin, else $MIRO_SECRET_VALUE. A one-shot command: it does the write and
// returns true so the caller exits BEFORE the daemon boots. Opens its own short-lived DB handle
// (WAL, so it's safe alongside a running daemon) and the same machine-local key file, so the
// ciphertext it writes is exactly what the daemon reads back.
export async function maybeRunSecretCli(): Promise<boolean> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "secret" || argv[1] !== "set") return false;
  const ref = argv[2];
  if (!ref) {
    console.error("usage: mirod secret set <ref> [--file <path>]   (value from --file, else stdin, else $MIRO_SECRET_VALUE)");
    process.exit(2);
  }
  const fileIdx = argv.indexOf("--file");
  let value: string;
  if (fileIdx !== -1 && argv[fileIdx + 1]) value = readFileSync(argv[fileIdx + 1]!, "utf8");
  else if (process.env.MIRO_SECRET_VALUE) value = process.env.MIRO_SECRET_VALUE;
  else value = await Bun.stdin.text();
  value = value.trim();
  if (!value) {
    console.error(`no value provided for ${ref}`);
    process.exit(2);
  }
  mkdirSync(MIRO_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  const store = createSecretStore(join(MIRO_DIR, "secret.key"));
  store.ensureTable(db);
  store.setSecret(db, ref, value);
  db.close();
  console.log(`stored ${ref} (${value.length} chars)`);
  return true;
}
