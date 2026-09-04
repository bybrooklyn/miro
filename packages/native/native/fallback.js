// Miro hardfork (PLAN.md §5.17): the Rust addon is OPTIONAL here. Upstream loads it eagerly at
// import and throws when it is missing, which took every Agent down with it - agent-core's
// tokenizer imports this package at module level. Miro's runtime path calls almost none of the
// 487 native exports, and the two it can reach (countTokens, and agent-sys's FileLock/Process on
// paths Miro never takes) both have documented degrade paths, so a missing addon must degrade the
// same way a missing optional tool does everywhere else in Miro: available, and honest when used.
//
// ponytail: byte-estimate tokenization when the addon is absent (agent-core's own fallback for
// unknown models), so context budgeting is approximate. Upgrade path: drop the built
// pi_natives.<platform>.node into this directory and the real addon loads with no code change.

export class NativeUnavailableError extends Error {
	constructor(name, cause) {
		super(`${name}: the native addon is not available (${String(cause?.message ?? cause).split("\n")[0]})`);
		this.name = "NativeUnavailableError";
	}
}

/** Bindings that resolve every property (so `export const X = bindings.X` at import time works)
 * to a function that throws only when called or constructed. The enums index.js exports are plain
 * objects that never touched the addon, so nothing else needs a real value. */
export function fallbackBindings(cause) {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (typeof prop !== "string") return undefined;
				return function unavailable() {
					throw new NativeUnavailableError(prop, cause);
				};
			},
		},
	);
}
