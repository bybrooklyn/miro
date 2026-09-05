// Outbound phone channels (PLAN.md §5.31). A sink turns a Notification into one HTTP POST to a push
// service the owner subscribes to. Two ship: ntfy (self-hosted, the product default) and Gotify
// (already running on the dev VM). A sink with no config is unavailable and skipped, like an
// unconfigured capability provider. The request shaping is pure (unit-tested); send() never throws -
// a dead push service must never take down the notify() that fired it.

export type NotifyTier = "routine" | "worth_knowing" | "needs_attention";

export interface Notification {
  tier: NotifyTier;
  title: string;
  body: string;
  source: string;
  at: number;
}

export interface Sink {
  name: string;
  available(): boolean;
  send(n: Notification): Promise<void>;
}

export interface HttpRequestSpec {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

const SINK_TIMEOUT_MS = 5_000;

// ntfy priority 1-5 (5 = max, buzzes/repeats). needs_attention is the only tier that reaches a
// phone at all, so worth_knowing/routine here are only for a caller that shaped a request directly.
function ntfyPriority(tier: NotifyTier): string {
  return tier === "needs_attention" ? "urgent" : "default";
}

function ntfyTags(tier: NotifyTier): string {
  return tier === "needs_attention" ? "warning" : "information_source";
}

/** ntfy: the topic is the address; the title is a header, the body is the payload. No auth on a
 * self-hosted node bound to the owner's own topic; a token would be an `Authorization: Bearer`
 * header when one is set (not needed for slice 1). */
export function buildNtfyRequest(n: Notification, cfg: { url: string; topic: string }): HttpRequestSpec {
  return {
    url: `${cfg.url.replace(/\/$/, "")}/${cfg.topic}`,
    method: "POST",
    headers: { Title: n.title, Priority: ntfyPriority(n.tier), Tags: ntfyTags(n.tier) },
    body: n.body || n.title,
  };
}

// Gotify priority: 0-3 low, 4-7 normal, 8+ high (a phone notification with sound). needs_attention
// is high; anything else normal.
function gotifyPriority(tier: NotifyTier): number {
  return tier === "needs_attention" ? 8 : 4;
}

/** Gotify: the app token authorizes the POST (in the URL query for a self-hosted node; PLAN.md §5.20
 * notes X-Gotify-Key is the header form). The token lives only in the outbound URL, never in the
 * Notification or a log line. */
export function buildGotifyRequest(n: Notification, cfg: { url: string; token: string }): HttpRequestSpec {
  return {
    url: `${cfg.url.replace(/\/$/, "")}/message?token=${encodeURIComponent(cfg.token)}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: n.title, message: n.body || n.title, priority: gotifyPriority(n.tier) }),
  };
}

/** Fire the shaped request, bounded and never throwing. Returns whether it was accepted (2xx), for
 * the config-test path; the fan-out path ignores the result. A non-2xx or a network error is
 * logged with the sink name and status only - never the URL (it carries the token) or the body. */
async function post(name: string, spec: HttpRequestSpec): Promise<boolean> {
  try {
    const res = await fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body, signal: AbortSignal.timeout(SINK_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[mirod] notify sink ${name} rejected: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[mirod] notify sink ${name} failed: ${err instanceof Error ? err.message : "error"}`);
    return false;
  }
}

export function ntfySink(getSetting: (key: string) => string | null): Sink {
  const url = () => getSetting("notify.ntfy.url");
  const topic = () => getSetting("notify.ntfy.topic");
  return {
    name: "ntfy",
    available: () => Boolean(url() && topic()),
    async send(n) {
      const u = url();
      const t = topic();
      if (!u || !t) return;
      await post("ntfy", buildNtfyRequest(n, { url: u, topic: t }));
    },
  };
}

export function gotifySink(getSetting: (key: string) => string | null, getSecret: (ref: string) => string | null): Sink {
  const url = () => getSetting("notify.gotify.url");
  // A fresh notify.gotify.token first; the learned extension's key as a fallback for a real box
  // (poisoned on the dev VM, PLAN.md §5.20 - the live test sets notify.gotify.token).
  const token = () => getSecret("notify.gotify.token") ?? getSecret("extension.gotify.api_key");
  return {
    name: "gotify",
    available: () => Boolean(url() && token()),
    async send(n) {
      const u = url();
      const tok = token();
      if (!u || !tok) return;
      await post("gotify", buildGotifyRequest(n, { url: u, token: tok }));
    },
  };
}

/** Send a fixed test notification through one sink with a proposed config, returning success. Used
 * by notify_configure to prove a channel works before its settings are persisted. */
export async function testSink(spec: HttpRequestSpec, name: string): Promise<boolean> {
  return post(name, spec);
}
