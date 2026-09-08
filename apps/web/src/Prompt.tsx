/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { secondsLeft, type Pending } from "@miro/ui-model";

// The pending prompt: an option question becomes buttons, a free-text question the composer, and a
// secret prompt a password field whose value goes straight to the daemon by reference - the same three
// shapes the terminal renders, decided by the view-model rather than here.
export function Prompt({ pending, onAnswer }: { pending: Pending; onAnswer: (value: string) => void }) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [pending.id]);

  // A lifeline confirmation counts down and auto-reverts on the daemon side; show the clock ticking.
  const [left, setLeft] = useState<number | null>(() => secondsLeft(pending));
  useEffect(() => {
    if (pending.type !== "question" || !pending.deadlineAt) return;
    const t = setInterval(() => setLeft(secondsLeft(pending)), 1000);
    return () => clearInterval(t);
  }, [pending]);

  if (pending.type === "secret") {
    return (
      <div className="prompt">
        <div className="q">{pending.prompt}</div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(value);
          }}
        >
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label="secret" />
          <button className="primary" type="submit">
            Send
          </button>
          <button type="button" onClick={() => onAnswer("")}>
            Skip
          </button>
        </form>
        <div className="label" style={{ marginTop: 6 }}>
          stored by reference - never shown to the model, never echoed
        </div>
      </div>
    );
  }

  if (pending.options.length === 0) {
    return (
      <div className="prompt">
        <div className="q">{pending.prompt}</div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onAnswer(value.trim());
          }}
        >
          <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label="answer" />
          <button className="primary" type="submit">
            Answer
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="prompt">
      <div className="q">
        {pending.prompt}
        {left !== null ? <span style={{ color: "var(--warn)" }}> · {left}s to confirm</span> : null}
      </div>
      <div className="options">
        {pending.options.map((o) => (
          <button
            key={o.value}
            className={o.value === "approve" || o.value === "keep" ? "primary" : o.value === "cancel" || o.value === "rollback" ? "danger" : ""}
            onClick={() => onAnswer(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
