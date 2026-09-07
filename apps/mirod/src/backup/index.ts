import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Database } from "bun:sqlite";
import { MIRO_DIR } from "@miro/protocol";
import { run, commandExists } from "../inventory/exec";
import { GITHUB_TOKEN_SECRET } from "../self-update/config";
import { buildSnapshot, type SnapshotOptions, type SnapshotResult } from "./snapshot";
import { ensureRepo, commitAll, push, type PushAuth } from "./git";

// Config backup orchestration (PLAN.md config-backup slice): commit the server's configs + Miro's
// own non-secret state into a local git repo under MIRO_DIR, and push it to a private GitHub repo
// Miro creates for itself. Per-operation + daily commits; daily + on-failure + pre-shutdown pushes
// (wired in index.ts / the shutdown kind). Auth: a per-repo deploy key by default (least
// privilege), or the provider.github token, or gh - whichever is configured.

export const BACKUP_DIR = join(MIRO_DIR, "backup");
export const BACKUP_KEY_PATH = join(MIRO_DIR, "backup_id_ed25519");

export const BACKUP_ENABLED = "backup.enabled";
export const BACKUP_REPO = "backup.repo"; // "owner/name"; auto-derived when unset
export const BACKUP_AUTH = "backup.auth"; // auto | deploy_key | token | gh
export const BACKUP_AGE_RECIPIENT = "backup.age_recipient";
export const BACKUP_EXTRA_PATHS = "backup.extra_paths"; // newline/comma-separated extra config paths
export const BACKUP_REMOTE = "backup.remote"; // cached resolved remote URL (set by bootstrap)

export interface BackupDeps {
  db: Database;
  getSetting: (k: string) => string | null;
  setSetting: (k: string, v: string) => void;
  getSecret: (ref: string) => string | null;
}

export function backupEnabled(d: BackupDeps): boolean {
  return d.getSetting(BACKUP_ENABLED) === "true";
}

function snapshotOptions(d: BackupDeps): SnapshotOptions {
  const extra = (d.getSetting(BACKUP_EXTRA_PATHS) ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    extraPaths: extra,
    extensionsDir: join(MIRO_DIR, "extensions"),
    secretKeyPath: join(MIRO_DIR, "secret.key"),
    ageRecipient: d.getSetting(BACKUP_AGE_RECIPIENT),
  };
}

export type BackupResult = { committed: boolean; snapshot: SnapshotResult } | { skipped: string };

/** Rebuild the snapshot and commit iff anything changed. No-op (skipped) unless backup is enabled. */
export async function runBackup(d: BackupDeps, reason: string): Promise<BackupResult> {
  if (!backupEnabled(d)) return { skipped: "disabled" };
  await ensureRepo(BACKUP_DIR);
  const snapshot = await buildSnapshot(d.db, BACKUP_DIR, snapshotOptions(d));
  const committed = await commitAll(BACKUP_DIR, `${reason} - ${new Date().toISOString()}`);
  return { committed, snapshot };
}

async function githubApi(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "miro-backup",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function httpsRemote(repo: string): string {
  return `https://github.com/${repo}.git`;
}

async function defaultRepo(token: string): Promise<string> {
  const u = await githubApi(token, "GET", "/user");
  if (u.status !== 200 || !u.json?.login) throw new Error(`GitHub /user failed (${u.status})`);
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, "-") || "server";
  return `${u.json.login}/${host}-miro-backup`;
}

async function ensureDeployKey(): Promise<void> {
  if (existsSync(BACKUP_KEY_PATH)) return;
  // ssh-keygen writes the private key 0600 and <path>.pub. -N "" = no passphrase (the daemon must
  // push unattended); the private key's file permissions are its protection, same bar as secret.key.
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "miro-backup", "-f", BACKUP_KEY_PATH], { timeoutMs: 30_000 });
}

/** One-time: ensure the deploy key exists, the private repo exists (auto-created under the token's
 * account when backup.repo is unset), and the key is registered with write access. Idempotent - an
 * already-existing repo (422) or key (422) is fine. Caches and returns the SSH remote. */
async function bootstrap(d: BackupDeps, token: string): Promise<string> {
  await ensureDeployKey();
  const pub = readFileSync(`${BACKUP_KEY_PATH}.pub`, "utf8").trim();
  const wasSet = d.getSetting(BACKUP_REPO);
  const repo = wasSet || (await defaultRepo(token));
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`backup.repo must be "owner/name", got "${repo}"`);
  if (!wasSet) {
    const r = await githubApi(token, "POST", "/user/repos", { name, private: true, auto_init: false });
    if (r.status !== 201 && r.status !== 422) throw new Error(`create repo failed (${r.status}): ${r.json?.message ?? ""}`);
    d.setSetting(BACKUP_REPO, repo);
  }
  const k = await githubApi(token, "POST", `/repos/${owner}/${name}/keys`, { title: `miro-backup ${hostname()}`, key: pub, read_only: false });
  if (k.status !== 201 && k.status !== 422) throw new Error(`register deploy key failed (${k.status}): ${k.json?.message ?? ""}`);
  const remote = `git@github.com:${owner}/${name}.git`;
  d.setSetting(BACKUP_REMOTE, remote);
  return remote;
}

async function resolvePushAuth(d: BackupDeps, token: string | null): Promise<PushAuth | { error: string }> {
  const mode = d.getSetting(BACKUP_AUTH) || "auto";
  const keyExists = existsSync(BACKUP_KEY_PATH);

  if (mode === "deploy_key" || (mode === "auto" && (keyExists || token))) {
    let remote = d.getSetting(BACKUP_REMOTE);
    if (!remote || !keyExists) {
      if (!token) return { error: "deploy-key push needs a GitHub token (secret provider.github) once, to create the repo and register the key" };
      remote = await bootstrap(d, token);
    }
    return { mode: "deploy_key", remote, keyPath: BACKUP_KEY_PATH };
  }
  if (mode === "token" || (mode === "auto" && token)) {
    if (!token) return { error: "token push needs the provider.github secret" };
    const repo = d.getSetting(BACKUP_REPO) || (await defaultRepo(token));
    return { mode: "token", remote: httpsRemote(repo), token };
  }
  if (mode === "gh" || (mode === "auto" && (await commandExists("gh")))) {
    const repo = d.getSetting(BACKUP_REPO);
    if (!repo) return { error: "gh push needs backup.repo set to owner/name" };
    return { mode: "gh", remote: httpsRemote(repo) };
  }
  return { error: "no push auth available - set the provider.github secret, or backup.auth=gh with gh already authenticated" };
}

/** Push the local backup repo to GitHub per the configured/derived auth. No-op unless enabled and a
 * local repo exists. Returns a reason (never throws) so a network blip surfaces without failing the
 * caller (a scheduled tick, a pre-shutdown flush). */
export async function pushBackup(d: BackupDeps): Promise<{ pushed: boolean; reason?: string }> {
  if (!backupEnabled(d)) return { pushed: false, reason: "disabled" };
  if (!existsSync(join(BACKUP_DIR, ".git"))) return { pushed: false, reason: "no local backup repo yet" };
  const token = d.getSecret(GITHUB_TOKEN_SECRET);
  try {
    const auth = await resolvePushAuth(d, token);
    if ("error" in auth) return { pushed: false, reason: auth.error };
    await push(BACKUP_DIR, auth);
    return { pushed: true };
  } catch (e) {
    return { pushed: false, reason: (e as Error).message };
  }
}
