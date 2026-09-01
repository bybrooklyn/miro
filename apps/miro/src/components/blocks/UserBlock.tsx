import { theme } from "../../theme";

/** Left-border-coloured message block, the shape opencode's TUI uses for a message (MIT). */
export function UserBlock({ text }: { text: string }) {
  return (
    <box border={["left"]} borderColor={theme.primary} paddingLeft={1}>
      <text fg={theme.text}>{text}</text>
    </box>
  );
}
