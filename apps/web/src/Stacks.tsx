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

function health(s: StackSummary): { text: string; tone: "up" | "part" | "down" } {
  if (s.declared > 0 && s.running === s.declared) return { text: `${s.running}/${s.declared} up`, tone: "up" };
  if (s.running > 0) return { text: `${s.running}/${s.declared || "?"} up`, tone: "part" };
  return { text: s.status === "stopped" ? "stopped" : "nothing running", tone: "down" };
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

  if (stacks === null) return <div className="working">loading stacks</div>;

  return (
    <>
      {unavailable ? <div className="notice warn">{unavailable}</div> : null}
      {stacks.length === 0 ? (
        <div className="empty">
          Nothing managed yet. Ask for an app - "run Jellyfin" - and Miro writes the compose, stands it up,
          and it appears here.
        </div>
      ) : null}
      {stacks.map((s) => {
        const h = health(s);
        const log = logs[s.app];
        return (
          <div key={s.app} className="stack">
            <div className="head">
              <span className="app">{s.app}</span>
              <span className={`state ${h.tone}`}>{h.text}</span>
            </div>
            {s.images.length ? <div className="image">{s.images.join(", ")}</div> : null}
            <div className="actions">
              {ACTIONS.map((a) => (
                <button key={a.action} className={a.danger ? "danger" : ""} onClick={() => onAction(s.app, a.action)}>
                  {a.label}
                </button>
              ))}
              <button
                className="link"
                style={{ marginLeft: 4 }}
                onClick={() => {
                  const next = open === s.app ? null : s.app;
                  setOpen(next);
                  if (next) onLogs(s.app);
                }}
              >
                {open === s.app ? "hide logs" : "logs"}
              </button>
            </div>
            {open === s.app ? (
              <>
                {log?.error ? <div className="notice warn" style={{ marginTop: 10 }}>{log.error}</div> : null}
                {log && !log.error ? (
                  <pre className="out logs">{log.lines.length ? log.lines.join("\n") : "(no output)"}</pre>
                ) : null}
                {!log ? <div className="working">fetching logs</div> : null}
                {log && !log.error ? (
                  <button className="link" onClick={() => onLogs(s.app)}>
                    refresh
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
      <button className="link" onClick={onRefresh}>
        refresh
      </button>
    </>
  );
}
