import { useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ServerEvent } from "@miro/protocol";
import { answered, initialState, reduce, userSent, slashCommand, SLASH_COMMANDS } from "@miro/ui-model";
import { useMiroConnection } from "./connection";
import { theme } from "./theme";
import { StatusLine } from "./components/StatusLine";
import { Transcript } from "./components/Transcript";
import { PromptArea } from "./components/PromptArea";
import { Footer } from "./components/Footer";

const SCROLL_STEP = 2;

export function App() {
  const [state, setState] = useState(initialState);
  const { width, height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const send = useMiroConnection((event: ServerEvent) => setState((s) => reduce(s, event)));

  // Scrolling is ↑↓ / PageUp PageDown, always live regardless of what is focused - the chat input is
  // single-line, so the arrows are free. A choice prompt borrows ↑↓ to move between its options
  // (the footer stops advertising scroll then); PageUp/PageDown keep working throughout.
  // Assigning scrollTop rather than calling scrollBy is deliberate: only the setter updates the
  // sticky-to-bottom state, so scrolling up detaches and scrolling back down re-attaches.
  useKeyboard((key) => {
    const box = scrollRef.current;
    if (!box) return;
    const choosing = state.pending?.type === "question" && state.pending.options.length > 0;
    const page = Math.max(1, box.viewport.height - 1);
    if (key.name === "pageup") box.scrollTop -= page;
    else if (key.name === "pagedown") box.scrollTop += page;
    else if (!choosing && key.name === "up") box.scrollTop -= SCROLL_STEP;
    else if (!choosing && key.name === "down") box.scrollTop += SCROLL_STEP;
    // Quiet-competence (§quiet-competence): ctrl+q tiers down the most recent notification's class,
    // ctrl+k resets it. Miro learns which classes to quiet from this feedback.
    else if (key.ctrl && (key.name === "q" || key.name === "k")) {
      for (let i = state.blocks.length - 1; i >= 0; i--) {
        const b = state.blocks[i];
        if (b && b.kind === "notice" && b.source) {
          send({ type: "notice_feedback", source: b.source, action: key.name === "q" ? "quiet" : "keep" });
          break;
        }
      }
    }
  });

  // A local line in the transcript, for things the client itself has to say (no daemon involved).
  const notice = (text: string) => setState((s) => reduce(s, { type: "notice", level: "warn", text }));

  function handleAnswer(id: string, value: string) {
    // Only advance the local state when the daemon actually received the answer; during a
    // reconnect window the prompt stays put instead of vanishing unsent (audit #9).
    if (send({ type: "answer", id, value })) setState((s) => answered(s, id, value));
    else notice("not connected - try again in a moment");
  }

  function handleChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const slash = slashCommand(trimmed);
    if (slash && "unknown" in slash) {
      // A typo'd command is answered here, never sent to the model as a chat turn (audit #28).
      notice(`unknown command ${slash.unknown} - commands: ${SLASH_COMMANDS.map((c) => c.usage).join(", ")}`);
      return;
    }
    const msg = slash ?? { type: "chat" as const, text: trimmed };
    if (!send(msg)) {
      notice("not connected - try again in a moment");
      return;
    }
    if (msg.type === "chat") setState((s) => userSent(s, trimmed));
  }

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.background}>
      <StatusLine state={state} />
      <Transcript blocks={state.blocks} scrollRef={scrollRef} />
      <PromptArea state={state} onAnswer={handleAnswer} onChat={handleChat} />
      <Footer state={state} />
    </box>
  );
}
