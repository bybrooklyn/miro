import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MIRO_DIR } from "@miro/protocol";
import { run, commandExists } from "../inventory/exec";
import { BACKUP_DIR } from "./index";

// Agent-driven restore (PLAN.md config-backup slice). On a fresh box, mirod boots with empty state;
// this tool imports Miro's OWN state directly (trusted code) and re-establishes secrets, then hands
// the backed-up server configs back to the agent as a reconstruction goal - the agent replays them
// through the normal operation engine (file_write each config -> docker compose up -> systemctl
// enable), which is why the config files are returned rather than written here.

const RESTORE_TREE = join(MIRO_DIR, "restore");

export interface RestoreDeps {
  db: Database;
  setSecret: (ref: string, value: string) => void;
}

export interface RestoreOptions {
  /** A git URL (cloned with `token` over HTTPS) or a local path to a checked-out backup tree.
   * Defaults to the local BACKUP_DIR when this box already has one. */
  source?: string;
  /** For cloning a private repo over HTTPS (provider.github). */
  token?: string;
  /** The age private key (AGE-SECRET-KEY-...) to decrypt secrets.age. Omit to re-establish secrets. */
  ageIdentity?: string;
}

export interface RestoreResult {
  tree: string;
  importedSettings: number;
  importedMemories: number;
  importedExtensions: number;
  secrets: { mode: "restored" | "reestablish"; count: number; note?: string };
  /** Absolute target paths the agent should reconstruct through the operation engine. */
  configFiles: string[];
}

/** AES-256-GCM decrypt with the bundle's own key (mirrors secrets.ts) - so a restored secret is
 * re-encrypted under THIS box's current key by setSecret, with no key-file swap and no restart. */
function decryptWith(keyB64: string, encoded: string): string {
  const key = Buffer.from(keyB64, "base64");
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function importTable(db: Database, table: string, path: string): number {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const cols = Object.keys(row);
      if (!cols.length) continue;
      db.run(
        `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        cols.map((c) => row[c] as any),
      );
      n++;
    } catch {
      // A row whose columns don't match this schema (version drift) is skipped, not fatal.
    }
  }
  return n;
}

function listConfigTargets(configsRoot: string): string[] {
  const out: string[] = [];
  function walk(p: string, rel: string): void {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name), rel ? `${rel}/${name}` : name);
    } else if (st.isFile()) {
      out.push("/" + rel);
    }
  }
  if (existsSync(configsRoot)) walk(configsRoot, "");
  return out;
}

async function decryptAgeBundle(armoredPath: string, identity: string): Promise<{ secretKeyB64: string; secrets: { ref: string; ciphertext: string }[] } | null> {
  if (!(await commandExists("age"))) return null;
  const idFile = join(RESTORE_TREE, ".age-identity");
  mkdirSync(RESTORE_TREE, { recursive: true });
  writeFileSync(idFile, identity.trim() + "\n", { mode: 0o600 });
  try {
    const proc = Bun.spawn(["age", "-d", "-i", idFile], { stdin: Bun.file(armoredPath), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return JSON.parse(out);
  } finally {
    try {
      unlinkSync(idFile);
    } catch {
      // best effort
    }
  }
}

export async function restoreFromBackup(deps: RestoreDeps, opts: RestoreOptions = {}): Promise<RestoreResult> {
  // 1. Get the tree.
  let tree = opts.source || BACKUP_DIR;
  const isUrl = /^(git@|https:\/\/|ssh:\/\/)/.test(tree);
  if (isUrl) {
    rmSync(RESTORE_TREE, { recursive: true, force: true });
    const url = opts.token && tree.startsWith("https://") ? tree.replace("https://", `https://x-access-token:${opts.token}@`) : tree;
    await run("git", ["clone", "--depth", "1", url, RESTORE_TREE], { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 });
    tree = RESTORE_TREE;
  }
  if (!existsSync(join(tree, "miro")) && !existsSync(join(tree, "configs"))) {
    throw new Error(`${tree} does not look like a Miro backup (no miro/ or configs/)`);
  }

  // 2. Import Miro's own state.
  const miro = join(tree, "miro");
  const importedSettings = importTable(deps.db, "settings", join(miro, "settings.ndjson"));
  const importedMemories = importTable(deps.db, "memories", join(miro, "memories.ndjson"));
  const importedExtensions = importTable(deps.db, "extensions", join(miro, "extensions.ndjson"));
  const extSrc = join(miro, "extensions");
  if (existsSync(extSrc)) cpSync(extSrc, join(MIRO_DIR, "extensions"), { recursive: true });

  // 3. Secrets: decrypt the age bundle (re-encrypt under this box's key), else re-establish later.
  let secrets: RestoreResult["secrets"] = { mode: "reestablish", count: 0, note: "secrets were not restored; Miro re-mints or re-prompts each as the apps are reconstructed" };
  const agePath = join(tree, "secrets.age");
  if (existsSync(agePath) && opts.ageIdentity) {
    const bundle = await decryptAgeBundle(agePath, opts.ageIdentity);
    if (bundle) {
      for (const { ref, ciphertext } of bundle.secrets) deps.setSecret(ref, decryptWith(bundle.secretKeyB64, ciphertext));
      secrets = { mode: "restored", count: bundle.secrets.length };
    } else {
      secrets = { mode: "reestablish", count: 0, note: "secrets.age present but decryption failed (age missing or wrong key); secrets will be re-established" };
    }
  } else if (existsSync(agePath)) {
    secrets = { mode: "reestablish", count: 0, note: "secrets.age present but no age identity was provided; secrets will be re-established" };
  }

  return {
    tree,
    importedSettings,
    importedMemories,
    importedExtensions,
    secrets,
    configFiles: listConfigTargets(join(tree, "configs")),
  };
}
