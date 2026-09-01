import { Type } from "@earendil-works/pi-ai";
import type { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import type { ExtensionHostManager } from "../extensions/host";
import type { OperationToolContext } from "../operations/engine";
import { runLearnFlow, type CodegenSelection } from "../extensions/learn";
import type { RepairTrigger } from "../extensions/repair";

export interface LearnToolContext {
  db: Database;
  send: (event: ServerEvent) => void;
  hostMgr: ExtensionHostManager;
  setSecret: (ref: string, value: string) => void;
  getSecret: (ref: string) => string | null;
  models: ReturnType<typeof builtinModels>;
  resolveCodegenModel: () => Promise<CodegenSelection | null>;
  getStoredKey: (provider: string) => string | null;
  /** Lets the learning agent ask the user mid-research (PLAN.md §5.3 C). */
  waitForAnswer: (id: string) => Promise<string>;
  /** Gives the learning agent the engine's mutation tools for the writes learning itself needs. */
  operationCtx: OperationToolContext;
  /** Awaited by agent/extension-tools.ts on a real call failure; resolves true when the repair
   * loop fixed and re-promoted the extension, so the failing call can be retried inline. */
  repair: (trigger: RepairTrigger) => Promise<boolean> | void;
  /** Hot-load (PLAN.md §5.4 D): after a promotion, swap the app's tools into the running agent
   * and return their names, which app_learn reports as addedToolNames so the same task can use
   * them immediately. Set by agent/index.ts's createMiroAgent. */
  onPromoted?: (app: string) => string[];
}

function textResult(details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

const learnParams = Type.Object({
  app: Type.String({ description: "The app/service's name, e.g. 'jellyfin'." }),
  hint: Type.Optional(Type.String({ description: "Any extra context — its URL, what it does, why it's being learned." })),
});

/** app_learn — the agent's own decision to acquire a capability (PLAN.md §5.2 C). Kept separate
 * from agent/tools.ts's AGENT_TOOLS and never reachable from spawnWorker, same "authority stays
 * separate" boundary already drawn for operation/memory tools. This is the ONLY way learning is
 * triggered; there is deliberately no user command for it. */
export function buildLearnTools(ctx: LearnToolContext) {
  return [
    {
      name: "app_learn",
      label: "Learn app",
      description:
        "Learn a self-hosted app you do not have tools for yet: inspect how it is deployed here, research it, choose its best control method, generate and validate an extension (read tools + write operations), and record its operational model. Its ext_<app>_* tools become available to you immediately in this same task — continue with the original request afterwards. Also use it for a dependency you discover you need.",
      parameters: learnParams,
      execute: async (id: string, params: { app: string; hint?: string }): Promise<AgentToolResult<unknown>> => {
        const result = await runLearnFlow({
          app: params.app,
          hint: params.hint,
          db: ctx.db,
          hostMgr: ctx.hostMgr,
          setSecret: ctx.setSecret,
          getSecret: ctx.getSecret,
          models: ctx.models,
          resolveCodegenModel: ctx.resolveCodegenModel,
          getStoredKey: ctx.getStoredKey,
          send: ctx.send,
          waitForAnswer: ctx.waitForAnswer,
          operationCtx: ctx.operationCtx,
          parentActivityId: id, // the learning session's tool calls nest under this app_learn call
        });
        const addedToolNames = result.promoted && ctx.onPromoted ? ctx.onPromoted(params.app.trim().toLowerCase()) : [];
        return {
          ...textResult({ ...result, addedToolNames }),
          // pi-agent-core: tools named here are available from this transcript point onward.
          ...(addedToolNames.length > 0 ? { addedToolNames } : {}),
        };
      },
    },
  ];
}
