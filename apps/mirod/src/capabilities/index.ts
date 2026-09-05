import type { Database } from "bun:sqlite";
import { Registry } from "./registry";
import { createUsageStore } from "./usage";
import { installPublicPool, refreshPublicPool, registerWebSearch, searchWeb as searchWebOn, PUBLIC_POOL_SETTING, type PublicPool, type WebSearchAnswer } from "./web-search";

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

/** Re-probe searx.space for JSON-capable public nodes and swap them in. Idle-timer work. */
export async function refreshWebSearchPool(): Promise<PublicPool | null> {
  if (!configured) return null;
  const pool = await refreshPublicPool();
  configured.deps.setSetting(PUBLIC_POOL_SETTING, JSON.stringify(pool));
  installPublicPool(configured.registry, pool);
  return pool;
}
