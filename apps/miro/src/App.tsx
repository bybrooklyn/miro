import { useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ClientMessage, ServerEvent } from "@miro/protocol";
import { answered, initialState, reduce, userSent } from "@miro/ui-model";
import { useMiroConnection } from "./connection";
import { theme } from "./theme";
import { StatusLine } from "./components/StatusLine";
import { Transcript } from "./components/Transcript";
import { PromptArea } from "./components/PromptArea";
import { Footer } from "./components/Footer";

const SCROLL_STEP = 2;

function slashCommand(text: string): ClientMessage | null {
  if (text === "/provider") return { type: "provider_setup" };
  if (text === "/pair") return { type: "pair_request" };
  if (text === "/memory") return { type: "memory_list" };
  if (text.startsWith("/memory forget ")) return { type: "memory_forget", id: text.slice("/memory forget ".length).trim() };
  return null;
}

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
  });

  function handleAnswer(id: string, value: string) {
    send({ type: "answer", id, value });
    setState((s) => answered(s, id, value));
  }

  function handleChat(text: string) {
    const trimmed = text.trim();
    setState((s) => userSent(s, trimmed));
    send(slashCommand(trimmed) ?? { type: "chat", text });
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
