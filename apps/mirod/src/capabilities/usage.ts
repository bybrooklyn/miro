import type { Database } from "bun:sqlite";

// Per-provider usage and health (PLAN.md §5.14, the thin slice-1 layer): what the router needs to
// avoid an exhausted or unhealthy provider automatically. Plain bun:sqlite in the operations/store.ts
// shape, persisted so a restart keeps the picture. Every quota-shaped value carries its
// known / estimated / unknown tag - nothing here pretends to know a provider's remaining quota
// when all it has is its own counting.

export type Confidence = "known" | "estimated" | "unknown";

export interface UsageRecord {
  provider: string;
  requests: number;
  failures: number;
  consecutiveFailures: number;
  last429At: number | null;
  cooldownUntil: number | null;
  /** Exponentially weighted latency of successful calls. */
  ewmaLatencyMs: number | null;
  lastOkAt: number | null;
  /** Remaining quota - unknown until a provider tells us (headers, an API); estimated is ours. */
  remaining: { value: number | null; confidence: Confidence };
  updatedAt: number;
}

interface Row {
  provider: string;
  requests: number;
  failures: number;
  consecutive_failures: number;
  last_429_at: number | null;
  cooldown_until: number | null;
  ewma_latency_ms: number | null;
  last_ok_at: number | null;
  remaining: number | null;
  remaining_confidence: Confidence;
  updated_at: number;
}

function fromRow(row: Row): UsageRecord {
  return {
    provider: row.provider,
    requests: row.requests,
    failures: row.failures,
    consecutiveFailures: row.consecutive_failures,
    last429At: row.last_429_at,
    cooldownUntil: row.cooldown_until,
    ewmaLatencyMs: row.ewma_latency_ms,
    lastOkAt: row.last_ok_at,
    remaining: { value: row.remaining, confidence: row.remaining_confidence },
    updatedAt: row.updated_at,
  };
}

export function ensureUsageTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS capability_usage (
      provider TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_429_at INTEGER,
      cooldown_until INTEGER,
      ewma_latency_ms REAL,
      last_ok_at INTEGER,
      remaining INTEGER,
      remaining_confidence TEXT NOT NULL DEFAULT 'unknown',
      updated_at INTEGER NOT NULL
    )
  `);
}

/** A 429 cools the provider until its reset (when the response said) or this long. */
export const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
/** Repeated failures cool a provider briefly so a dead node stops eating the budget. */
export const FAILURE_COOLDOWN_MS = 5 * 60_000;
export const FAILURE_COOLDOWN_AFTER = 3;
const EWMA_ALPHA = 0.3;

export interface UsageOutcome {
  ok: boolean;
  ms: number;
  /** HTTP status when the failure was an HTTP response (429 drives the rate-limit cooldown). */
  status?: number;
  /** When the provider said its limit resets (from a header), epoch ms. */
  resetAt?: number;
  /** A remaining-quota value the provider reported (known) - never estimated here. */
  remaining?: number;
}

export interface UsageStore {
  record(provider: string, outcome: UsageOutcome, now?: number): UsageRecord;
  get(provider: string): UsageRecord | null;
  list(): UsageRecord[];
  inCooldown(provider: string, now?: number): boolean;
  /** 0..1: success rate (a never-seen provider starts at an even prior) discounted by latency and
   * staleness - the router sorts candidates by it. */
  score(provider: string, now?: number): number;
}

export function createUsageStore(db: Database): UsageStore {
  ensureUsageTable(db);
  const get = (provider: string): UsageRecord | null => {
    const row = db.query("SELECT * FROM capability_usage WHERE provider = ?").get(provider) as Row | null;
    return row ? fromRow(row) : null;
  };
  return {
    get,
    list: () => (db.query("SELECT * FROM capability_usage ORDER BY provider").all() as Row[]).map(fromRow),
    record(provider, outcome, now = Date.now()) {
      const prev = get(provider);
      const requests = (prev?.requests ?? 0) + 1;
      const failures = (prev?.failures ?? 0) + (outcome.ok ? 0 : 1);
      const consecutive = outcome.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
      const ewma = outcome.ok ? (prev?.ewmaLatencyMs === null || prev?.ewmaLatencyMs === undefined ? outcome.ms : prev.ewmaLatencyMs * (1 - EWMA_ALPHA) + outcome.ms * EWMA_ALPHA) : (prev?.ewmaLatencyMs ?? null);
      const rateLimited = outcome.status === 429;
      let cooldownUntil: number | null = outcome.ok ? null : (prev?.cooldownUntil ?? null);
      if (rateLimited) cooldownUntil = outcome.resetAt ?? now + RATE_LIMIT_COOLDOWN_MS;
      else if (!outcome.ok && consecutive >= FAILURE_COOLDOWN_AFTER) cooldownUntil = now + FAILURE_COOLDOWN_MS;
      const remaining = outcome.remaining !== undefined ? { value: outcome.remaining, confidence: "known" as const } : (prev?.remaining ?? { value: null, confidence: "unknown" as const });
      db.run(
        `INSERT INTO capability_usage (provider, requests, failures, consecutive_failures, last_429_at, cooldown_until, ewma_latency_ms, last_ok_at, remaining, remaining_confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           requests = excluded.requests, failures = excluded.failures, consecutive_failures = excluded.consecutive_failures,
           last_429_at = excluded.last_429_at, cooldown_until = excluded.cooldown_until, ewma_latency_ms = excluded.ewma_latency_ms,
           last_ok_at = excluded.last_ok_at, remaining = excluded.remaining, remaining_confidence = excluded.remaining_confidence,
           updated_at = excluded.updated_at`,
        [provider, requests, failures, consecutive, rateLimited ? now : (prev?.last429At ?? null), cooldownUntil, ewma, outcome.ok ? now : (prev?.lastOkAt ?? null), remaining.value, remaining.confidence, now],
      );
      return get(provider)!;
    },
    inCooldown(provider, now = Date.now()) {
      const r = get(provider);
      return r?.cooldownUntil !== null && r?.cooldownUntil !== undefined && r.cooldownUntil > now;
    },
    score(provider, now = Date.now()) {
      const r = get(provider);
      if (!r || r.requests === 0) return 0.5; // an even prior: untried is neither trusted nor avoided
      const successRate = 1 - r.failures / r.requests;
      const latency = r.ewmaLatencyMs === null ? 1 : 1 / (1 + r.ewmaLatencyMs / 5000);
      const stale = r.lastOkAt !== null && now - r.lastOkAt > 24 * 60 * 60_000 ? 0.8 : 1;
      return successRate * latency * stale;
    },
  };
}
