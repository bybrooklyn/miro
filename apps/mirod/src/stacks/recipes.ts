import type { Database } from "bun:sqlite";
import { remember, getByKey, bumpHelpful, bumpHarmful } from "../memory/store";

// Self-learning install recipes (PLAN.md compose-killer slice 2, §5.13 machine-earned knowledge).
// A recipe = a compose Miro proved works for an app, stored on the existing `capability` memory
// category so it carries occurrence_count (reinforcement) + helpful/harmful (the outcome loop) +
// provenance for free. Reused before generating a fresh compose, and demoted when it stops working.
// NOT a hand-curated catalog - the catalog is EARNED and self-improving. Local now; the schema is
// already sharing-ready (a future community exchange, with an anti-poisoning story, is a later slice).

const RECIPE_KEY = (app: string) => `stack:${app}`; // namespaced so it never collides with an ext capability

export interface StackRecipe {
  id: string;
  app: string;
  compose: string;
  source: string;
  timesSeen: number;
  helpful: number;
  harmful: number;
  /** false once a recipe has failed more than it's helped - the agent should regenerate, not reuse. */
  reliable: boolean;
}

/** Store or reinforce the proven recipe for an app after a VERIFIED deploy. Returns the row id so the
 * caller can attribute the outcome. `source` is "generated" (fresh) or "reused" (a recipe redeployed). */
export function recordRecipe(db: Database, app: string, compose: string, source: string): string {
  const rec = remember(db, "capability", RECIPE_KEY(app), JSON.stringify({ kind: "stack", app, compose, source }), "stack.deploy", null, { observedAt: Date.now() });
  return rec.id;
}

export function getRecipe(db: Database, app: string): StackRecipe | null {
  const rec = getByKey(db, "capability", RECIPE_KEY(app));
  if (!rec) return null;
  let v: any;
  try {
    v = JSON.parse(rec.value);
  } catch {
    return null;
  }
  if (v?.kind !== "stack" || typeof v.compose !== "string") return null; // a non-stack capability under this key
  return {
    id: rec.id,
    app,
    compose: v.compose,
    source: typeof v.source === "string" ? v.source : "unknown",
    timesSeen: rec.occurrenceCount,
    helpful: rec.helpfulCount,
    harmful: rec.harmfulCount,
    reliable: rec.harmfulCount <= rec.helpfulCount,
  };
}

/** A recipe-guided deploy that verified - the recipe worked again. */
export function recipeWorked(db: Database, id: string): void {
  bumpHelpful(db, id);
}

/** A recipe-guided deploy that rolled back - the recipe failed; getRecipe.reliable flips when
 * harmful overtakes helpful, steering the agent to regenerate rather than reuse it. */
export function recipeFailed(db: Database, id: string): void {
  bumpHarmful(db, id);
}
