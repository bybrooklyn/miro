import { useEffect, useRef, useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes, type InputRenderable } from "@opentui/core";
import { footerHints, keyToAnswer, secondsLeft, type Pending, type UiState } from "@miro/ui-model";
import { theme } from "../theme";

/** Anything a terminal would actually print — used to tell a typed/pasted character apart from a
 * control sequence in the hand-rolled secret field. */
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;

function PromptFrame({ children }: { children: React.ReactNode }) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={["left"]}
      borderColor={theme.accent}
      paddingLeft={1}
      marginLeft={1}
      marginRight={1}
    >
      {children}
    </box>
  );
}

function ChoicePrompt({
  state,
  pending,
  onAnswer,
}: {
  state: UiState;
  pending: Extract<Pending, { type: "question" }>;
  onAnswer: (id: string, value: string) => void;
}) {
  const options = pending.options;
  const hints = footerHints(state);
  const [cursor, setCursor] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pending.deadlineAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending.deadlineAt]);

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "left") return setCursor((c) => (c + options.length - 1) % options.length);
    if (key.name === "down" || key.name === "right" || key.name === "tab") return setCursor((c) => (c + 1) % options.length);
    // Enter takes the highlighted option; every other key routes through the model's own mapping.
    if (key.name === "return") return onAnswer(pending.id, options[cursor].value);
    const answer = keyToAnswer(pending, key.name);
    if (answer) onAnswer(pending.id, answer);
  });

  const left = secondsLeft(pending, now);
  return (
    <PromptFrame>
      <text fg={theme.text}>{pending.prompt}</text>
      {left !== null ? (
        <text fg={left <= 10 ? theme.error : theme.warning}>{`↩ reverts on its own in ${left}s`}</text>
      ) : null}
      <box flexDirection="row" gap={2}>
        {options.map((o, i) => (
          <text
            key={o.value}
            fg={i === cursor ? theme.text : theme.textMuted}
            bg={i === cursor ? theme.backgroundElement : undefined}
          >
            <span fg={i === cursor ? theme.accent : theme.textMuted}>{`[${hints[i]?.key ?? i + 1}] `}</span>
            {o.label}
          </text>
        ))}
      </box>
    </PromptFrame>
  );
}

/** @opentui/react's <input> has no masking, so the secret field is hand-rolled: keys in, bullets
 * out, and the value never reaches a renderable that could echo or select it. */
function SecretField({ prompt, onSubmit }: { prompt: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");

  useKeyboard((key) => {
    if (key.name === "return") return onSubmit(value);
    if (key.name === "escape") return onSubmit("");
    if (key.name === "backspace") return setValue((v) => v.slice(0, -1));
    if (key.ctrl || key.meta) return;
    // An unbracketed paste lands as one long sequence — take it whole so a pasted key survives.
    if (key.sequence && PRINTABLE.test(key.sequence)) setValue((v) => v + key.sequence);
  });
  usePaste((event) => {
    if (event.metadata?.kind === "binary") return;
    setValue((v) => v + decodePasteBytes(event.bytes));
  });

  return (
    <PromptFrame>
      <text fg={theme.text}>{prompt}</text>
      <text>
        <span fg={theme.text}>{"•".repeat(value.length)}</span>
        <span fg={theme.accent}>▍</span>
      </text>
    </PromptFrame>
  );
}

function TextPrompt({
  question,
  placeholder,
  onSubmit,
}: {
  question?: string;
  placeholder: string;
  onSubmit: (value: string) => void;
}) {
  const inputRef = useRef<InputRenderable>(null);
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {question ? <text fg={theme.text}>{question}</text> : null}
      <box flexDirection="row" gap={1}>
        <text fg={theme.primary}>›</text>
        <input
          ref={inputRef}
          focused
          flexGrow={1}
          placeholder={placeholder}
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.background}
          focusedBackgroundColor={theme.background}
          // @opentui/react types onSubmit as an unsound intersection of (value: string) and
          // (event: SubmitEvent); only the string form is ever invoked for an <input>.
          onSubmit={((value: unknown) => {
            if (typeof value !== "string" || !value.trim()) return;
            if (inputRef.current) inputRef.current.value = "";
            onSubmit(value);
          }) as never}
        />
      </box>
    </box>
  );
}

/** The prompt area is the pending question when there is one, else the chat input — so exactly one
 * thing is focused, and a choice question never leaves a text field waiting for a keystroke. */
export function PromptArea({
  state,
  onAnswer,
  onChat,
}: {
  state: UiState;
  onAnswer: (id: string, value: string) => void;
  onChat: (text: string) => void;
}) {
  const pending = state.pending;
  if (pending?.type === "secret") {
    return <SecretField key={pending.id} prompt={pending.prompt} onSubmit={(v) => onAnswer(pending.id, v)} />;
  }
  if (pending?.type === "question" && pending.options.length > 0) {
    return <ChoicePrompt key={pending.id} state={state} pending={pending} onAnswer={onAnswer} />;
  }
  if (pending?.type === "question") {
    return (
      <TextPrompt
        key={pending.id}
        question={pending.prompt}
        placeholder={pending.prompt}
        onSubmit={(v) => onAnswer(pending.id, v)}
      />
    );
  }
  return <TextPrompt placeholder="Ask for an outcome…" onSubmit={onChat} />;
}
