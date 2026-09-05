import { Type } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import type { Database } from "bun:sqlite";
import { remember, query, confidenceLabel } from "../memory/store";

// Plain JSON-Schema `enum` (Type.Enum emits exactly {type:"string", enum:[...]}), not Type.Union-
// of-Type.Literal's `anyOf`-of-`const`. Live-tested against a real tool-calling model (Ollama
// gemma4:31b-cloud): the anyOf/const form made the model repeatedly fail to produce a valid category
// and give up on calling the tool at all - a plain `enum` is the far more universally-supported
// function-calling schema shape. (Not Type.Unsafe: the vendored schema engine drops raw JSON Schema
// to `any`, which would silently lose the enum on the wire - found while migrating, PLAN.md §5.17.)
const writableCategoryEnum = Type.Enum(["preference", "server_fact", "incident", "capability"], {
  description: "capability = the operational model of a system you set up or learned (value is a JSON document: summary, components, dataFlow, credentials as secret refs, verify steps).",
});
const anyCategoryEnum = Type.Enum(["preference", "server_fact", "incident", "app_knowledge", "extension_knowledge", "research", "capability"]);

const rememberParams = Type.Object({
  category: writableCategoryEnum,
  key: Type.String({
    description:
      "Short stable slug for the fact's subject, e.g. 'reply_style', 'backup_schedule.postgres', or for a capability the system's name ('jellyfin', 'media_acquisition'). Reuse the same key when this exact fact recurs.",
  }),
  value: Type.String({ description: "The fact itself, one sentence, human-readable - or for a capability, a JSON document with summary, components, dataFlow, credentials (secret refs only, never values), verify." }),
});

const queryParams = Type.Object({
  category: Type.Optional(anyCategoryEnum),
  keyword: Type.Optional(Type.String({ description: "Filter by text in the key or value." })),
});

/** Memory tools (plan §37) - mutating but not tracked operations: no plan/confirm/rollback
 * semantics apply to Miro's own notes about the user/server, so these don't go through
 * runOperation. Not added to agent/tools.ts's AGENT_TOOLS (spawnWorker's read-only set) - same
 * "authority stays separate" boundary already drawn for operation-tools.ts. */
export function buildMemoryTools(db: Database) {
  return [
    {
      name: "memory_remember",
      label: "Remember",
      description:
        "Save a durable fact about this user or server - a preference, a server fact, or an incident. Calling this again with the same category+key reinforces the existing fact instead of duplicating it.",
      parameters: rememberParams,
      execute: async (_id: string, params: { category: "preference" | "server_fact" | "incident" | "capability"; key: string; value: string }) => {
        const rec = remember(db, params.category, params.key, params.value, "agent_tool");
        return textResult({ saved: true, occurrenceCount: rec.occurrenceCount, confidence: confidenceLabel(rec.occurrenceCount) });
      },
    },
    {
      name: "memory_query",
      label: "Query memory",
      description: "Look up previously remembered facts about this user or server, optionally filtered by category or keyword.",
      parameters: queryParams,
      execute: async (_id: string, params: { category?: string; keyword?: string }) => {
        const rows = query(db, { category: params.category as any, keyword: params.keyword, limit: 20 });
        return textResult(rows.map((r) => ({ category: r.category, key: r.key, value: r.value, confidence: confidenceLabel(r.occurrenceCount) })));
      },
    },
  ];
}
