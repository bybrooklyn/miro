import type { Database } from "bun:sqlite";
import { refreshOAuthToken, type ApiKeyResolver, type OAuthCredentials } from "@miro/model-client";
import type { SecretStore } from "../secrets";

// OpenAI Codex (ChatGPT OAuth) login. The vendored model client's openai-codex provider takes the
// OAuth access token as its plain apiKey (the account id is decoded from the token itself), and
// refreshOAuthToken() does the refresh round-trip - the only piece that is Miro's is durable
// storage: one JSON blob per provider in the existing encrypted secrets.ts store, ref
// "oauth.<providerId>", exactly where the pi-ai-era CredentialStore kept it, so a login made before
// the migration to the vendored packages (PLAN.md §5.17) keeps working unchanged.
//
// The credential is handed to the client as an ApiKeyResolver, not a bare string, so the client's
// own auth-retry policy drives it: on a 401 it asks once for "the same credential, refreshed"
// (step b) and then once for a sibling account (step c, which Miro does not have). A transient
// failure of the refresh round-trip itself is retried once here - found live on the dev VM, where
// the first forced refresh timed out at the provider's 15s budget and the next turn succeeded.

const OAUTH_REF_PREFIX = "oauth.";
const CODEX = "openai-codex";
/** Refresh this long before the recorded expiry, so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 5 * 60_000;
const REFRESH_RETRY_DELAY_MS = 1_000;

export interface CodexAuth {
  isConnected(): boolean;
  /** The client's ApiKey for `provider` (only "openai-codex" is ever logged in today): a resolver
   * that returns the stored access token, refreshing and persisting it first when it is about to
   * expire or when the provider just rejected it. Undefined when not logged in. */
  apiKey(provider: string): ApiKeyResolver | undefined;
}

export interface CodexAuthOptions {
  /** The refresh round-trip - the real one by default; injectable so the decision logic is tested
   * against a real store without the network (the network path is live-verified, PLAN.md §5.19). */
  refresh?: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
  now?: () => number;
  retryDelayMs?: number;
}

export function createCodexAuth(db: Database, secretStore: SecretStore, options: CodexAuthOptions = {}): CodexAuth {
  const ref = `${OAUTH_REF_PREFIX}${CODEX}`;
  const refresh = options.refresh ?? ((credentials) => refreshOAuthToken(CODEX, credentials));
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? REFRESH_RETRY_DELAY_MS;

  const read = (): OAuthCredentials | null => {
    const raw = secretStore.getSecret(db, ref);
    return raw ? (JSON.parse(raw) as OAuthCredentials) : null;
  };

  async function refreshWithOneRetry(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    try {
      return await refresh(credentials);
    } catch (first) {
      await Bun.sleep(retryDelayMs);
      try {
        return await refresh(credentials);
      } catch {
        throw first;
      }
    }
  }

  // Single-process daemon: one in-flight refresh at a time is all the mutual exclusion needed, so
  // concurrent turns (a chat plus a background repair) share one refresh instead of racing two.
  let inflight: Promise<string | undefined> | null = null;
  function accessToken(force: boolean): Promise<string | undefined> {
    if (inflight) return inflight;
    inflight = (async () => {
      const creds = read();
      if (!creds) return undefined;
      if (!force && now() < creds.expires - EXPIRY_SKEW_MS) return creds.access;
      const fresh = await refreshWithOneRetry(creds);
      secretStore.setSecret(db, ref, JSON.stringify({ type: "oauth", ...fresh }));
      return fresh.access;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    isConnected: () => read() !== null,
    apiKey(provider) {
      if (provider !== CODEX || read() === null) return undefined;
      return (ctx) => {
        // Step (c), rotate to a sibling credential: there is none.
        if (ctx.lastChance) return undefined;
        // Step (b), the provider rejected the current token: refresh it regardless of the clock.
        return accessToken(ctx.error !== undefined);
      };
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
