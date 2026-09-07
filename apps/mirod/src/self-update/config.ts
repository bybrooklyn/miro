import type { Channel } from "./github";

// Self-update configuration (PLAN.md §5.16): where updates come from and which channel. Kept as plain
// settings + one secret ref so the owner can point a fork at its own release repo, and so the token
// never lives in code.

export const UPDATE_CHANNEL_SETTING = "update.channel";
export const UPDATE_REPO_SETTING = "update.repo";
/** The GitHub token secret, resolved only inside the fetch path - never in a describe() or model context. */
export const GITHUB_TOKEN_SECRET = "provider.github";
/** ponytail: the canonical release repo, overridable per install via UPDATE_REPO_SETTING. A published
 * fork points this at its own repo. */
export const DEFAULT_REPO = "bybrooklyn/miro";

export function getChannel(getSetting: (k: string) => string | null): Channel {
  return getSetting(UPDATE_CHANNEL_SETTING) === "beta" ? "beta" : "stable";
}

export function getRepo(getSetting: (k: string) => string | null): string {
  return getSetting(UPDATE_REPO_SETTING) || DEFAULT_REPO;
}
