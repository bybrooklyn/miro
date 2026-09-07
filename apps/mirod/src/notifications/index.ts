import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { ensureNotificationsTable, insertNotification, listUndelivered, markDelivered, recentByTitle } from "./store";
import { buildGotifyRequest, buildNtfyRequest, gotifySink, ntfySink, testSink, type Notification, type NotifyTier, type Sink } from "./sinks";
import { redactSecretsInText } from "../operations/classify";

// The daemon's one notification bus (PLAN.md §5.31). Like the capability layer, it is configured
// once at boot and reached by background code through this module (never by threading a parameter):
// a repair that gives up, drift, an auto-rollback, and the agent's own notify tool all call the
// top-level notify(). Unconfigured (a test harness, a bare import) is a no-op, never a throw.
//
// One rule carries the whole autonomy decision: a notification reaches the phone sinks iff its tier
// is `needs_attention`. The agent reaches the phone by choosing that tier for anything it judges
// worth interrupting the owner; the mechanical important signals use it. worth_knowing is the
// connected/next-connect TUI only; routine is log-only.

export type { NotifyTier, Notification };

/** The load-bearing autonomy rule, in one place so it is testable and unmistakable. */
export function reachesPhone(tier: NotifyTier): boolean {
  return tier === "needs_attention";
}

const LEVEL: Record<NotifyTier, "info" | "warn"> = { routine: "info", worth_knowing: "info", needs_attention: "warn" };

// Quiet-competence tiers (PLAN.md §quiet-competence): the owner's "quiet this kind" feedback tiers a
// notification CLASS down over time, "keep" resets it. Stored as a per-source demote offset; applied
// in notify() before the phone/broadcast decision. Most→least attention:
const TIER_ORDER: NotifyTier[] = ["needs_attention", "worth_knowing", "routine"];
export function demoteTier(tier: NotifyTier, steps: number): NotifyTier {
  if (steps <= 0) return tier;
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, i + steps)]!;
}
const MAX_DEMOTE = 2; // needs_attention -> worth_knowing -> routine
function demoteKey(source: string): string {
  return `notify.demote.${source}`;
}

/** A notification as the client-facing notice line. Carries `source` so the client can offer
 * "quiet this kind" feedback (notice_feedback). */
export function noticeFor(n: { tier: NotifyTier; title: string; body: string; source?: string }): Extract<ServerEvent, { type: "notice" }> {
  return { type: "notice", level: LEVEL[n.tier], text: n.body ? `${n.title}\n${n.body}` : n.title, source: n.source };
}

/** Apply "quiet this kind" / "keep" feedback: quiet tiers the class down one step (capped), keep
 * resets it to its natural tier. Returns the new offset, or null when the bus is unconfigured. */
export function applyNoticeFeedback(source: string, action: "quiet" | "keep"): { source: string; demote: number } | null {
  if (!configured) return null;
  const cur = Number(configured.getSetting(demoteKey(source)) ?? 0) || 0;
  const next = action === "quiet" ? Math.min(MAX_DEMOTE, cur + 1) : 0;
  configured.setSetting(demoteKey(source), String(next));
  return { source, demote: next };
}

export interface NotifyDeps {
  db: Database;
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  getSecret: (ref: string) => string | null;
  /** Deliver an event to every connected client; returns how many received it. */
  broadcast: (event: ServerEvent) => number;
}

interface Configured extends NotifyDeps {
  sinks: Sink[];
}

let configured: Configured | null = null;

// A phone push for a recurring signal is suppressed if the same title went out within this window;
// the notification is still persisted and shown in the TUI. ponytail: title-keyed, one global
// window - a per-source cooldown if this proves too coarse.
const PHONE_DEDUP_MS = 12 * 60 * 60_000;

export function configureNotifications(deps: NotifyDeps): void {
  ensureNotificationsTable(deps.db);
  const sinks = [ntfySink(deps.getSetting), gotifySink(deps.getSetting, deps.getSecret)];
  configured = { ...deps, sinks };
}

/** Tests only - a test that configures the singleton must unconfigure it (audit T1 pattern). */
export function resetNotifications(): void {
  configured = null;
}

/** Fire-and-forget, never throws. Persists first (survives a broadcast/phone failure), delivers to
 * connected TUIs, and phones the needs_attention ones. */
export function notify(input: Notification): void {
  if (!configured) return;
  const { db, broadcast, sinks, getSetting } = configured;
  try {
    // Learned per-class tier (§quiet-competence): the owner's "quiet this kind" feedback tiers this
    // source down; needs_attention can become worth_knowing (no phone) or routine (log only).
    const demote = Number(getSetting(demoteKey(input.source)) ?? 0) || 0;
    // Redaction choke point (same guarantee memory's remember() gives): a title or body must never
    // carry a secret to a phone, the TUI, or the store - a repair error, a drift message, or a
    // model-written notify could contain one. Everything downstream uses the redacted copy.
    const n: Notification = { ...input, tier: demoteTier(input.tier, demote), title: redactSecretsInText(input.title), body: redactSecretsInText(input.body) };
    const id = crypto.randomUUID();
    // Decide the phone push BEFORE persisting: recentByTitle must not match the row we are about to
    // insert, or every needs_attention would dedup against itself and never reach a sink (found
    // live, §5.31 - the first phone fan-out silently suppressed).
    const phone = reachesPhone(n.tier) && !recentByTitle(db, n.title, PHONE_DEDUP_MS);

    let deliveredAt: number | null = null;
    if (n.tier !== "routine") {
      const reached = broadcast(noticeFor(n));
      if (reached > 0) deliveredAt = Date.now();
    }
    insertNotification(db, { id, tier: n.tier, title: n.title, body: n.body, source: n.source, createdAt: n.at, tuiDeliveredAt: deliveredAt });

    if (phone) for (const sink of sinks) if (sink.available()) void sink.send(n);
  } catch (err) {
    // The bus must never take down its caller (a background sweep, an operation's onTerminal).
    console.warn(`[mirod] notify failed: ${err instanceof Error ? err.message : "error"}`);
  }
}

/** On a new connection: replay every worth_knowing+ notification the owner has not yet seen, and
 * mark them delivered. Generalizes the reboot boot_report to a durable queue. */
export function replayUndelivered(send: (event: ServerEvent) => void): void {
  if (!configured) return;
  const pending = listUndelivered(configured.db);
  for (const rec of pending) send(noticeFor(rec));
  markDelivered(configured.db, pending.map((p) => p.id));
}

export interface ChannelStatus {
  name: string;
  configured: boolean;
}

export function channelStatus(): ChannelStatus[] {
  if (!configured) return [];
  return configured.sinks.map((s) => ({ name: s.name, configured: s.available() }));
}

/** One line for the per-turn context so the agent knows whether a needs_attention will reach a
 * phone before it relies on one. */
export function notificationChannelLines(): string[] {
  const status = channelStatus();
  if (status.length === 0) return [];
  return [`Notification channels (needs_attention reaches these): ${status.map((s) => `${s.name} (${s.configured ? "configured" : "not configured"})`).join(", ")}`];
}

/** notify_configure's core: prove the channel works with the proposed config, and persist its
 * settings ONLY on success. The gotify token is already in the secret store (captured via ask_user
 * secretRef) - it is read here, put only in the outbound URL, never returned or logged. */
export async function testAndConfigure(channel: "ntfy" | "gotify", cfg: { url: string; topic?: string }): Promise<{ ok: boolean; reason?: string }> {
  if (!configured) return { ok: false, reason: "notifications not configured" };
  const { setSetting, getSecret } = configured;
  const test: Notification = { tier: "needs_attention", title: "Miro notifications connected", body: `This ${channel} channel is now set up.`, source: "configure", at: Date.now() };
  if (channel === "ntfy") {
    if (!cfg.topic) return { ok: false, reason: "ntfy needs a topic" };
    const ok = await testSink(buildNtfyRequest(test, { url: cfg.url, topic: cfg.topic }), "ntfy");
    if (!ok) return { ok: false, reason: "the ntfy server did not accept a test notification" };
    setSetting("notify.ntfy.url", cfg.url);
    setSetting("notify.ntfy.topic", cfg.topic);
    return { ok: true };
  }
  const token = getSecret("notify.gotify.token") ?? getSecret("extension.gotify.api_key");
  if (!token) return { ok: false, reason: "no Gotify app token on file - store one first (notify.gotify.token)" };
  const ok = await testSink(buildGotifyRequest(test, { url: cfg.url, token }), "gotify");
  if (!ok) return { ok: false, reason: "the Gotify server did not accept a test notification" };
  setSetting("notify.gotify.url", cfg.url);
  return { ok: true };
}
