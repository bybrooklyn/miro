import type { Agent, AgentOptions } from "@miro/agent-core";
import type { Model } from "@miro/model-client";
import { createRetryLedger, planHash, type RetryLedger } from "../operations/retry-ledger";

// The agent loop's own stop hooks (PLAN.md §5.15 A/B), sized by model tier: the classifier is the
// pre-tool hook, this is the per-turn one.
// - Thrashing: the Nth identical tool call (same tool, same arguments) in one turn is blocked -
//   weak models loop on a call that keeps answering the same thing (NetLLMeval: 2x tool calls in
//   the wrong runs).
// - Deterministic termination: a turn that attempted operations and committed none may not end as
//   if the task were done. One follow-up message, once per prompt, hands the trajectory back and
//   demands either a genuinely different plan or an honest report. No NLP on the reply - the rule
//   is state-based (ponytail: it also fires on a turn that already reported the failure honestly,
//   costing one short extra model call; refine with a claim detector if that ever matters).
// - The undo-then-retry ledger the engine consults (operations/retry-ledger.ts) is reset here at
//   the start of every prompt, so "this turn" means the same thing in both places.

export type ModelTier = "strong" | "weak";

/** ponytail: a local or zero-cost model is "weak", everything billed is "strong" - the signal the
 * routing policy already has. Upgrade path: a per-model tier from the catalog once one exists. */
export function modelTier(model: Pick<Model, "provider" | "cost">): ModelTier {
  return model.provider === "ollama" || model.cost.input + model.cost.output === 0 ? "weak" : "strong";
}

export interface TurnGuardLimits {
  /** The Nth identical call in one turn is blocked. */
  identicalCalls: number;
  /** Distinct failed plans allowed in one turn before every further operation is refused. */
  failedOperations: number;
}

export function limitsFor(tier: ModelTier): TurnGuardLimits {
  return tier === "weak" ? { identicalCalls: 2, failedOperations: 2 } : { identicalCalls: 3, failedOperations: 3 };
}

export interface TurnGuard {
  /** Pass as AgentOptions.beforeToolCall. */
  beforeToolCall: NonNullable<AgentOptions["beforeToolCall"]>;
  /** Pass as OperationToolContext.retries. */
  retries: RetryLedger;
  /** Subscribes the per-turn bookkeeping and the turn-end gate. */
  attach(agent: Agent): void;
}

const OUTCOMES = new Set(["committed", "rolledback", "applied_unverified"]);

function doneWithoutCommit(attempted: number, failures: string[]): string {
  return [
    `[Miro's termination gate] ${attempted} operation(s) were attempted this turn and none committed:`,
    ...failures.map((f) => `- ${f}`),
    "Do not tell the user the task is done. Either retry with a genuinely different plan, or tell them exactly what failed and what you need from them.",
  ].join("\n");
}

export function createTurnGuard(limits: TurnGuardLimits): TurnGuard {
  const retries = createRetryLedger(limits.failedOperations);
  let calls = new Map<string, number>();
  let attempted = 0;
  let committed = 0;
  let fired = false;
  let failures: string[] = [];
  const reset = () => {
    calls = new Map();
    attempted = 0;
    committed = 0;
    fired = false;
    failures = [];
    retries.reset();
  };

  return {
    retries,
    beforeToolCall: ({ tool, args }) => {
      const key = planHash(tool.name, args);
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      if (n >= limits.identicalCalls) {
        console.log(`[mirod] turn guard: blocked identical call #${n} to ${tool.name}`);
        return {
          block: true,
          reason: `Blocked: you have already called ${tool.name} with these exact arguments ${n - 1} time(s) this turn; calling it again will not change the result. Change the approach, or report what is blocking you.`,
        };
      }
      return undefined;
    },
    attach(agent) {
      agent.subscribe((event) => {
        if (event.type === "agent_start") {
          reset();
        } else if (event.type === "tool_execution_end") {
          const details = (event.result as { details?: { outcome?: unknown; message?: unknown } } | undefined)?.details;
          const outcome = details?.outcome;
          if (typeof outcome === "string" && OUTCOMES.has(outcome)) {
            attempted++;
            // applied_unverified is not a commit: the write reached the app but nothing confirmed
            // it (engine.ts). Counting it as one let a turn of unconfirmed writes end as "done" -
            // exactly what this gate exists to stop (audit B4).
            if (outcome === "committed") committed++;
            else failures.push(`${event.toolName}: ${typeof details?.message === "string" ? details.message : outcome === "rolledback" ? "rolled back" : "applied but unverified"}`);
          }
        }
      });
      agent.setOnTurnEnd((_messages, _signal, context) => {
        if (context?.willContinue || fired || attempted === 0 || committed > 0) return;
        fired = true;
        console.log(`[mirod] turn guard: ${attempted} operation(s) attempted, none committed - demanding a different plan or an honest report`);
        agent.followUp({ role: "user", content: [{ type: "text", text: doneWithoutCommit(attempted, failures) }], timestamp: Date.now() });
      });
    },
  };
}
