import type { ServerEvent } from "@miro/protocol";
import { answered, initialState, isQuiet, footerHints, reduce, userSent, type ActivityNode, type UiState } from "@miro/ui-model";

// Replays the event sequences from packages/ui-model/src/index.test.ts through exactly the state
// App.tsx holds, and prints the transcript the renderer would draw. No OpenTUI, no terminal — this
// proves the wiring (reduce / userSent / answered) without needing a daemon or a TTY.
// Run: bun run apps/miro/src/smoke.ts

let t = 1_000;
const now = () => (t += 100);

function apply(state: UiState, events: ServerEvent[]): UiState {
  return events.reduce((s, e) => reduce(s, e, now()), state);
}

function activityLines(node: ActivityNode, indent = 0): string[] {
  if (indent === 0 && isQuiet(node)) {
    const steps = node.children.reduce(function count(n, c): number {
      return n + 1 + c.children.reduce(count, 0);
    }, 0);
    const detail = node.detail ? ` · ${node.detail}` : "";
    return [`✓ ${node.label}${detail}${steps > 0 ? ` (+${steps} steps)` : ""}  [collapsed]`];
  }
  const icon = node.status === "running" ? "⠋" : node.status === "failed" ? "✗" : "✓";
  const head = `${" ".repeat(indent)}${icon} ${node.label}${node.detail ? ` · ${node.detail}` : ""}`;
  return [head, ...node.children.flatMap((c) => activityLines(c, indent + 2))];
}

function render(state: UiState): string[] {
  const out: string[] = [];
  for (const block of state.blocks) {
    switch (block.kind) {
      case "user":
        out.push(`user       │ ${block.text}`);
        break;
      case "assistant":
        out.push(`assistant  │ ${block.text}${block.streaming ? "▍" : ""}`);
        break;
      case "activity":
        for (const line of activityLines(block.node)) out.push(`activity   │ ${line}`);
        break;
      case "plan":
        out.push(`plan       │ Plan: ${block.plan.title}${block.decision ? ` — ${block.decision}` : ""}`);
        for (const c of block.plan.components) out.push(`           │   ${c.action.padEnd(9)} ${c.name} — ${c.detail}`);
        for (const [i, s] of block.plan.steps.entries()) out.push(`           │   ${i + 1}. ${s}`);
        break;
      case "operation": {
        const d = (block.plan.details ?? {}) as Record<string, unknown>;
        out.push(`operation  │ ${block.plan.summary}  [${String(d.class ?? "?")}]`);
        if (block.phase) out.push(`           │   … ${block.phase}`);
        if (block.result) out.push(`           │   ${block.result.outcome === "committed" ? "✓" : block.result.outcome === "applied_unverified" ? "⚠" : "↩"} ${block.result.message}`);
        break;
      }
      case "notice":
        out.push(`notice     │ ${block.level === "warn" ? "!" : block.level === "credential" ? "🔑" : "·"} ${block.text}`);
        break;
    }
  }
  return out;
}

function show(title: string, state: UiState) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
  const status = `${state.server} ${state.health}${state.model ? ` · ${state.model}` : ""}${state.privilege ? ` · ${state.privilege}` : ""}`;
  console.log(`status     │ ${status}${state.working ? "   ⠋ working…" : ""}`);
  for (const line of render(state)) console.log(line);
  if (state.pending) {
    const p = state.pending;
    console.log(`prompt     │ ${p.prompt}`);
    console.log(`           │ ${p.type === "secret" ? "•••• (masked)" : p.options.map((o) => o.label).join("  ") || "(free text)"}`);
  }
  console.log(`footer     │ ${footerHints(state).map((h) => `${h.key} ${h.label}`).join("  ·  ")}`);
}

// 1. A turn: user → tool tree (with a nested learn agent) → streamed reply.
let s = reduce(initialState(), { type: "status", server: "home", health: "healthy", model: "gpt-5.6-luna", privilege: "root" }, now());
s = userSent(s, "can you set up jellyfin", now());
s = apply(s, [
  { type: "activity", id: "t1", label: "Host info", status: "running" },
  { type: "activity", id: "t1", label: "Host info", status: "done", detail: "Debian 13" },
  { type: "activity", id: "t2", label: "Learn app", status: "running" },
  { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "running" },
  { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "done" },
  { type: "activity", id: "t2b", parentId: "t2", label: "Learn another app", status: "running" },
  { type: "activity", id: "t2b1", parentId: "t2b", label: "HTTP GET", status: "running" },
]);
show("mid-turn: a learn tree still running", s);

s = apply(s, [
  { type: "activity", id: "t2b1", parentId: "t2b", label: "HTTP GET", status: "failed", detail: "404" },
  { type: "activity", id: "t2b", parentId: "t2", label: "Learn another app", status: "done" },
  { type: "activity", id: "t2", label: "Learn app", status: "done" },
  { type: "reply_delta", text: "Jellyfin is " },
  { type: "reply_delta", text: "installed and healthy." },
  { type: "reply", text: "Jellyfin is installed and healthy." },
]);
show("turn done: clean tree collapses, failed one stays open", s);

// 2. A system plan and its confirmation.
s = apply(s, [
  {
    type: "system_plan",
    id: "p1",
    title: "Set up Jellyfin",
    findings: ["Docker is running", "no media server yet"],
    components: [{ name: "jellyfin", action: "install", detail: "container on :8096" }],
    steps: ["pull the image", "write a compose file", "start it"],
    verification: ["the web UI answers on :8096"],
    notes: ["creates an admin password"],
  },
  {
    type: "question",
    id: "plan_confirm:p1",
    prompt: "Approve this plan?",
    options: [
      { label: "Approve", value: "approve" },
      { label: "Change something", value: "change" },
      { label: "Cancel", value: "cancel" },
    ],
  },
]);
show("plan awaiting approval", s);
s = answered(s, "plan_confirm:p1", "approve");

// 3. An operation card through confirm → progress → result.
s = apply(s, [
  {
    type: "operation_plan",
    id: "o1",
    goal: "write config",
    summary: "Overwrite /opt/jellyfin/compose.yml",
    autoApprove: false,
    details: { class: "mutate", writes: ["/opt/jellyfin"], network: false, command: "docker compose up -d" },
  },
  {
    type: "question",
    id: "op_confirm:o1",
    prompt: "Approve: Overwrite /opt/jellyfin/compose.yml?",
    options: [
      { label: "Approve", value: "approve" },
      { label: "Cancel", value: "cancel" },
    ],
  },
]);
show("operation awaiting approval", s);
s = answered(s, "op_confirm:o1", "approve");
s = apply(s, [
  { type: "operation_progress", id: "o1", phase: "capturing" },
  { type: "operation_progress", id: "o1", phase: "applying" },
  { type: "operation_progress", id: "o1", phase: "verifying" },
  { type: "operation_result", id: "o1", outcome: "committed", message: "Done — write config, verified." },
  { type: "notice", level: "credential", text: "Created Jellyfin admin password — value: hunter2" },
]);
show("operation committed, credential notice", s);

// 4. A lifeline countdown and a secret prompt.
s = apply(s, [
  {
    type: "question",
    id: "lifeline_confirm:o9",
    prompt: "Still connected after the firewall change?",
    options: [
      { label: "Still here — keep it", value: "keep" },
      { label: "Roll back", value: "rollback" },
    ],
    timeoutMs: 90_000,
  },
]);
show("lifeline confirmation (countdown)", s);
s = answered(s, "lifeline_confirm:o9", "keep");
s = apply(s, [{ type: "secret_prompt", id: "ask:2", prompt: "Paste the VPN password" }]);
show("secret prompt (masked field)", s);

console.log(`\n${s.blocks.length} blocks rendered, pending = ${s.pending?.type ?? "none"}\n`);
