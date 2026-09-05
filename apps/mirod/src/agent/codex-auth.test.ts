import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@miro/model-client";
import { createSecretStore, ensureSecretsTable } from "../secrets";
import { createCodexAuth, importCodexCredentialFromCli } from "./codex-auth";

// Real :memory: DB and a real encrypted secret store (temp key file); only the refresh round-trip
// is injected - a plain function that records its calls, standing at the exact network boundary
// refreshOAuthToken() occupies. The network path itself is live-verified (PLAN.md §5.19).

const HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;

function setup(stored?: Partial<OAuthCredentials> & { type?: string }) {
  const db = new Database(":memory:");
  ensureSecretsTable(db);
  const store = createSecretStore(join(mkdtempSync(join(tmpdir(), "miro-codex-test-")), "secret.key"));
  if (stored) store.setSecret(db, "oauth.openai-codex", JSON.stringify({ type: "oauth", access: "old-access", refresh: "old-refresh", expires: T0 + 24 * HOUR, accountId: "acct", ...stored }));
  const refreshes: OAuthCredentials[] = [];
  let failNext = 0;
  const auth = createCodexAuth(db, store, {
    now: () => T0,
    retryDelayMs: 0,
    refresh: async (creds) => {
      refreshes.push(creds);
      if (failNext > 0) {
        failNext--;
        throw new Error("Timed out waiting for https://auth.openai.com/oauth/token");
      }
      return { ...creds, access: `new-access-${refreshes.length}`, refresh: "new-refresh", expires: T0 + 10 * 24 * HOUR };
    },
  });
  const storedNow = () => JSON.parse(store.getSecret(db, "oauth.openai-codex")!) as OAuthCredentials & { type?: string };
  return { db, store, auth, refreshes, storedNow, failRefreshes: (n: number) => (failNext = n) };
}

const initial = { lastChance: false, error: undefined };
const rejected = { lastChance: false, error: new Error("401 Unauthorized") };

test("not logged in: not connected, no ApiKey for any provider", () => {
  const { auth } = setup();
  expect(auth.isConnected()).toBe(false);
  expect(auth.apiKey("openai-codex")).toBeUndefined();
  expect(auth.apiKey("anthropic")).toBeUndefined();
});

test("a valid stored token is handed out as-is, with no refresh", async () => {
  const { auth, refreshes } = setup({});
  expect(auth.isConnected()).toBe(true);
  expect(auth.apiKey("anthropic")).toBeUndefined(); // only the logged-in provider gets a resolver
  expect(await auth.apiKey("openai-codex")!(initial)).toBe("old-access");
  expect(refreshes).toHaveLength(0);
});

test("a token about to expire is refreshed first, and the rotated credential is persisted", async () => {
  const { auth, refreshes, storedNow } = setup({ expires: T0 + 2 * 60_000 }); // inside the 5-minute skew
  expect(await auth.apiKey("openai-codex")!(initial)).toBe("new-access-1");
  expect(refreshes).toHaveLength(1);
  const stored = storedNow();
  expect(stored.access).toBe("new-access-1");
  expect(stored.refresh).toBe("new-refresh");
  expect(stored.type).toBe("oauth"); // the on-disk shape the CLI import wrote is preserved
  // The next resolve serves the persisted token without another round-trip.
  expect(await auth.apiKey("openai-codex")!(initial)).toBe("new-access-1");
  expect(refreshes).toHaveLength(1);
});

test("a provider rejection (step b) forces a refresh even when the clock says the token is fine", async () => {
  const { auth, refreshes } = setup({});
  expect(await auth.apiKey("openai-codex")!(rejected)).toBe("new-access-1");
  expect(refreshes).toHaveLength(1);
});

test("there is no sibling account to rotate to (step c)", async () => {
  const { auth, refreshes } = setup({});
  expect(await auth.apiKey("openai-codex")!({ lastChance: true, error: new Error("401") })).toBeUndefined();
  expect(refreshes).toHaveLength(0);
});

test("a transient refresh failure is retried once; the stored credential is untouched by the failure", async () => {
  const { auth, refreshes, storedNow, failRefreshes } = setup({ expires: T0 - 1 });
  failRefreshes(1);
  expect(await auth.apiKey("openai-codex")!(initial)).toBe("new-access-2");
  expect(refreshes).toHaveLength(2);
  expect(storedNow().access).toBe("new-access-2");
});

test("two failures in a row surface the first error and leave the stored credential as it was", async () => {
  const { auth, refreshes, storedNow, failRefreshes } = setup({ expires: T0 - 1 });
  failRefreshes(2);
  await expect(auth.apiKey("openai-codex")!(initial)).rejects.toThrow("Timed out waiting for");
  expect(refreshes).toHaveLength(2);
  expect(storedNow().access).toBe("old-access");
});

test("concurrent resolves share one in-flight refresh", async () => {
  const { auth, refreshes } = setup({ expires: T0 - 1 });
  const resolver = auth.apiKey("openai-codex")!;
  const [a, b] = await Promise.all([resolver(initial), resolver(initial)]);
  expect(a).toBe("new-access-1");
  expect(b).toBe("new-access-1");
  expect(refreshes).toHaveLength(1);
});

test("importCodexCredentialFromCli stores the CLI's blob verbatim and ignores anything else", () => {
  const { db, store, auth } = setup();
  expect(importCodexCredentialFromCli(db, store, { other: {} })).toBe(false);
  // A blob missing a field the resolver needs is not "connected" - it would refresh a missing
  // refresh token on every turn (audit B8).
  expect(importCodexCredentialFromCli(db, store, { "openai-codex": { type: "oauth", access: "a" } })).toBe(false);
  expect(auth.isConnected()).toBe(false);
  expect(importCodexCredentialFromCli(db, store, { "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: T0 + HOUR } })).toBe(true);
  expect(auth.isConnected()).toBe(true);
});

test("a corrupt stored blob reads as not connected instead of throwing into every chat turn", () => {
  const { db, store, auth } = setup();
  store.setSecret(db, "oauth.openai-codex", "{not json");
  expect(auth.isConnected()).toBe(false);
  store.setSecret(db, "oauth.openai-codex", JSON.stringify({ access: "a" }));
  expect(auth.isConnected()).toBe(false);
  expect(auth.apiKey("openai-codex")).toBeUndefined();
});
