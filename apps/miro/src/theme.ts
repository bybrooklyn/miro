/** The one palette. Every colour in the TUI comes from here — no ad-hoc hex in a component.
 * Token names follow opencode's TUI theme (MIT) so the vocabulary is familiar; the values are
 * Miro's own: a low-contrast slate ground with a cool blue/violet accent family, tuned so the
 * status colours (success/warning/error) are the only saturated things on screen. */
export const theme = {
  text: "#c6cbd9",
  textMuted: "#6b7186",
  background: "#0f1117",
  backgroundPanel: "#161922",
  backgroundElement: "#1e222d",
  border: "#2a2f3d",
  borderActive: "#414a60",
  primary: "#7aa2f7",
  secondary: "#bb9af7",
  accent: "#ff9e64",
  error: "#f7768e",
  warning: "#e0af68",
  success: "#9ece6a",
  info: "#7dcfff",
  diffAddedBg: "#1b2c22",
  diffRemovedBg: "#2e1b22",
} as const;
