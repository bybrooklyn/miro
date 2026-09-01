import { theme } from "../../theme";

export function AssistantBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <box paddingLeft={2}>
      <text fg={theme.text}>
        {text}
        {streaming ? <span fg={theme.primary}>▍</span> : null}
      </text>
    </box>
  );
}
