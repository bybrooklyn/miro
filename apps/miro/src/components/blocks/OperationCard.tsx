import type { OperationPlanEvent } from "@miro/protocol";
import { operationDetails, PHASE_LABEL, type Phase } from "@miro/ui-model";
import { theme } from "../../theme";
import { Spinner } from "../Spinner";

const CLASS_FG: Record<string, string> = {
  mutate: theme.info,
  destructive: theme.warning,
  lifeline: theme.error,
};

/** The diff is drawn by a real <diff>, whose sides are laid out at height 100% — so it needs an
 * explicit height or it collapses to nothing. Count the hunk body lines and cap the card.
 * ponytail: fixed cap, no expand affordance; add one if long diffs turn out to matter. */
function diffHeight(diff: string): number {
  const body = diff.split("\n").filter((l) => /^[ +-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  return Math.min(Math.max(body.length, 1), 24);
}

export function OperationCard({
  plan,
  phase,
  result,
}: {
  plan: OperationPlanEvent;
  phase?: Phase;
  result?: { outcome: "committed" | "rolledback" | "applied_unverified"; message: string };
}) {
  const { class: cls, writes, network, warning, command, diff, proposed, irreversible } = operationDetails(plan);

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={plan.summary}
      titleAlignment="left"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" gap={1}>
        {cls ? (
          <text fg={theme.background} bg={CLASS_FG[cls] ?? theme.textMuted}>{` ${cls} `}</text>
        ) : null}
        {plan.autoApprove ? null : <text fg={theme.textMuted}>needs approval</text>}
        {irreversible ? <text fg={theme.error}>cannot be rolled back</text> : null}
      </box>
      {writes ? (
        <text fg={theme.textMuted}>
          {`may write: ${writes.length > 0 ? writes.join(", ") : "nothing"}`}
          {network === undefined ? "" : network ? " · network on" : " · network off"}
        </text>
      ) : null}
      {warning ? <text fg={theme.warning}>{`! ${warning}`}</text> : null}
      {command ? (
        <text fg={theme.text}>
          <span fg={theme.textMuted}>{"$ "}</span>
          {command}
        </text>
      ) : null}
      {diff ? (
        <diff
          diff={diff}
          view="unified"
          showLineNumbers
          wrapMode="word"
          width="100%"
          height={diffHeight(diff)}
          fg={theme.text}
          lineNumberFg={theme.textMuted}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
        />
      ) : proposed ? (
        <box flexDirection="column" backgroundColor={theme.backgroundPanel} paddingLeft={1}>
          {proposed.split("\n").map((line, i) => (
            <text key={i} fg={theme.textMuted}>
              {line}
            </text>
          ))}
        </box>
      ) : null}
      {phase ? (
        <box flexDirection="row" gap={1}>
          <Spinner fg={theme.info} />
          <text fg={theme.textMuted}>{PHASE_LABEL[phase]}</text>
        </box>
      ) : null}
      {result ? (
        <text fg={result.outcome === "committed" ? theme.success : theme.warning}>
          {`${result.outcome === "committed" ? "✓" : result.outcome === "applied_unverified" ? "⚠" : "↩"} ${result.message}`}
        </text>
      ) : null}
    </box>
  );
}
