import type { Effort, Model } from "@miro/model-client";
import type { ModelRegistry } from "../agent/models";
import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import type { ExtensionHostManager } from "./host";
import type { OperationToolContext } from "../operations/engine";
import { spawnLearningAgent, type LearnAgentResult, type LearnSeed } from "./learn-agent";
import { discoverAppOnBox, formatPresence } from "../discovery";
import { APP_NAME } from "./paths";

/** What the codegen model resolver picked, and any reasoning-effort override to apply for it -
 * e.g. Codex logins always resolve to gpt-5.6-luna at "medium" reasoning (confirmed preference),
 * distinct from the general cost-tier routing_policy used for everyday chat. */
export interface CodegenSelection {
  model: Model<any>;
  reasoning?: Effort;
}

/** Learning recurses (PLAN.md §5.2 C): learning Radarr can branch into learning Prowlarr and
 * qBittorrent, finish those, and resume. Bounded depth, and an in-progress set so a cycle
 * (A needs B needs A) returns immediately instead of spawning forever. */
export const MAX_LEARN_DEPTH = 3;
export const MAX_REGENERATIONS = 3;
const inProgress = new Set<string>();

export interface LearnFlowOptions {
  app: string;
  hint?: string;
  depth?: number;
  db: Database;
  hostMgr: ExtensionHostManager;
  setSecret: (ref: string, value: string) => void;
  getSecret: (ref: string) => string | null;
  models: ModelRegistry;
  resolveCodegenModel: () => Promise<CodegenSelection | null>;
  getStoredKey: (provider: string) => string | null;
  send: (event: ServerEvent) => void;
  /** Lets the learning agent ask the user (intent, an external credential). Absent for
   * autonomous repair - the agent is told no user is available. */
  waitForAnswer?: (id: string) => Promise<string>;
  /** Gives the learning agent the engine's mutation tools, for the writes learning itself needs
   * (creating an API key). Absent for autonomous repair. */
  operationCtx?: OperationToolContext;
  /** The app_learn tool call this learning session runs under - its activity nests there. */
  parentActivityId?: string;
}

/** The single entry point for learning - reached only through the agent's own `app_learn`
 * decision (main agent or a learning agent recursing), never a user command. */
export async function runLearnFlow(opts: LearnFlowOptions): Promise<{ text: string; promoted: boolean }> {
  const app = opts.app.trim().toLowerCase();
  if (!APP_NAME.test(app)) {
    return { text: `"${opts.app}" is not usable as an app name - use lowercase letters, digits, - and _ (e.g. "jellyfin", "home-assistant").`, promoted: false };
  }
  const depth = opts.depth ?? 0;
  if (inProgress.has(app)) {
    return { text: `${app} is already being learned (a dependency cycle or a concurrent request) - continue without it for now.`, promoted: false };
  }
  if (depth >= MAX_LEARN_DEPTH) {
    return { text: `Learning depth limit (${MAX_LEARN_DEPTH}) reached at ${app} - stop recursing and finish what you can with the tools you have.`, promoted: false };
  }
  const selection = await opts.resolveCodegenModel();
  if (!selection) {
    return {
      text: "I don't have an AI provider connected yet, so I can't learn a new app. Type /provider to connect one.",
      promoted: false,
    };
  }
  // Discovery replaces the hand-written golden hint (PLAN.md §5.13): inspect the live box for the
  // app's own container/service and its published port, and hand THAT to the learning agent as its
  // starting context. Nothing hand-authored - the box tells Miro where the app is; the agent's
  // discovery ladder + docs research take it from there.
  const presence = await discoverAppOnBox(app);
  // Learning needs a running instance: the validator's live probe and dead-app check cannot pass
  // against nothing, so a session for an absent app can only fail (the golden-proof run spent
  // three parallel sessions and their write budgets learning apps it had not installed yet, PLAN.md
  // §5.29). Installing is the main agent's job, inside its system plan; learning comes after. A hint
  // naming a URL means the app runs somewhere discovery cannot see - that still learns.
  if (!presence.found && !/https?:\/\//i.test(opts.hint ?? "")) {
    return {
      text: `${app} is not running on this box (no matching container or systemd unit), so there is nothing to learn from yet. Install and start it first - as an operation inside your system plan - then call app_learn again; learning probes the live app. If it runs elsewhere or under another name, pass its URL in the hint.`,
      promoted: false,
    };
  }
  inProgress.add(app);
  try {
    const combinedHint = [opts.hint, formatPresence(app, presence)].filter(Boolean).join(" | ");
    const goal = `Learn the self-hosted app "${app}"${combinedHint ? ` (hint: ${combinedHint})` : ""}: identify what it is and how it is best controlled, generate a local extension for it (read tools, diagnostics, and write bindings), and record its operational model.`;
    // The repair budget reshaped (PLAN.md §5.15): up to MAX_REGENERATIONS INDEPENDENT sessions, each
    // allowed one write plus one targeted repair, the next seeded with the last draft and its
    // structured failures - never a chain of repairs on one draft in one context, which converges
    // worse than no repair at all. A session that never wrote anything is not regenerated: with no
    // draft to seed, a fresh sample would only redo the same research.
    let seed: LearnSeed | undefined;
    let last: LearnAgentResult | undefined;
    for (let regeneration = 1; regeneration <= MAX_REGENERATIONS; regeneration++) {
      const result = await spawnLearningAgent({
        goal,
        app,
        depth,
        db: opts.db,
        hostMgr: opts.hostMgr,
        setSecret: opts.setSecret,
        getSecret: opts.getSecret,
        models: opts.models,
        model: selection.model,
        reasoning: selection.reasoning,
        getStoredKey: opts.getStoredKey,
        send: opts.send,
        waitForAnswer: opts.waitForAnswer,
        operationCtx: opts.operationCtx,
        resolveCodegenModel: opts.resolveCodegenModel,
        parentActivityId: opts.parentActivityId,
        seed,
      });
      if (result.promoted || !result.lastAttempt) return { text: result.text, promoted: result.promoted };
      last = result;
      seed = result.lastAttempt;
      if (regeneration < MAX_REGENERATIONS) {
        opts.send({ type: "notice", level: "warn", text: `Learning ${app}: attempt ${regeneration} of ${MAX_REGENERATIONS} did not validate - starting a fresh attempt from its draft.` });
      }
    }
    return { text: `${last!.text}\n\nGave up learning ${app} after ${MAX_REGENERATIONS} independent attempts; the last failures were: ${last!.lastAttempt!.failures.map((f) => `${f.entry ? `${f.entry}: ` : ""}${f.message}`).join("; ")}`, promoted: false };
  } finally {
    inProgress.delete(app);
  }
}
