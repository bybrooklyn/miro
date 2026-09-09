/** @jsxImportSource react */
import { useState } from "react";
import type { StackSummary } from "@miro/protocol/wire";

// The managed-stack view: what Miro runs, whether it is actually up, its logs, and the four things you
// want to do to it at 11pm from a phone. The buttons do not shortcut anything - each sends a
// `stack_action`, which the daemon runs through the operation engine, so the plan and its confirmation
// come back through the transcript exactly as they would for the agent.

const ACTIONS: { action: "start" | "stop" | "update" | "down" | "remove"; label: string; danger?: boolean }[] = [
  { action: "start", label: "Start" },
  { action: "stop", label: "Stop" },
  { action: "update", label: "Update" },
  { action: "down", label: "Down" },
  { action: "remove", label: "Remove", danger: true },
];

function health(s: StackSummary): { text: string; color: string } {
  if (s.declared > 0 && s.running === s.declared) return { text: `${s.running}/${s.declared} up`, color: "var(--good)" };
  if (s.running > 0) return { text: `${s.running}/${s.declared || "?"} up`, color: "var(--warn)" };
  return { text: s.status === "stopped" ? "stopped" : "nothing running", color: "var(--dim)" };
}

export function Stacks({
  stacks,
  unavailable,
  logs,
  onAction,
  onLogs,
  onRefresh,
}: {
  stacks: StackSummary[] | null;
  unavailable?: string;
  logs: Record<string, { lines: string[]; error?: string }>;
  onAction: (app: string, action: "start" | "stop" | "update" | "down" | "remove") => void;
  onLogs: (app: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (stacks === null) return <div className="working">loading stacks…</div>;

  return (
    <>
      {unavailable ? <div className="notice block warn">{unavailable}</div> : null}
      {stacks.length === 0 ? (
        <div className="center">
          <p>
            Miro manages no stacks yet. Ask it for an app - "run Jellyfin" - and it writes the compose,
            stands it up, and it shows up here.
          </p>
          <button onClick={onRefresh}>Refresh</button>
        </div>
      ) : null}
      {stacks.map((s) => {
        const h = health(s);
        const log = logs[s.app];
        return (
          <div key={s.app} className="operation block">
            <div className="label">stack</div>
            <div style={{ color: "var(--bright)", display: "flex", alignItems: "baseline", gap: 8 }}>
              {s.app}
              <span style={{ color: h.color, fontSize: 13 }}>{h.text}</span>
            </div>
            {s.images.length ? (
              <dl className="kv" style={{ marginTop: 6 }}>
                <dt>images</dt>
                <dd>{s.images.join(", ")}</dd>
              </dl>
            ) : null}
            <div className="options" style={{ marginTop: 8 }}>
              {ACTIONS.map((a) => (
                <button key={a.action} className={a.danger ? "danger" : ""} onClick={() => onAction(s.app, a.action)}>
                  {a.label}
                </button>
              ))}
              <button
                onClick={() => {
                  const next = open === s.app ? null : s.app;
                  setOpen(next);
                  if (next) onLogs(s.app);
                }}
              >
                {open === s.app ? "Hide logs" : "Logs"}
              </button>
            </div>
            {open === s.app ? (
              <>
                {log?.error ? <div className="notice warn" style={{ marginTop: 8 }}>{log.error}</div> : null}
                {log && !log.error ? (
                  // Newest last, like a terminal; the container scrolls rather than the page.
                  <pre className="compose" style={{ maxHeight: 320, overflowY: "auto" }}>
                    {log.lines.length ? log.lines.join("\n") : "(no output)"}
                  </pre>
                ) : null}
                {!log ? <div className="working">fetching logs…</div> : null}
                <button style={{ marginTop: 6 }} onClick={() => onLogs(s.app)}>
                  Refresh logs
                </button>
              </>
            ) : null}
          </div>
        );
      })}
      {stacks.length ? (
        <button onClick={onRefresh} style={{ alignSelf: "flex-start" }}>
          Refresh
        </button>
      ) : null}
    </>
  );
}
