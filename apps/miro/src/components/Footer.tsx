import { Fragment } from "react";
import { footerHints, type UiState } from "@miro/ui-model";
import { theme } from "../theme";

export function Footer({ state }: { state: UiState }) {
  const hints = footerHints(state);
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={2} flexShrink={0}>
      <text flexGrow={1}>
        {hints.map((h, i) => (
          <Fragment key={h.key}>
            {i > 0 ? <span fg={theme.border}>{"  ·  "}</span> : null}
            <span fg={theme.text}>{h.key}</span>
            <span fg={theme.textMuted}>{` ${h.label}`}</span>
          </Fragment>
        ))}
      </text>
      {state.pending ? null : <text fg={theme.border}>/provider /pair /memory</text>}
    </box>
  );
}
