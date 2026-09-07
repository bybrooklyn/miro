import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../inventory/exec";

// The backup repo's git, run as the daemon's OWN uid (the repo lives under MIRO_DIR, which the
// daemon owns - root in production, the dev user otherwise), so plain `run`, never runPrivileged/
// sudo. It is Miro's own maintenance action, not an agent-issued command, so it never touches the
// classifier or the sandbox. GIT_TERMINAL_PROMPT=0 makes an auth failure fail fast instead of
// hanging on a credential prompt.

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

/** Never commit a stray private key even if some future path drops one into the tree. The intended
 * secrets bundle (secrets.age) is deliberately NOT ignored - it is ciphertext, safe to push. */
const GITIGNORE = ["*.pem", "*.key", "id_*", "*_rsa", "*_ed25519", ""].join("\n");

async function git(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  return run("git", ["-C", dir, ...args], { env: { ...GIT_ENV, ...env }, timeoutMs: 120_000 });
}

export async function ensureRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, ["init", "-q"]);
  // Repo-local identity so a commit never depends on (or pollutes) global git config. Signing is
  // forced off: a global commit.gpgsign would make `git commit` hang on a GPG passphrase prompt,
  // which the daemon can never answer (found live - the backup unit test hung on it).
  await git(dir, ["config", "user.name", "Miro"]);
  await git(dir, ["config", "user.email", "miro@localhost"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await git(dir, ["config", "tag.gpgsign", "false"]);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
}

/** Stage everything and commit iff the tree actually changed. Returns whether a commit was made. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ["add", "-A"]);
  const status = (await git(dir, ["status", "--porcelain"])).trim();
  if (!status) return false;
  await git(dir, ["commit", "-q", "-m", message]);
  return true;
}

export type PushAuth =
  | { mode: "deploy_key"; remote: string; keyPath: string; branch?: string }
  | { mode: "token"; remote: string; token: string; branch?: string }
  | { mode: "gh"; remote: string; branch?: string };

async function setRemote(dir: string, url: string): Promise<void> {
  await git(dir, ["remote", "set-url", "origin", url]).catch(() => git(dir, ["remote", "add", "origin", url]));
}

/** Push HEAD to <branch> on origin. Auth is applied per-push, never persisted to disk:
 * - deploy_key: GIT_SSH_COMMAND points ssh at the 0600 key (no ~/.ssh/config edit, no core.sshCommand).
 * - token: an http.extraHeader Basic auth via -c (the token is in argv, never in the stored remote URL).
 * - gh: a plain HTTPS push, assuming `gh auth setup-git` already configured a credential helper. */
export async function push(dir: string, auth: PushAuth): Promise<void> {
  const branch = auth.branch ?? "main";
  await setRemote(dir, auth.remote);
  const spec = `HEAD:${branch}`;
  if (auth.mode === "deploy_key") {
    const sshCmd = `ssh -i ${auth.keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    await git(dir, ["push", "-u", "origin", spec], { GIT_SSH_COMMAND: sshCmd });
  } else if (auth.mode === "token") {
    const b64 = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
    await git(dir, ["-c", `http.extraHeader=AUTHORIZATION: basic ${b64}`, "push", "-u", "origin", spec]);
  } else {
    await git(dir, ["push", "-u", "origin", spec]);
  }
}
