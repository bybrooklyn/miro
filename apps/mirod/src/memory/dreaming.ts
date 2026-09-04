import type { Model } from "@miro/model-client";
import type { ModelRegistry } from "../agent/models";
import { spawnWorker } from "../agent/worker";
import { remember, WRITABLE_MEMORY_CATEGORIES, type MemoryCategory } from "./store";
import type { Database } from "bun:sqlite";
import type { ReflectionTrigger } from "../operations/engine";

// Reflexion-shaped background reflection (plan §36-37): a narrow, budgeted LLM call that decides
// whether a real event (a repeated-failure pattern, a user correction) reveals a durable fact worth
// remembering. Deliberately NOT fired on every operation - the mechanical write in
// operations/engine.ts already covers "log what happened" for free; this is only for when a pattern
// justifies the extra cost.

const WRITABLE_CATEGORIES = new Set<string>(WRITABLE_MEMORY_CATEGORIES);

const INSTRUCTIONS = `Review the event below and decide if it reveals a durable fact worth remembering about
this user or their server - a preference, a server fact, or a pattern. Most events reveal nothing new; it's
correct to remember nothing. Respond with ONLY a JSON object, no other text:
{"remember": [{"category": "preference"|"server_fact"|"incident", "key": "short_stable_slug", "value": "one sentence"}]}
Use an empty array if there's nothing worth keeping. Keep "key" stable and generic (e.g. "reply_style",
"backup_schedule") so the same fact reinforces itself next time instead of duplicating.

Event:
`;

export function parseRememberJson(text: string): { category: string; key: string; value: string }[] {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const obj = match ? JSON.parse(match[0]) : null;
    return Array.isArray(obj?.remember) ? obj.remember : [];
    // ponytail: no schema validation beyond the shape check below - a malformed field just gets
    // skipped per-item rather than failing the whole reflection.
  } catch {
    return []; // best-effort backstop - a parse failure is a silent no-op, not an error path
  }
}

async function runReflection(
  db: Database,
  models: ModelRegistry,
  model: Model<any>,
  context: string,
): Promise<void> {
  const result = await spawnWorker(`${INSTRUCTIONS}${context}`, [], models, model, 1);
  for (const item of parseRememberJson(result.text)) {
    if (!WRITABLE_CATEGORIES.has(item.category) || !item.key?.trim() || !item.value?.trim()) continue;
    remember(db, item.category as MemoryCategory, item.key.trim().slice(0, 60), item.value.trim().slice(0, 500), "reflection");
  }
}

export async function reflectOnOperation(
  db: Database,
  models: ModelRegistry,
  model: Model<any>,
  trigger: ReflectionTrigger,
): Promise<void> {
  const context = `An operation just finished.
Goal: ${trigger.goal}
Kind: ${trigger.kind}
Outcome: ${trigger.outcome}
Detail: ${trigger.message}
This is the ${trigger.repeatFailureCount}th time a ${trigger.kind} operation has failed - this may be a pattern worth flagging.`;
  await runReflection(db, models, model, context);
}

export async function reflectOnCorrection(
  db: Database,
  models: ModelRegistry,
  model: Model<any>,
  previousReply: string,
  correction: string,
): Promise<void> {
  const context = `The user appears to have corrected Miro's previous reply.
Miro said: ${previousReply}
User then said: ${correction}`;
  await runReflection(db, models, model, context);
}

const CORRECTION_PATTERNS = [
  /^no[,.]?\b/i,
  /\bnot what i (asked|meant|wanted)\b/i,
  /\bthat'?s (not|wrong)\b/i,
  /\bi meant\b/i,
  /\bactually[, ]/i,
  /\bdon'?t do that\b/i,
];

// ponytail: naive keyword/regex heuristic, no real NLU - upgrade to a real classifier if
// false-positive rate matters.
export function isLikelyCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((re) => re.test(text.trim()));
}
