import type { UiState } from "@miro/ui-model";
import { theme } from "../theme";
import { Spinner } from "./Spinner";

const ICON = { connecting: "○", healthy: "●", degraded: "◐" } as const;
const HEALTH_FG = { connecting: theme.textMuted, healthy: theme.success, degraded: theme.warning } as const;

export function StatusLine({ state }: { state: UiState }) {
  const facts = [state.model, state.privilege].filter(Boolean) as string[];
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={1} flexShrink={0}>
      <text flexGrow={1} fg={theme.text}>
        <span fg={theme.text}>{state.server}</span>
        <span fg={HEALTH_FG[state.health]}>{` ${ICON[state.health]} ${state.health}`}</span>
        {facts.map((f, i) => (
          <span key={i} fg={theme.textMuted}>{` · ${f}`}</span>
        ))}
      </text>
      {state.working ? (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Spinner fg={theme.primary} />
          <text fg={theme.textMuted}>working…</text>
        </box>
      ) : null}
    </box>
  );
}
