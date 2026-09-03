import type { ReactNode } from "react";
import type { SystemPlanEvent } from "@miro/protocol";
import { theme } from "../../theme";

const ACTION_FG = {
  reuse: theme.info,
  install: theme.success,
  configure: theme.accent,
  remove: theme.error,
} as const;

const DECISION_FG = { approved: theme.success, changed: theme.warning, cancelled: theme.error } as const;

// Widest action word ("configure"), so the component names line up in a column.
const BADGE_WIDTH = 9;

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <box flexDirection="column">
      <text fg={theme.textMuted}>{label}</text>
      <box flexDirection="column" paddingLeft={2}>
        {children}
      </box>
    </box>
  );
}

export function PlanCard({ plan, decision }: { plan: SystemPlanEvent; decision?: "approved" | "changed" | "cancelled" }) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="double"
      borderColor={theme.secondary}
      title={`Plan: ${plan.title}`}
      titleAlignment="left"
      paddingLeft={1}
      paddingRight={1}
    >
      {plan.findings.length > 0 && (
        <Section label="Found">
          {plan.findings.map((f, i) => (
            <text key={i} fg={theme.text}>{`· ${f}`}</text>
          ))}
        </Section>
      )}
      {plan.components.length > 0 && (
        <Section label="Components">
          {plan.components.map((c, i) => (
            <text key={i}>
              <span fg={ACTION_FG[c.action]}>{c.action.padEnd(BADGE_WIDTH)}</span>
              <span fg={theme.text}>{` ${c.name}`}</span>
              <span fg={theme.textMuted}>{` - ${c.detail}`}</span>
            </text>
          ))}
        </Section>
      )}
      {plan.steps.length > 0 && (
        <Section label="Steps">
          {plan.steps.map((s, i) => (
            <text key={i} fg={theme.text}>
              <span fg={theme.textMuted}>{`${i + 1}. `}</span>
              {s}
            </text>
          ))}
        </Section>
      )}
      {plan.verification.length > 0 && (
        <Section label="Will verify">
          {plan.verification.map((v, i) => (
            <text key={i} fg={theme.text}>
              <span fg={theme.success}>{"✓ "}</span>
              {v}
            </text>
          ))}
        </Section>
      )}
      {plan.notes && plan.notes.length > 0 && (
        <Section label="Notes">
          {plan.notes.map((n, i) => (
            <text key={i} fg={theme.text}>
              <span fg={theme.warning}>{"! "}</span>
              {n}
            </text>
          ))}
        </Section>
      )}
      {decision ? <text fg={DECISION_FG[decision]}>{decision}</text> : null}
    </box>
  );
}
