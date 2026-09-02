import type { OperationKind } from "../engine";
import { isLocalOrPrivateUrl } from "../classify";

// The generic HTTP write (PLAN.md §5.4 B). This is how a learned extension's declarative write
// bindings, and the main agent directly, change an app's state through its API: the plan shows
// method + URL + body, captureState GETs the current representation, apply sends the request,
// verify GETs again, rollback replays an explicit undo request or PUTs the captured body back.
// Credentials are injected by secret reference at apply time only — never in the plan, never in
// anything the model sees.

export interface HttpMutationParams {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  /** Header injected from the secret store at apply time, e.g. { name: "X-Emby-Token", ref: "extension.jellyfin.api_key" }. */
  secretHeader?: { name: string; ref: string };
  /** Extra statuses that count as success, on top of any 2xx (e.g. 409 "already exists"). */
  expectStatus?: number[];
  /** GET before apply — the captured representation rollback can restore for PUT. */
  captureUrl?: string;
  /** GET after apply; success = 2xx, plus `verifyExpect` substring if given. */
  verifyUrl?: string;
  verifyExpect?: string;
  /** Explicit undo request. Without it, only PUT-with-captureUrl is reversible. */
  rollback?: { method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: string; contentType?: string };
  timeoutMs?: number;
  /** Keep a field of the JSON response (dotted path) in the secret store under `ref` — the way
   * a login's AccessToken or a minted API key is retained. The value never reaches the model:
   * found live, the raw auth response body in tool output was how a session token got into a
   * transcript. Only `extension.<app>.<name>` refs; Miro's own refs are not writable this way. */
  storeResponseField?: { field: string; ref: string };
}

export interface HttpMutationCaptured {
  before: { status: number; body: string } | null;
}

export interface HttpMutationOutput {
  status: number;
  body: string;
  /** The ref a response field was stored under, or the reason it was not. */
  stored?: string | null;
  storeError?: string;
}

const STORABLE_REF = /^extension\.[a-z0-9][a-z0-9-]*\.[a-z0-9_][a-z0-9_-]*$/i;

function fieldAt(json: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), json);
}

const outputs = new WeakMap<object, HttpMutationOutput>();
export function takeOutput(params: object): HttpMutationOutput | undefined {
  const r = outputs.get(params);
  outputs.delete(params);
  return r;
}

// The URL guard lives with the classifier (curl/wget use it too); re-exported for existing imports.
export { isLocalOrPrivateUrl };

async function request(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string; contentType?: string; timeoutMs?: number },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && opts.contentType) headers["Content-Type"] = opts.contentType;
  // redirect: "manual" — a compromised local app must not be able to 302 the secret header to a
  // public host (adversarial review). A redirect is reported as its 3xx status, never followed.
  const res = await fetch(url, { method, headers, body: opts.body, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  return { status: res.status, body: (await res.text()).slice(0, 64 * 1024) };
}

/** `{{secret:<ref>}}` anywhere in a body, URL, or header value — resolved at request time only.
 * The plan the user approves and everything the model sees carry the placeholder. */
const SECRET_PLACEHOLDER = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g; // for replace/matchAll only — /g regexes are stateful under .test()
const HAS_PLACEHOLDER = /\{\{secret:[A-Za-z0-9_.-]+\}\}/;

export function substituteSecrets(text: string, getSecret: (ref: string) => string | null): string {
  return text.replace(SECRET_PLACEHOLDER, (_, ref: string) => {
    const value = getSecret(ref);
    if (value === null) throw new Error(`secret ${ref} is not set`);
    return value;
  });
}

/** An Authorization-style header that carries no secret: a `{{secret:ref}}` placeholder, or the
 * Jellyfin/Emby `MediaBrowser Client="…", Device="…", DeviceId="…", Version="…"` client
 * identification that `AuthenticateByName` requires *without* a Token — refusing that would push
 * the agent to the browser for something the API supports (found in acceptance run #3). */
export function isCredentialFreeHeader(value: string): boolean {
  if (HAS_PLACEHOLDER.test(value)) return true;
  return /^MediaBrowser\s/i.test(value) && !/Token\s*=\s*"(?!\{\{secret:)[^"]+"/i.test(value);
}

/** A literal credential in a request body is exactly what the placeholder exists to prevent:
 * it would sit in the plan, the transcript, and the model's context. */
const LITERAL_CREDENTIAL = /"(password|passwd|pw|token|api_?key|secret)"\s*:\s*"(?!\{\{secret:)[^"]{4,}"/i;

export function httpMutationKind(
  getSecret: (ref: string) => string | null,
  setSecret: (ref: string, value: string) => void = () => { throw new Error("secret store unavailable — storeResponseField needs the daemon's store"); },
): OperationKind<HttpMutationParams, HttpMutationCaptured> {
  const authHeaders = (p: HttpMutationParams): Record<string, string> => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.headers ?? {})) h[k] = substituteSecrets(v, getSecret);
    if (p.secretHeader) {
      const value = getSecret(p.secretHeader.ref);
      if (!value) throw new Error(`secret ${p.secretHeader.ref} is not set`);
      h[p.secretHeader.name] = value;
    }
    return h;
  };
  const resolved = (s: string | undefined) => (s === undefined ? undefined : substituteSecrets(s, getSecret));

  return {
    kind: "http.mutation",

    async describe(p) {
      // Every URL the secret header could be sent to, not just the primary one (adversarial
      // review: captureUrl pointed at a public host exfiltrated the credential).
      for (const [label, url] of [["url", p.url], ["rollback URL", p.rollback?.url], ["captureUrl", p.captureUrl], ["verifyUrl", p.verifyUrl]] as const) {
        if (url && !isLocalOrPrivateUrl(url)) throw new Error(`refused: ${label} ${url} is not a local or private-network address`);
      }
      if (p.headers && Object.entries(p.headers).some(([k, v]) => /authorization|token|api[-_]?key|cookie|secret|password/i.test(k) && !isCredentialFreeHeader(v))) {
        throw new Error("refused: credentials must be injected via secretHeader (by reference) or a {{secret:ref}} placeholder, never as a literal header");
      }
      if (p.body && LITERAL_CREDENTIAL.test(p.body)) {
        throw new Error("refused: the body contains a literal credential — write {{secret:<ref>}} in its place (create one with credential_create if needed)");
      }
      if (p.storeResponseField && !STORABLE_REF.test(p.storeResponseField.ref)) {
        throw new Error(`refused: storeResponseField.ref must be extension.<app>.<name>, got ${p.storeResponseField.ref}`);
      }
      for (const m of `${p.body ?? ""} ${p.url} ${Object.values(p.headers ?? {}).join(" ")}`.matchAll(SECRET_PLACEHOLDER)) {
        if (getSecret(m[1]) === null) throw new Error(`refused: placeholder references secret ${m[1]}, which is not set`);
      }
      const irreversible = !p.rollback && !(p.method === "PUT" && p.captureUrl);
      return {
        summary: `${p.method} ${p.url}`,
        autoApprove: false,
        class: p.method === "DELETE" ? "destructive" : "mutate",
        writes: [],
        network: true,
        irreversible,
        warning: irreversible ? "no undo request declared" : undefined,
        details: {
          method: p.method,
          url: p.url,
          body: p.body !== undefined ? p.body.slice(0, 4000) : null,
          headers: Object.keys(p.headers ?? {}),
          auth: p.secretHeader ? `${p.secretHeader.name} ← ${p.secretHeader.ref}` : null,
          verify: p.verifyUrl ?? null,
          rollback: p.rollback ? `${p.rollback.method} ${p.rollback.url}` : null,
          stores: p.storeResponseField ? `${p.storeResponseField.field} → ${p.storeResponseField.ref}` : null,
        },
      };
    },

    async captureState(p) {
      if (!p.captureUrl) return { before: null };
      return { before: await request("GET", resolved(p.captureUrl)!, { headers: authHeaders(p), timeoutMs: p.timeoutMs }) };
    },

    async apply(p) {
      const r = await request(p.method, resolved(p.url)!, { headers: authHeaders(p), body: resolved(p.body), contentType: p.contentType, timeoutMs: p.timeoutMs });
      outputs.set(p, { status: r.status, body: r.body });
      // Any 2xx is an applied write, whatever the plan predicted: a plan saying expectStatus
      // [200] against Jellyfin's real 204 rolled back an admin account the server had in fact
      // created (found live, run #5). expectStatus can only widen success (a 409 "already
      // exists" counts), never turn a 2xx into a false rollback.
      const ok = (r.status >= 200 && r.status < 300) || (p.expectStatus?.includes(r.status) ?? false);
      if (!ok) throw new Error(`${p.method} ${p.url} → ${r.status}: ${r.body.slice(0, 500)}`);
      if (p.storeResponseField) {
        // A missing field is reported, not thrown: the write happened (a login did log in), and
        // a false rollback is the worse outcome — the agent reads the keys and asks again.
        const { field, ref } = p.storeResponseField;
        let json: unknown = null;
        try { json = JSON.parse(r.body); } catch { /* not JSON */ }
        const value = fieldAt(json, field);
        if (typeof value === "string" || typeof value === "number") {
          setSecret(ref, String(value));
          outputs.set(p, { status: r.status, body: r.body, stored: ref });
        } else {
          const keys = json !== null && typeof json === "object" ? Object.keys(json as object).slice(0, 20).join(", ") : "not a JSON object";
          outputs.set(p, { status: r.status, body: r.body, stored: null, storeError: `response has no string field ${field} (top-level keys: ${keys})` });
        }
      }
    },

    async verify(p) {
      if (!p.verifyUrl) return true;
      const r = await request("GET", resolved(p.verifyUrl)!, { headers: authHeaders(p), timeoutMs: p.timeoutMs });
      if (r.status < 200 || r.status >= 300) return false;
      return p.verifyExpect ? r.body.includes(p.verifyExpect) : true;
    },

    async rollback(p, captured) {
      try {
        if (p.rollback) {
          await request(p.rollback.method, resolved(p.rollback.url)!, { headers: authHeaders(p), body: resolved(p.rollback.body), contentType: p.rollback.contentType, timeoutMs: p.timeoutMs });
        } else if (p.method === "PUT" && captured.before && captured.before.status >= 200 && captured.before.status < 300) {
          await request("PUT", resolved(p.url)!, { headers: authHeaders(p), body: captured.before.body, contentType: p.contentType ?? "application/json", timeoutMs: p.timeoutMs });
        }
      } catch (err) {
        console.error("[mirod] http rollback failed", err);
      }
    },
  };
}
