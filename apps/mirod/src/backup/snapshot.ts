import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync, existsSync, chmodSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { Database } from "bun:sqlite";
import { listContainers } from "../inventory/containers";
import { commandExists } from "../inventory/exec";
import { redactSecretsInText } from "../operations/classify";

// The backup snapshot (PLAN.md config-backup slice): build a git working tree of the server's
// declarative configs + Miro's own state, NEVER a plaintext secret. Every text file passes through
// redactSecretsInText before it lands in the tree, so a committed compose/env file can't leak a
// live credential. The raw miro.db is never committed; secret.key + the secret store go only into
// the optional age bundle (encrypt-only to the owner's public key - the box can never decrypt it).

/** Curated allowlist of server config paths. Live-derived compose files are added at snapshot time
 * (discoverComposeFiles). Vendor systemd units live in /usr/lib and are skipped - only owner units
 * and drop-in overrides in /etc/systemd/system matter for reconstruction. Owner-extensible via the
 * backup.extra_paths setting. */
export const DEFAULT_CONFIG_PATHS = ["/etc/docker/daemon.json", "/etc/fstab", "/etc/systemd/system"];

/** Miro-state tables exported as NDJSON - non-secret by construction (settings/memories/operations)
 * or reference-only (extensions rows name secrets by ref, never value). The `secrets` table is
 * deliberately absent: it goes only into the age bundle. */
const STATE_TABLES = ["settings", "memories", "operations", "extensions"];

const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIR_NAMES = new Set([".git", "node_modules"]);

export interface SnapshotOptions {
  /** Overrides DEFAULT_CONFIG_PATHS (tests). */
  configPaths?: string[];
  /** Appended to the config path set (the backup.extra_paths setting). */
  extraPaths?: string[];
  /** MIRO_DIR/extensions - the generated per-app code, copied as source. */
  extensionsDir?: string;
  /** MIRO_DIR/secret.key - only read for the age bundle. */
  secretKeyPath?: string;
  /** An age recipient public key. When set, an encrypt-only secrets bundle is written. */
  ageRecipient?: string | null;
  /** Skip the live `docker ps` compose discovery (tests). */
  skipComposeDiscovery?: boolean;
}

export interface SnapshotResult {
  configFiles: number;
  skipped: string[];
  stateTables: string[];
  ageBundle: "written" | "no-recipient" | "age-missing" | "no-key";
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Regular non-symlink text files under `root`, recursively. Symlinks are skipped: in
 * /etc/systemd/system they are the enablement links into /usr/lib (vendor content we don't want,
 * and enablement is reconstructed with `systemctl enable`, not copied). */
function collectFiles(root: string, out: string[]): void {
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (SKIP_DIR_NAMES.has(basename(root)) || basename(root).endsWith(".staging") || basename(root).endsWith(".prev")) return;
    for (const name of readdirSync(root)) collectFiles(join(root, name), out);
    return;
  }
  if (st.isFile()) out.push(root);
}

/** Copy each source file to <destRoot>/<absolute-path-without-leading-slash>, redacted. Binary or
 * oversized files are skipped (never risk an un-redactable blob), and their paths are returned. */
function redactCopyInto(files: string[], destRoot: string): string[] {
  const skipped: string[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(f);
      if (raw.length > MAX_FILE_BYTES || looksBinary(raw)) {
        skipped.push(f);
        continue;
      }
      const dest = join(destRoot, f.replace(/^\/+/, ""));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, redactSecretsInText(raw.toString("utf8")));
    } catch {
      skipped.push(f);
    }
  }
  return skipped;
}

/** Compose files the running containers declare (the same labels reboot.ts reads). Absolute paths,
 * de-duplicated. Never throws - a stopped/absent docker just yields none. */
export async function discoverComposeFiles(): Promise<string[]> {
  const { available, containers } = await listContainers().catch(() => ({ available: false, containers: [] }));
  if (!available) return [];
  const out = new Set<string>();
  for (const c of containers) {
    const workingDir = c.labels["com.docker.compose.project.working_dir"] ?? "";
    for (const f of (c.labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean)) {
      out.add(f.startsWith("/") ? f : join(workingDir, f));
    }
  }
  return [...out];
}

function dumpTable(db: Database, table: string, dest: string): boolean {
  try {
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    // Redact each line defensively: an operation's captured_state or a memory can carry a
    // secret-shaped string. `[redacted]` has no quote/newline, so the JSON stays valid.
    const text = rows.map((r) => redactSecretsInText(JSON.stringify(r))).join("\n");
    writeFileSync(dest, text + (rows.length ? "\n" : ""));
    return true;
  } catch {
    return false;
  }
}

/** age-encrypt {secret.key, the ciphertext secret rows} to the owner's PUBLIC key via stdin (no
 * plaintext ever hits disk). ASCII-armored so it diffs in git. `age` absent or no key -> skipped,
 * reported, never fatal. The rows are already AES-GCM ciphertext; age wraps them so a restore needs
 * BOTH the age private key (off-box) AND, implicitly, nothing else - secret.key rides inside. */
async function writeAgeBundle(db: Database, recipient: string, secretKeyPath: string, dest: string): Promise<SnapshotResult["ageBundle"]> {
  if (!(await commandExists("age"))) return "age-missing";
  if (!secretKeyPath || !existsSync(secretKeyPath)) return "no-key";
  const rows = db.query("SELECT ref, ciphertext FROM secrets").all() as { ref: string; ciphertext: string }[];
  const bundle = JSON.stringify({ secretKeyB64: readFileSync(secretKeyPath).toString("base64"), secrets: rows });
  const proc = Bun.spawn(["age", "-a", "-r", recipient], { stdin: new Blob([bundle]), stdout: "pipe", stderr: "pipe" });
  const armored = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) return "age-missing";
  writeFileSync(dest, armored);
  return "written";
}

const RESTORE_MANIFEST = `# Miro backup

Reconstruct this server with Miro's \`restore_from_backup\` tool (agent-driven, through the
operation engine). Contents:

- \`configs/\` - the server's declarative configs (compose files, systemd units, selected /etc),
  mirrored at their absolute paths. Secret-shaped values are redacted.
- \`miro/\` - Miro's own state as NDJSON (settings, memories, operations, extensions) plus the
  generated extension source under \`miro/extensions/\`. No plaintext secrets.
- \`secrets.age\` (only if enabled) - secret.key + the secret store, age-encrypted to the owner's
  public key. Decrypt off-box with the matching private key; without it, secrets are re-established
  on restore (re-minted or re-prompted).
`;

/** Rebuild the working tree from scratch (so a config removed on the box is recorded as a deletion
 * once git add -A runs). Returns what was captured. */
export async function buildSnapshot(db: Database, backupDir: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  mkdirSync(backupDir, { recursive: true });
  chmodSync(backupDir, 0o700);
  for (const sub of ["configs", "miro"]) rmSync(join(backupDir, sub), { recursive: true, force: true });

  const configPaths = [
    ...(opts.configPaths ?? DEFAULT_CONFIG_PATHS),
    ...(opts.skipComposeDiscovery ? [] : await discoverComposeFiles()),
    ...(opts.extraPaths ?? []),
  ];
  const configFilesList: string[] = [];
  for (const p of configPaths) collectFiles(p, configFilesList);
  const uniqueConfigs = [...new Set(configFilesList)];
  const skipped = redactCopyInto(uniqueConfigs, join(backupDir, "configs"));

  const miroDir = join(backupDir, "miro");
  mkdirSync(miroDir, { recursive: true });
  const stateTables = STATE_TABLES.filter((t) => dumpTable(db, t, join(miroDir, `${t}.ndjson`)));
  if (opts.extensionsDir && existsSync(opts.extensionsDir)) {
    const extFiles: string[] = [];
    collectFiles(opts.extensionsDir, extFiles);
    redactCopyInto(extFiles, join(miroDir, "extensions"));
  }

  let ageBundle: SnapshotResult["ageBundle"] = "no-recipient";
  if (opts.ageRecipient) {
    ageBundle = await writeAgeBundle(db, opts.ageRecipient, opts.secretKeyPath ?? "", join(backupDir, "secrets.age"));
  } else {
    rmSync(join(backupDir, "secrets.age"), { force: true });
  }

  writeFileSync(join(backupDir, "RESTORE.md"), RESTORE_MANIFEST);
  return { configFiles: uniqueConfigs.length - skipped.length, skipped, stateTables, ageBundle };
}
