import type { Database } from "bun:sqlite";
import { refreshOAuthToken, type OAuthCredentials } from "@miro/model-client";
import type { SecretStore } from "../secrets";

// OpenAI Codex (ChatGPT OAuth) login. The vendored model client's openai-codex provider takes the
// OAuth access token as its plain apiKey (the account id is decoded from the token itself), and
// refreshOAuthToken() does the refresh round-trip - the only piece that is Miro's is durable
// storage: one JSON blob per provider in the existing encrypted secrets.ts store, ref
// "oauth.<providerId>", exactly where the pi-ai-era CredentialStore kept it, so a login made before
// the migration to the vendored packages (PLAN.md §5.17) keeps working unchanged.

const OAUTH_REF_PREFIX = "oauth.";
const CODEX = "openai-codex";
/** Refresh this long before the recorded expiry, so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface CodexAuth {
  isConnected(): boolean;
  /** A fresh access token for `provider` (only "openai-codex" is ever logged in today), refreshing
   * and persisting it first when it is about to expire; undefined when not logged in. */
  accessToken(provider: string): Promise<string | undefined>;
}

export function createCodexAuth(db: Database, secretStore: SecretStore): CodexAuth {
  const ref = `${OAUTH_REF_PREFIX}${CODEX}`;
  const read = (): OAuthCredentials | null => {
    const raw = secretStore.getSecret(db, ref);
    return raw ? (JSON.parse(raw) as OAuthCredentials) : null;
  };
  // Single-process daemon: one in-flight refresh at a time is all the mutual exclusion needed, so
  // concurrent turns (a chat plus a background repair) share one refresh instead of racing two.
  let inflight: Promise<string | undefined> | null = null;
  return {
    isConnected: () => read() !== null,
    accessToken(provider) {
      if (provider !== CODEX) return Promise.resolve(undefined);
      if (inflight) return inflight;
      inflight = (async () => {
        const creds = read();
        if (!creds) return undefined;
        if (Date.now() < creds.expires - EXPIRY_SKEW_MS) return creds.access;
        const fresh = await refreshOAuthToken(CODEX, creds);
        secretStore.setSecret(db, ref, JSON.stringify({ type: "oauth", ...fresh }));
        return fresh.access;
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

/** One-time import of a credential written by the pi-ai CLI's `login openai-codex` (the
 * `{"openai-codex": {type, access, refresh, expires, accountId}}` auth.json shape, which the vendored
 * client's OAuthCredentials still matches) into mirod's persistent store, so the daemon doesn't need
 * its own interactive OAuth login UX yet. */
export function importCodexCredentialFromCli(db: Database, secretStore: SecretStore, cliAuthJson: Record<string, unknown>): boolean {
  const cred = cliAuthJson[CODEX];
  if (!cred || typeof cred !== "object") return false;
  secretStore.setSecret(db, `${OAUTH_REF_PREFIX}${CODEX}`, JSON.stringify(cred));
  return true;
}
