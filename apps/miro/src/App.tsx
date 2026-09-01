import { useState } from "react";
import type { ServerEvent } from "@miro/protocol";
import { useMiroConnection } from "./connection";

interface Question {
  id: string;
  prompt: string;
  options: { label: string; value: string }[];
}

interface SecretPrompt {
  id: string;
  prompt: string;
}

const HEALTH_ICON = { connecting: "○", healthy: "●", degraded: "◐" } as const;

// An experienced self-hoster wants to see what is about to happen, not just "approve?" — the
// plan's class, the exact scope the kernel sandbox will enforce, and any warning (PLAN.md §5.7).
function renderOperationPlan(e: Extract<ServerEvent, { type: "operation_plan" }>): string[] {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const out = [`  ▸ ${e.summary}${e.autoApprove ? "" : "  (needs approval)"}`];
  if (d.class) out.push(`    class: ${String(d.class)}${d.warning ? ` — ${String(d.warning)}` : ""}${d.irreversible ? " — cannot be rolled back" : ""}`);
  if (Array.isArray(d.writes)) out.push(`    may write: ${d.writes.length > 0 ? (d.writes as string[]).join(", ") : "nothing"}${d.network === undefined ? "" : d.network ? " · network on" : " · no network"}`);
  if (typeof d.command === "string") out.push(`    $ ${d.command}`);
  if (typeof d.proposed === "string") out.push(...`    --- proposed ---\n${d.proposed}`.split("\n").map((l) => `    ${l}`));
  return out;
}

function renderSystemPlan(e: Extract<ServerEvent, { type: "system_plan" }>): string[] {
  const out = [`  ═══ Plan: ${e.title} ═══`];
  if (e.findings.length) out.push("  Found:", ...e.findings.map((f) => `    · ${f}`));
  if (e.components.length) out.push("  Components:", ...e.components.map((c) => `    ${c.action.padEnd(9)} ${c.name} — ${c.detail}`));
  if (e.steps.length) out.push("  Steps:", ...e.steps.map((s, i) => `    ${i + 1}. ${s}`));
  if (e.verification.length) out.push("  Will verify:", ...e.verification.map((v) => `    ✓ ${v}`));
  if (e.notes?.length) out.push("  Notes:", ...e.notes.map((n) => `    ! ${n}`));
  return out;
}

export function App() {
  const [health, setHealth] = useState<"connecting" | "healthy" | "degraded">("connecting");
  const [lines, setLines] = useState<string[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);
  const [secretPrompt, setSecretPrompt] = useState<SecretPrompt | null>(null);

  const send = useMiroConnection((event: ServerEvent) => {
    if (event.type === "status") setHealth(event.health);
    else if (event.type === "question") setQuestion(event);
    else if (event.type === "secret_prompt") setSecretPrompt(event);
    else if (event.type === "activity") {
      if (event.status === "running") setLines((prev) => [...prev, `  ${event.parentId ? "   " : ""}├─ ${event.label}`]);
    } else if (event.type === "notice") setLines((prev) => [...prev, `  ${event.level === "warn" ? "!" : event.level === "credential" ? "🔑" : "·"} ${event.text}`]);
    else if (event.type === "operation_progress") setLines((prev) => [...prev, `    … ${event.phase}`]);
    else if (event.type === "reply") setLines((prev) => [...prev, `  ${event.text}`, ""]);
    else if (event.type === "operation_plan") setLines((prev) => [...prev, ...renderOperationPlan(event)]);
    else if (event.type === "operation_result") setLines((prev) => [...prev, `  ${event.outcome === "committed" ? "✓" : "↩"} ${event.message}`]);
    else if (event.type === "system_plan") setLines((prev) => [...prev, ...renderSystemPlan(event)]);
  });

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text>
        home {HEALTH_ICON[health]} {health}
      </text>
      <text> </text>
      {lines.map((line, i) => (
        <text key={i}>{line}</text>
      ))}
      {question && question.options.length === 0 ? (
        <box style={{ flexDirection: "column" }}>
          <text>{question.prompt}</text>
          <input
            focused
            onSubmit={(value: any) => {
              if (typeof value !== "string") return;
              send({ type: "answer", id: question.id, value });
              setQuestion(null);
            }}
          />
        </box>
      ) : question ? (
        <box style={{ flexDirection: "column" }}>
          <text>{question.prompt}</text>
          <select
            focused
            options={question.options.map((o) => ({ name: o.label, description: "", value: o.value }))}
            onChange={(_index, option) => {
              if (!option) return;
              send({ type: "answer", id: question.id, value: option.value as string });
              setQuestion(null);
            }}
          />
        </box>
      ) : secretPrompt ? (
        <box style={{ flexDirection: "column" }}>
          <text>{secretPrompt.prompt}</text>
          {/* ponytail: no input masking yet — @opentui/react's <input> doesn't expose one. The
              key still never leaves this local socket or gets logged; add masking if that's not enough. */}
          <input
            focused
            onSubmit={(value: any) => {
              if (typeof value !== "string") return;
              send({ type: "answer", id: secretPrompt.id, value });
              setSecretPrompt(null);
            }}
          />
        </box>
      ) : (
        <box style={{ flexDirection: "row" }}>
          <text>› </text>
          <input
            focused
            // @opentui/react's onSubmit type is an unsound intersection of
            // (value: string) and (event: SubmitEvent); only the string form
            // is ever actually invoked (see its own docs).
            onSubmit={(text: any) => {
              if (typeof text !== "string" || !text.trim()) return;
              setLines((prev) => [...prev, `› ${text}`]);
              if (text.trim() === "/provider") {
                send({ type: "provider_setup" });
              } else if (text.trim() === "/pair") {
                send({ type: "pair_request" });
              } else if (text.trim() === "/memory") {
                send({ type: "memory_list" });
              } else if (text.trim().startsWith("/memory forget ")) {
                send({ type: "memory_forget", id: text.trim().slice("/memory forget ".length).trim() });
              } else {
                send({ type: "chat", text });
              }
            }}
          />
        </box>
      )}
    </box>
  );
}
