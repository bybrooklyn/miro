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
  /** Statuses that count as success (default: any 2xx). */
  expectStatus?: number[];
  /** GET before apply — the captured representation rollback can restore for PUT. */
  captureUrl?: string;
  /** GET after apply; success = 2xx, plus `verifyExpect` substring if given. */
  verifyUrl?: string;
  verifyExpect?: string;
  /** Explicit undo request. Without it, only PUT-with-captureUrl is reversible. */
  rollback?: { method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: string; contentType?: string };
  timeoutMs?: number;
}

export interface HttpMutationCaptured {
  before: { status: number; body: string } | null;
}

export interface HttpMutationOutput {
  status: number;
  body: string;
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

export function httpMutationKind(getSecret: (ref: string) => string | null): OperationKind<HttpMutationParams, HttpMutationCaptured> {
  const authHeaders = (p: HttpMutationParams): Record<string, string> => {
    const h: Record<string, string> = { ...(p.headers ?? {}) };
    if (p.secretHeader) {
      const value = getSecret(p.secretHeader.ref);
      if (!value) throw new Error(`secret ${p.secretHeader.ref} is not set`);
      h[p.secretHeader.name] = value;
    }
    return h;
  };

  return {
    kind: "http.mutation",

    async describe(p) {
      // Every URL the secret header could be sent to, not just the primary one (adversarial
      // review: captureUrl pointed at a public host exfiltrated the credential).
      for (const [label, url] of [["url", p.url], ["rollback URL", p.rollback?.url], ["captureUrl", p.captureUrl], ["verifyUrl", p.verifyUrl]] as const) {
        if (url && !isLocalOrPrivateUrl(url)) throw new Error(`refused: ${label} ${url} is not a local or private-network address`);
      }
      if (p.headers && Object.keys(p.headers).some((k) => /authorization|token|api[-_]?key|cookie|secret|password/i.test(k))) {
        throw new Error("refused: credentials must be injected via secretHeader (by reference), never as a literal header");
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
        },
      };
    },

    async captureState(p) {
      if (!p.captureUrl) return { before: null };
      return { before: await request("GET", p.captureUrl, { headers: authHeaders(p), timeoutMs: p.timeoutMs }) };
    },

    async apply(p) {
      const r = await request(p.method, p.url, { headers: authHeaders(p), body: p.body, contentType: p.contentType, timeoutMs: p.timeoutMs });
      outputs.set(p, r);
      const ok = p.expectStatus ? p.expectStatus.includes(r.status) : r.status >= 200 && r.status < 300;
      if (!ok) throw new Error(`${p.method} ${p.url} → ${r.status}: ${r.body.slice(0, 500)}`);
    },

    async verify(p) {
      if (!p.verifyUrl) return true;
      const r = await request("GET", p.verifyUrl, { headers: authHeaders(p), timeoutMs: p.timeoutMs });
      if (r.status < 200 || r.status >= 300) return false;
      return p.verifyExpect ? r.body.includes(p.verifyExpect) : true;
    },

    async rollback(p, captured) {
      try {
        if (p.rollback) {
          await request(p.rollback.method, p.rollback.url, { headers: authHeaders(p), body: p.rollback.body, contentType: p.rollback.contentType, timeoutMs: p.timeoutMs });
        } else if (p.method === "PUT" && captured.before && captured.before.status >= 200 && captured.before.status < 300) {
          await request("PUT", p.url, { headers: authHeaders(p), body: captured.before.body, contentType: p.contentType ?? "application/json", timeoutMs: p.timeoutMs });
        }
      } catch (err) {
        console.error("[mirod] http rollback failed", err);
      }
    },
  };
}
