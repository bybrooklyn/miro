/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { createLineBuffer, encodeLine, type ClientMessage, type ServerEvent } from "@miro/protocol/wire";
import { initialState, reduce, userSent, answered, type UiState } from "@miro/ui-model";
import { Transcript } from "./Transcript";
import { Prompt } from "./Prompt";

// The web renderer. It holds no UI logic of its own: @miro/ui-model reduces the same protocol events
// the terminal client reduces, and this turns the resulting UiState into DOM (PLAN.md:1720, "one
// view-model, two thin renderers"). Anything that looks like a decision - what to show, what a key or
// button means, when a prompt is pending - belongs in the view-model, not here.

type Session = { state: "checking" } | { state: "unpaired" } | { state: "paired" };

function useSession() {
  const [session, setSession] = useState<Session>({ state: "checking" });
  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json() as Promise<{ authenticated: boolean }>)
      .then((r) => setSession({ state: r.authenticated ? "paired" : "unpaired" }))
      .catch(() => setSession({ state: "unpaired" }));
  }, []);
  return { session, setSession };
}

/** The pairing screen: a code from `/pair` on the box, exchanged for this browser's own token (kept in
 * an HttpOnly cookie, so page scripts can never read it). */
function Pairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.replace(/\s+/g, ""), deviceName: navigator.userAgent.slice(0, 40) }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) setError(body.error ?? "that code was refused");
      else onPaired();
    } catch {
      setError("could not reach the server");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center">
      <h1>Pair this browser</h1>
      <p>
        Run <code>/pair</code> in Miro on the server and type the nine digits it shows. The code works once and
        expires in ten minutes.
      </p>
      <form className="composer" onSubmit={submit}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123 456 789"
          inputMode="numeric"
          autoFocus
          aria-label="pairing code"
        />
        <button className="primary" type="submit" disabled={busy || code.replace(/\s+/g, "").length < 9}>
          {busy ? "…" : "Pair"}
        </button>
      </form>
      <p className="err">{error}</p>
    </div>
  );
}

function Chat() {
  const [ui, setUi] = useState<UiState>(() => initialState());
  const sendRef = useRef<((msg: ClientMessage) => boolean) | null>(null);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    const feed = createLineBuffer((line) => {
      try {
        const event = JSON.parse(line) as ServerEvent;
        setUi((s) => reduce(s, event));
      } catch {
        // one bad frame is a dropped line, never a broken page
      }
    });
    const open = () => {
      if (closed) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      // A string, not a Buffer: createLineBuffer takes either, and there is no Buffer in a browser.
      ws.onmessage = (e) => feed(String(e.data));
      ws.onclose = () => {
        sendRef.current = null;
        if (closed) return;
        setUi((s) => reduce(s, { type: "status", server: s.server, health: "connecting" }));
        setTimeout(open, 800); // the daemon restarts on update; reconnect like the TUI does
      };
      sendRef.current = (msg) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(encodeLine(msg));
        return true;
      };
    };
    open();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [ui.blocks.length, ui.pending, ui.working]);

  const send = (msg: ClientMessage) => sendRef.current?.(msg) ?? false;

  const submitChat = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (!send({ type: "chat", text: t })) return; // disconnected: keep what they typed
    setUi((s) => userSent(s, t));
    setText("");
  };

  const answer = (value: string) => {
    const p = ui.pending;
    if (!p) return;
    if (!send({ type: "answer", id: p.id, value })) return;
    setUi((s) => answered(s, p.id, value));
  };

  return (
    <>
      <header>
        <span className={`dot ${ui.health}`} />
        <span className="name">{ui.server}</span>
        <span className="meta">
          {ui.model ?? "no model"}
          {ui.privilege ? ` · ${ui.privilege}` : ""}
        </span>
      </header>
      <main>
        <Transcript blocks={ui.blocks} />
        {ui.working && <div className="working">working…</div>}
        <div ref={endRef} />
      </main>
      <footer>
        {ui.pending && <Prompt pending={ui.pending} onAnswer={answer} />}
        {!ui.pending && (
          <form className="composer" onSubmit={submitChat}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={ui.health === "connecting" ? "reconnecting…" : "Ask for an outcome…"}
              aria-label="message"
            />
            <button className="primary" type="submit">
              Send
            </button>
          </form>
        )}
      </footer>
    </>
  );
}

function App() {
  const { session, setSession } = useSession();
  if (session.state === "checking") return <div className="center">…</div>;
  if (session.state === "unpaired") return <Pairing onPaired={() => setSession({ state: "paired" })} />;
  return <Chat />;
}

createRoot(document.getElementById("root")!).render(<App />);
