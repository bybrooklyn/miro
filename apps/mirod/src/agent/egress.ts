import type { Context, Model } from "@miro/model-client";
import { redactSecretsInText, isLocalOrPrivateUrl } from "../operations/classify";

// Sensitivity-tiered egress (PLAN.md §2367): before any message content leaves for an LLM provider,
// classify its sensitivity and keep it within what that provider is cleared to see. Three FIXED tiers
// (not a score): secret > internal > public. A provider's TRUST is what it may receive; content's
// SENSITIVITY is what it carries. The enforcement is redaction, not a score: secret-shaped strings
// never egress to anyone (defense in depth - redactSecretsInText already scrubs tool output on the
// way IN, this catches what the user typed, memory, the system prompt); infra identifiers (private
// IPs, internal hostnames) are redacted before a provider that is not cleared for `internal` (the
// free/anonymous endpoints that may train on inputs - PLAN.md §2368). The main no-train API providers
// (anthropic/openai/groq) are `internal`-cleared, so Miro can still reason about the box's topology
// with them. Pure + fail-closed, tested in-corpus like classify.ts. Round-tripping the placeholders
// back on the response, and a hard block, are a later slice; this slice redacts.

export type Tier = "public" | "internal" | "secret";
export const TIER_RANK: Record<Tier, number> = { public: 0, internal: 1, secret: 2 };

// What each provider is cleared to receive. Anything not listed - and every free/anonymous endpoint -
// falls through to `public` (fail closed): a router that trusts an unknown provider is a leak.
const DEFAULT_PROVIDER_TRUST: Record<string, Tier> = {
  ollama: "secret", // fully on-box
  anthropic: "internal", // API inputs are not trained on (PLAN.md §2368)
  openai: "internal",
  // The Codex/ChatGPT-OAuth login - Miro's usual primary model. Trusted as the brain the owner
  // deliberately chose: a sysadmin agent cannot reason about the box with its topology redacted, and
  // the moat's real job is secondary/untrusted endpoints, not the primary model (owner decision,
  // §5.33 live-verify). Tighten to public via egress.provider_tiers if ChatGPT training is a concern.
  "openai-codex": "internal",
  groq: "internal", // verified no-train, the only cleared free option (PLAN.md §2369)
};

/** The sensitivity tier a provider is cleared to receive. A local/private baseUrl is on-box -> secret
 * whatever the provider id; otherwise the setting override, then the default, then public (fail closed). */
export function providerTrust(provider: string, baseUrl: string | undefined, getSetting: (k: string) => string | null): Tier {
  if (baseUrl && isLocalOrPrivateUrl(baseUrl)) return "secret";
  const override = parseTrustOverride(getSetting)[provider];
  if (override) return override;
  return DEFAULT_PROVIDER_TRUST[provider] ?? "public";
}

export const PROVIDER_TIERS_SETTING = "egress.provider_tiers";
function parseTrustOverride(getSetting: (k: string) => string | null): Record<string, Tier> {
  const raw = getSetting(PROVIDER_TIERS_SETTING);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Tier> = {};
    for (const [k, v] of Object.entries(obj)) if (v === "public" || v === "internal" || v === "secret") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// ULA (fc00::/7) / link-local (fe80::/10) / loopback - IPv6 literals only.
const IPV6_PRIVATE = /\b(?:(?:fd|fc)[0-9a-f]{2}|fe80)(?::[0-9a-f]{0,4}){1,7}\b|(?<![:.\w])::1\b/gi;
// Hostnames under an internal domain, or a tailnet name. A bare single-label host is too ambiguous
// to redact without hitting ordinary words, so slice 1 leaves it (it is low-sensitivity anyway).
const INTERNAL_HOST = /\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|home\.arpa|ts\.net)\b/gi;

export interface Scrubbed {
  text: string;
  secretFound: boolean;
  infra: { count: number; types: string[] };
}

/** Scrub one text field for egress. Always removes secret-shaped strings (reusing the project's one
 * redactor, which protects {{secret:ref}} placeholders); when `redactInfra`, also replaces private
 * IPs and internal hostnames with typed placeholders. Reports what it did, for the audit + tier. */
export function scrubText(text: string, redactInfra: boolean): Scrubbed {
  const afterSecrets = redactSecretsInText(text);
  const secretFound = afterSecrets !== text;
  const types = new Set<string>();
  let count = 0;
  let out = afterSecrets;
  if (redactInfra) {
    out = out
      .replace(IPV4, (m) => (isPrivateIpv4(m) ? (types.add("private-ip"), count++, "[redacted-ip]") : m))
      .replace(IPV6_PRIVATE, () => (types.add("private-ip"), count++, "[redacted-ip]"))
      .replace(INTERNAL_HOST, () => (types.add("internal-host"), count++, "[redacted-host]"));
  } else {
    // Not redacting infra (a cleared provider), but still measure it for the tier + audit.
    for (const re of [IPV4, IPV6_PRIVATE, INTERNAL_HOST]) {
      for (const m of afterSecrets.matchAll(re)) {
        if (re === IPV4 && !isPrivateIpv4(m[0])) continue;
        types.add(re === INTERNAL_HOST ? "internal-host" : "private-ip");
        count++;
      }
    }
  }
  return { text: out, secretFound, infra: { count, types: [...types] } };
}

/** The sensitivity of a piece of content: secret if it carries secret-shaped strings, else internal
 * if it names the box's private topology, else public. Fail-closed ordering (secret wins). */
export function classifyContentTier(text: string): Tier {
  const s = scrubText(text, false);
  return s.secretFound ? "secret" : s.infra.count > 0 ? "internal" : "public";
}

export interface EgressAudit {
  provider: string;
  /** What the provider was cleared to receive. */
  trust: Tier;
  /** What the content actually carried (before redaction). */
  contentTier: Tier;
  secretRedacted: boolean;
  infraRedacted: number;
  redactedTypes: string[];
}

/** Scrub every text field in a message's content (string form, or the `text` of each TextContent in
 * the array form); image parts and tool-call structure pass through untouched. ponytail: tool-call
 * arguments (JSON in assistant messages) are not walked in slice 1 - they are the agent's own
 * generated commands, already classified on the way to execution. */
function scrubContent(content: unknown, scrub: (t: string) => string): unknown {
  if (typeof content === "string") return scrub(content);
  if (Array.isArray(content)) {
    return content.map((p) =>
      p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string"
        ? { ...(p as object), text: scrub((p as { text: string }).text) }
        : p,
    );
  }
  return content;
}

/** The egress gate agent-core's transformProviderContext hook calls: scrub the whole outbound context
 * to the tier the target provider is cleared for, and report what happened for the audit. Secret-shaped
 * strings are always removed; infra identifiers are removed only for a provider below `internal` trust. */
export function gateEgress(context: Context, model: Model, getSetting: (k: string) => string | null): { context: Context; audit: EgressAudit } {
  const trust = providerTrust(model.provider, model.baseUrl, getSetting);
  const redactInfra = TIER_RANK[trust] < TIER_RANK.internal;
  let secretFound = false;
  let infraCount = 0;
  const types = new Set<string>();
  const scrub = (t: string): string => {
    const s = scrubText(t, redactInfra);
    if (s.secretFound) secretFound = true;
    infraCount += s.infra.count;
    for (const ty of s.infra.types) types.add(ty);
    return s.text;
  };
  const systemPrompt = context.systemPrompt?.map(scrub);
  const messages = context.messages.map((m) => ({ ...m, content: scrubContent((m as { content: unknown }).content, scrub) }) as typeof m);
  const contentTier: Tier = secretFound ? "secret" : infraCount > 0 ? "internal" : "public";
  return {
    context: { ...context, systemPrompt, messages },
    audit: {
      provider: model.provider,
      trust,
      contentTier,
      secretRedacted: secretFound,
      infraRedacted: redactInfra ? infraCount : 0,
      redactedTypes: [...(secretFound ? ["secret"] : []), ...(redactInfra ? [...types] : [])],
    },
  };
}
