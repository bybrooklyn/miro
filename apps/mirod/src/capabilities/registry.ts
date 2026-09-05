import type { UsageStore } from "./usage";

// The capability layer (PLAN.md §5.14): the agent sees canonical capabilities; the runtime routes
// each to one or more provider implementations. web.search is the first; the shapes here are what
// every later capability (web.fetch, ...) and every extension-declared implementation slot into.

/** Dotted ids stay internal; the agent-facing tool name is the underscore form, which MUST satisfy
 * the Codex/Responses tool-name pattern that is already load-bearing project-wide. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

export function toolNameOf(capabilityId: string): string {
  const name = capabilityId.replace(/\./g, "_");
  if (!TOOL_NAME.test(name)) throw new Error(`capability id "${capabilityId}" does not map to a valid tool name`);
  return name;
}

export interface Capability<Req, Res> {
  id: string;
  /** Whether a result is worth returning: a fan-out takes the first GOOD one, and an empty list
   * from a healthy node is not a reason to stop asking the others. */
  isGood(result: Res): boolean;
}

export interface Implementation<Req, Res> {
  /** "ollama", "searxng.selfhosted", "searxng.public:<host>" - a prefix wildcard in a policy
   * ("searxng.public:*") selects a family. */
  id: string;
  capability: string;
  /** The usage/health key: the upstream account or node this implementation spends. */
  provider: string;
  meta: { auth: "none" | "key"; cost: "free" | "metered" | "self-hosted" };
  /** Keyed / configured right now - re-asked on every route, so a key added mid-session counts. */
  available(): boolean | Promise<boolean>;
  run(request: Req, signal: AbortSignal): Promise<Res>;
  timeoutMs?: number;
}

/** Thrown by an implementation for an HTTP-shaped failure, so usage can treat a 429 as a rate
 * limit (with the provider's reset time when it gave one) rather than a generic failure. */
export class ImplementationError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly resetAt?: number,
  ) {
    super(message);
    this.name = "ImplementationError";
  }
}

/** Groups are tried in order; within a group every candidate is fanned out and the first good
 * result wins. `fixed(x)` = [[x]]; ordered fallback = one id per group; a parallel pool = one
 * group of many. web.search's default is ordered-then-fanout: [["ollama"], ["searxng.selfhosted"],
 * ["searxng.public:*"]]. */
export interface Policy {
  groups: string[][];
}

export interface Attempt {
  impl: string;
  ok: boolean;
  ms: number;
  /** ok but not good (an empty result) - counts as a success for health, not as an answer. */
  empty?: boolean;
  error?: string;
}

export interface RouteResult<Res> {
  result: Res | null;
  impl: string | null;
  attempts: Attempt[];
}

export const DEFAULT_IMPL_TIMEOUT_MS = 8_000;
export const DEFAULT_TOTAL_BUDGET_MS = 12_000;
/** How many candidates of one group run concurrently - the best-scored ones. */
export const FANOUT_WIDTH = 3;

export class Registry {
  readonly #capabilities = new Map<string, Capability<any, any>>();
  readonly #policies = new Map<string, Policy>();
  readonly #impls = new Map<string, Implementation<any, any>>();

  constructor(readonly usage: UsageStore) {}

  registerCapability<Req, Res>(capability: Capability<Req, Res>, policy: Policy): void {
    toolNameOf(capability.id);
    this.#capabilities.set(capability.id, capability);
    this.#policies.set(capability.id, policy);
  }

  registerImplementation<Req, Res>(impl: Implementation<Req, Res>): void {
    if (!this.#capabilities.has(impl.capability)) throw new Error(`implementation "${impl.id}" targets unknown capability "${impl.capability}"`);
    this.#impls.set(impl.id, impl);
  }

  /** Drops every implementation whose id starts with `prefix` - how a refreshed public pool
   * replaces the previous one. */
  unregisterImplementations(prefix: string): void {
    for (const id of [...this.#impls.keys()]) if (id.startsWith(prefix)) this.#impls.delete(id);
  }

  capabilities(): Capability<any, any>[] {
    return [...this.#capabilities.values()];
  }

  implementations(capabilityId?: string): Implementation<any, any>[] {
    return [...this.#impls.values()].filter((i) => !capabilityId || i.capability === capabilityId);
  }

  policy(capabilityId: string): Policy | undefined {
    return this.#policies.get(capabilityId);
  }

  /** Expands a policy group into registered, available, not-cooling implementations of the
   * capability, best health first, at most FANOUT_WIDTH. */
  async candidates(capabilityId: string, group: string[]): Promise<Implementation<any, any>[]> {
    const selected: Implementation<any, any>[] = [];
    for (const pattern of group) {
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        for (const impl of this.implementations(capabilityId)) if (impl.id.startsWith(prefix)) selected.push(impl);
      } else {
        const impl = this.#impls.get(pattern);
        if (impl && impl.capability === capabilityId) selected.push(impl);
      }
    }
    const ready: Implementation<any, any>[] = [];
    for (const impl of selected) {
      if (this.usage.inCooldown(impl.provider)) continue;
      if (!(await impl.available())) continue;
      ready.push(impl);
    }
    return ready.sort((a, b) => this.usage.score(b.provider) - this.usage.score(a.provider)).slice(0, FANOUT_WIDTH);
  }

  async route<Req, Res>(capabilityId: string, request: Req, policy?: Policy, budgetMs = DEFAULT_TOTAL_BUDGET_MS): Promise<RouteResult<Res>> {
    const capability = this.#capabilities.get(capabilityId) as Capability<Req, Res> | undefined;
    if (!capability) throw new Error(`unknown capability "${capabilityId}"`);
    const groups = (policy ?? this.#policies.get(capabilityId) ?? { groups: [["*"]] }).groups;
    const deadline = Date.now() + budgetMs;
    const attempts: Attempt[] = [];
    for (const group of groups) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const candidates = await this.candidates(capabilityId, group);
      if (candidates.length === 0) continue;
      const winner = await this.#fanout(capability, candidates, request, remaining, attempts);
      if (winner) return { result: winner.result, impl: winner.impl, attempts };
    }
    return { result: null, impl: null, attempts };
  }

  /** Runs the candidates concurrently; the first GOOD result wins and aborts the rest. Every
   * outcome is recorded against the implementation's provider. */
  #fanout<Req, Res>(capability: Capability<Req, Res>, candidates: Implementation<Req, Res>[], request: Req, remainingMs: number, attempts: Attempt[]): Promise<{ result: Res; impl: string } | null> {
    return new Promise((resolve) => {
      const group = new AbortController();
      let pending = candidates.length;
      let settled = false;
      const finish = (value: { result: Res; impl: string } | null) => {
        if (settled) return;
        settled = true;
        group.abort();
        resolve(value);
      };
      for (const impl of candidates) {
        const started = Date.now();
        const signal = AbortSignal.any([group.signal, AbortSignal.timeout(Math.min(impl.timeoutMs ?? DEFAULT_IMPL_TIMEOUT_MS, remainingMs))]);
        Promise.resolve()
          .then(() => impl.run(request, signal))
          .then(
            (result) => {
              const ms = Date.now() - started;
              const good = capability.isGood(result);
              this.usage.record(impl.provider, { ok: true, ms });
              attempts.push({ impl: impl.id, ok: true, ms, ...(good ? {} : { empty: true }) });
              if (good) finish({ result, impl: impl.id });
            },
            (err: unknown) => {
              const ms = Date.now() - started;
              // A loser cancelled because another candidate already won is not a failure of its own.
              if (settled && group.signal.aborted && (err as Error)?.name === "AbortError") return;
              const status = err instanceof ImplementationError ? err.status : undefined;
              const resetAt = err instanceof ImplementationError ? err.resetAt : undefined;
              this.usage.record(impl.provider, { ok: false, ms, status, resetAt });
              attempts.push({ impl: impl.id, ok: false, ms, error: String((err as Error)?.message ?? err) });
            },
          )
          .finally(() => {
            if (--pending === 0) finish(null);
          });
      }
    });
  }
}
