import type { Database } from "bun:sqlite";
import { Registry } from "./registry";
import { createUsageStore } from "./usage";
import { installPublicPool, refreshPublicPool, registerWebSearch, searchWeb as searchWebOn, PUBLIC_POOL_SETTING, type PublicPool, type WebSearchAnswer } from "./web-search";
import { fetchWeb as fetchWebOn, registerWebFetch, type WebFetchAnswer } from "./web-fetch";

// The daemon's one registry (PLAN.md §5.14). The read-only tool list (agent/tools.ts) is static -
// no context flows into it - so the capability layer is configured once at boot and reached
// through this module; tests build their own Registry.

export interface CapabilityDeps {
  db: Database;
  getStoredKey: (provider: string) => string | null;
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
}

let configured: { registry: Registry; deps: CapabilityDeps } | null = null;

export function configureCapabilities(deps: CapabilityDeps): Registry {
  const registry = new Registry(createUsageStore(deps.db));
  registerWebSearch(registry, deps);
  registerWebFetch(registry, deps);
  const cached = deps.getSetting(PUBLIC_POOL_SETTING);
  if (cached) {
    try {
      installPublicPool(registry, JSON.parse(cached) as PublicPool);
    } catch {
      // a corrupt cache is just the bundled seed until the next refresh
    }
  }
  configured = { registry, deps };
  return registry;
}

export function capabilityRegistry(): Registry | null {
  return configured?.registry ?? null;
}

/** The web_search tool's entry point. Unconfigured (a test harness, a bare import) means
 * unavailable, never a throw. */
export async function searchWeb(query: string, maxResults?: number): Promise<WebSearchAnswer> {
  if (!configured) return { available: false, results: [], source: null, attempts: [] };
  return searchWebOn(configured.registry, query, maxResults);
}

/** The web_fetch tool's entry point - same unconfigured behaviour as searchWeb. */
export async function fetchWeb(url: string, maxChars?: number): Promise<WebFetchAnswer> {
  if (!configured) return { available: false, title: "", content: "", truncated: false, links: [], source: null, attempts: [] };
  return fetchWebOn(configured.registry, url, maxChars);
}

export interface ImplementationStatus {
  id: string;
  capability: string;
  provider: string;
  meta: { auth: "none" | "key"; cost: "free" | "metered" | "self-hosted" };
  /** Configured/keyed right now; "unknown" when availability needs an async check. */
  available: boolean | "unknown";
  coolingDown: boolean;
  health: { score: number; requests: number; failures: number; last429At: number | null; remaining: { value: number | null; confidence: string } } | null;
}

/** Every registered implementation with its live health - what the `capabilities` tool and the
 * context block show the agent, so it knows which providers it actually has (PLAN.md §5.14). */
export function capabilityStatus(): ImplementationStatus[] {
  if (!configured) return [];
  const { registry } = configured;
  return registry.implementations().map((impl) => {
    const a = impl.available();
    const usage = registry.usage.get(impl.provider);
    return {
      id: impl.id,
      capability: impl.capability,
      provider: impl.provider,
      meta: impl.meta,
      available: typeof a === "boolean" ? a : "unknown",
      coolingDown: registry.usage.inCooldown(impl.provider),
      health: usage ? { score: Number(registry.usage.score(impl.provider).toFixed(2)), requests: usage.requests, failures: usage.failures, last429At: usage.last429At, remaining: usage.remaining } : null,
    };
  });
}

/** One line per capability for the per-turn context: which providers exist and which are usable. */
export function capabilityContextLines(): string[] {
  const status = capabilityStatus();
  const byCapability = new Map<string, ImplementationStatus[]>();
  for (const s of status) byCapability.set(s.capability, [...(byCapability.get(s.capability) ?? []), s]);
  const stateOf = (s: ImplementationStatus) => (s.available === false ? "not configured" : s.coolingDown ? "cooling down" : s.available === "unknown" ? "unverified" : s.health ? `ok, score ${s.health.score}` : "ready");
  return [...byCapability.entries()].map(([capability, impls]) => {
    const parts: string[] = [];
    // The public pool is one line item with a count - its node names are noise to the agent.
    const pool = impls.filter((s) => s.id.startsWith("searxng.public:"));
    for (const s of impls) if (!pool.includes(s)) parts.push(`${s.id} (${stateOf(s)})`);
    if (pool.length > 0) parts.push(`searxng.public (${pool.length} node${pool.length === 1 ? "" : "s"}, ${pool.some((s) => s.available !== false && !s.coolingDown) ? "ready" : "cooling down"})`);
    return `${capability.replace(".", "_")}: ${parts.join(", ")}`;
  });
}

/** Re-probe searx.space for JSON-capable public nodes and swap them in. Idle-timer work. */
export async function refreshWebSearchPool(): Promise<PublicPool | null> {
  if (!configured) return null;
  const pool = await refreshPublicPool();
  configured.deps.setSetting(PUBLIC_POOL_SETTING, JSON.stringify(pool));
  installPublicPool(configured.registry, pool);
  return pool;
}
