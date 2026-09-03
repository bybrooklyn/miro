import type { Database } from "bun:sqlite";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { SecretStore } from "../secrets";

// OpenAI Codex (ChatGPT OAuth) login - pi-ai's builtinModels() already registers the
// "openai-codex" provider (including gpt-5.6-luna) with a real OAuthAuth implementation; the only
// piece missing was somewhere to durably store/refresh the credential. This backs pi-ai's
// CredentialStore contract with the existing encrypted secrets.ts store (one JSON blob per
// provider, ref "oauth.<providerId>") rather than inventing a new storage mechanism.
//
// Models.getAuth() runs OAuth refresh inside modify() under this store's lock, so a rotated
// access token is always persisted back here - mirod stays logged in across restarts without
// re-running the CLI login flow.

const OAUTH_REF_PREFIX = "oauth.";

export function createCodexCredentialStore(db: Database, secretStore: SecretStore): CredentialStore {
  // Single-process daemon - a simple per-provider promise-chain is enough mutual exclusion;
  // no cross-process lock needed (unlike a CLI where multiple invocations could race).
  const chains = new Map<string, Promise<unknown>>();
  function enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prior = chains.get(providerId) ?? Promise.resolve();
    const next = prior.then(task, task);
    chains.set(
      providerId,
      next.catch(() => {}),
    );
    return next;
  }

  return {
    async read(providerId: string, _options?: AuthOperationOptions) {
      const raw = secretStore.getSecret(db, `${OAUTH_REF_PREFIX}${providerId}`);
      return raw ? (JSON.parse(raw) as Credential) : undefined;
    },
    async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      // ponytail: only Codex ever gets logged in through this store today - a real multi-provider
      // listing would need secrets.ts to support prefix-scanning, which it doesn't. Add if a
      // second OAuth provider is ever wired up.
      const raw = secretStore.getSecret(db, `${OAUTH_REF_PREFIX}openai-codex`);
      if (!raw) return [];
      return [{ providerId: "openai-codex", type: (JSON.parse(raw) as Credential).type }];
    },
    async modify(providerId, fn, _options?: AuthOperationOptions) {
      return enqueue(providerId, async () => {
        const raw = secretStore.getSecret(db, `${OAUTH_REF_PREFIX}${providerId}`);
        const current = raw ? (JSON.parse(raw) as Credential) : undefined;
        const next = await fn(current);
        if (next) secretStore.setSecret(db, `${OAUTH_REF_PREFIX}${providerId}`, JSON.stringify(next));
        return next;
      });
    },
    async delete(_providerId: string, _options?: AuthOperationOptions) {
      // Not needed yet - no logout UX this slice. secrets.ts has no delete either.
    },
  };
}

/** One-time import of a credential written by `pi-ai`'s own CLI (`login openai-codex`) into
 * mirod's persistent store, so the daemon doesn't need its own interactive OAuth login UX yet. */
export function importCodexCredentialFromCli(db: Database, secretStore: SecretStore, cliAuthJson: Record<string, unknown>): boolean {
  const cred = cliAuthJson["openai-codex"];
  if (!cred || typeof cred !== "object") return false;
  secretStore.setSecret(db, `${OAUTH_REF_PREFIX}openai-codex`, JSON.stringify(cred));
  return true;
}
