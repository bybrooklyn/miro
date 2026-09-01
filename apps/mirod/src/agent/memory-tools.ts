import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "bun:sqlite";
import { remember, query, confidenceLabel } from "../memory/store";

function textResult(details: unknown): AgentToolResult<unknown> {
  // details ?? null: JSON.stringify(undefined) returns the value undefined (not a string),
  // producing a malformed {text: undefined} block — see agent/extension-tools.ts's textResult.
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

// Plain JSON-Schema `enum` (via Type.Unsafe), not Type.Union-of-Type.Literal's `anyOf`-of-`const`.
// Live-tested against a real tool-calling model (Ollama gemma4:31b-cloud): the anyOf/const form
// made the model repeatedly fail to produce a valid category and give up on calling the tool at
// all — a plain `enum` is the far more universally-supported function-calling schema shape.
const writableCategoryEnum = Type.Unsafe<"preference" | "server_fact" | "incident" | "capability">({
  type: "string",
  enum: ["preference", "server_fact", "incident", "capability"],
  description: "capability = the operational model of a system you set up or learned (value is a JSON document: summary, components, dataFlow, credentials as secret refs, verify steps).",
});
const anyCategoryEnum = Type.Unsafe<
  "preference" | "server_fact" | "incident" | "app_knowledge" | "extension_knowledge" | "research" | "capability"
>({
  type: "string",
  enum: ["preference", "server_fact", "incident", "app_knowledge", "extension_knowledge", "research", "capability"],
});

const rememberParams = Type.Object({
  category: writableCategoryEnum,
  key: Type.String({
    description:
      "Short stable slug for the fact's subject, e.g. 'reply_style', 'backup_schedule.postgres', or for a capability the system's name ('jellyfin', 'media_acquisition'). Reuse the same key when this exact fact recurs.",
  }),
  value: Type.String({ description: "The fact itself, one sentence, human-readable — or for a capability, a JSON document with summary, components, dataFlow, credentials (secret refs only, never values), verify." }),
});

const queryParams = Type.Object({
  category: Type.Optional(anyCategoryEnum),
  keyword: Type.Optional(Type.String({ description: "Filter by text in the key or value." })),
});

/** Memory tools (plan §37) — mutating but not tracked operations: no plan/confirm/rollback
 * semantics apply to Miro's own notes about the user/server, so these don't go through
 * runOperation. Not added to agent/tools.ts's AGENT_TOOLS (spawnWorker's read-only set) — same
 * "authority stays separate" boundary already drawn for operation-tools.ts. */
export function buildMemoryTools(db: Database) {
  return [
    {
      name: "memory_remember",
      label: "Remember",
      description:
        "Save a durable fact about this user or server — a preference, a server fact, or an incident. Calling this again with the same category+key reinforces the existing fact instead of duplicating it.",
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
