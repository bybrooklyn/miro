import { useEffect, useState } from "react";
import { theme } from "../theme";

/** Braille frames and the 80ms cadence are ported from opencode's TUI (MIT), component/spinner.tsx. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

export function Spinner({ fg = theme.textMuted }: { fg?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), INTERVAL);
    return () => clearInterval(timer);
  }, []);
  // The frame comes from the wall clock rather than a per-instance counter, so every spinner on
  // screen - the status line and each running activity node - turns in step instead of drifting.
  return <text fg={fg}>{FRAMES[Math.floor(Date.now() / INTERVAL) % FRAMES.length]}</text>;
}
