import { theme } from "../../theme";

/** A credential is the one time a secret crosses the wire, and mirod never repeats it — so it gets
 * a box of its own rather than a line that can scroll past unread. */
export function NoticeBlock({ level, text }: { level: "info" | "warn" | "credential"; text: string }) {
  if (level === "credential") {
    return (
      <box flexDirection="column" border borderStyle="heavy" borderColor={theme.warning} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text}>
          <span fg={theme.warning}>{"🔑 "}</span>
          {text}
        </text>
        <text fg={theme.warning}>save this now — shown once</text>
      </box>
    );
  }
  return (
    <text fg={level === "warn" ? theme.warning : theme.textMuted}>{`${level === "warn" ? "!" : "·"} ${text}`}</text>
  );
}
