import type { ServerEvent, ClientMessage, SystemPlanEvent, OperationPlanEvent, QuestionOption, OperationProgressEvent } from "@miro/protocol";

// The headless view-model (PLAN.md §5.9 client decision: "one view-model, two thin renderers").
// A pure reducer from protocol events to what a client shows: a transcript of blocks, the one
// prompt currently waiting on the user, and status. No rendering, no framework - the terminal
// client (apps/miro, OpenTUI) and a future web client render this same state. Every rule here is
// tested against real event sequences, so the renderers stay thin and dumb.

export interface ActivityNode {
  id: string;
  parentId?: string;
  label: string;
  status: "running" | "done" | "failed";
  detail?: string;
  children: ActivityNode[];
  startedAt: number;
  endedAt?: number;
}

export type Phase = OperationProgressEvent["phase"];

export type Block =
  | { kind: "user"; id: string; text: string; at: number }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; at: number }
  /** One top-level tool call and everything nested under it (a learning session, recursively). */
  | { kind: "activity"; id: string; node: ActivityNode; at: number }
  | { kind: "plan"; id: string; plan: SystemPlanEvent; decision?: "approved" | "changed" | "cancelled"; at: number }
  | {
      kind: "operation";
      id: string;
      plan: OperationPlanEvent;
      phase?: Phase;
      result?: { outcome: "committed" | "rolledback" | "applied_unverified"; message: string };
      at: number;
    }
  | { kind: "notice"; id: string; level: "info" | "warn" | "credential"; text: string; at: number };

export type QuestionKind = "plan_confirm" | "plan_change" | "op_confirm" | "lifeline_confirm" | "ask" | "other";

export type Pending =
  | {
      type: "question";
      id: string;
      prompt: string;
      options: QuestionOption[];
      kind: QuestionKind;
      askedAt: number;
      /** Set for lifeline confirmations: the daemon rolls back on its own when this passes. */
      deadlineAt?: number;
      /** The plan/operation block this question decides, when there is one. */
      blockId?: string;
    }
  | { type: "secret"; id: string; prompt: string; askedAt: number };

export interface UiState {
  server: string;
  health: "connecting" | "healthy" | "degraded";
  model?: string;
  privilege?: "root" | "user";
  blocks: Block[];
  pending: Pending | null;
  /** Questions that arrived while another was still open (e.g. a lifeline countdown running when a
   * new op_confirm arrives). Shown one at a time, never dropped - the daemon can have several
   * outstanding at once (audit U1). */
  pendingQueue: Pending[];
  /** A turn is in flight (from the user's message until the final reply). */
  working: boolean;
  /** Monotonic id source for client-originated blocks. */
  seq: number;
}

export function initialState(server = "home"): UiState {
  return { server, health: "connecting", blocks: [], pending: null, pendingQueue: [], working: false, seq: 0 };
}

/** Show a new prompt now if none is open, else hold it behind the current one - never overwrite an
 * outstanding question (audit U1). A re-ask of the same id replaces in place. */
function enqueuePending(state: UiState, p: Pending): UiState {
  const s = closeStreaming(state);
  if (!s.pending || s.pending.id === p.id) return { ...s, pending: p };
  if (s.pendingQueue.some((q) => q.id === p.id)) return s;
  return { ...s, pendingQueue: [...s.pendingQueue, p] };
}

/** Drop the current pending and promote the next queued one (if any). */
function advancePending(state: UiState): UiState {
  const [next, ...rest] = state.pendingQueue;
  return { ...state, pending: next ?? null, pendingQueue: rest };
}

export function questionKind(id: string): QuestionKind {
  const prefix = id.split(":")[0];
  return prefix === "plan_confirm" || prefix === "plan_change" || prefix === "op_confirm" || prefix === "lifeline_confirm" || prefix === "ask" ? prefix : "other";
}

function last(state: UiState): Block | undefined {
  return state.blocks[state.blocks.length - 1];
}

function replaceLast(state: UiState, block: Block): UiState {
  return { ...state, blocks: [...state.blocks.slice(0, -1), block] };
}

function push(state: UiState, block: Block): UiState {
  return { ...state, blocks: [...state.blocks, block] };
}

/** Closes a streaming assistant block, if the last block is one - a tool call or a prompt means
 * the assistant's text so far is complete for now (the Claude-Code-style interleave). */
function closeStreaming(state: UiState): UiState {
  const l = last(state);
  return l && l.kind === "assistant" && l.streaming ? replaceLast(state, { ...l, streaming: false }) : state;
}

function findNode(state: UiState, id: string): { blockIndex: number; path: number[] } | null {
  for (let b = state.blocks.length - 1; b >= 0; b--) {
    const block = state.blocks[b];
    if (block.kind !== "activity") continue;
    const path = pathTo(block.node, id, []);
    if (path) return { blockIndex: b, path };
  }
  return null;
}

function pathTo(node: ActivityNode, id: string, acc: number[]): number[] | null {
  if (node.id === id) return acc;
  for (let i = 0; i < node.children.length; i++) {
    const p = pathTo(node.children[i], id, [...acc, i]);
    if (p) return p;
  }
  return null;
}

function updateNode(node: ActivityNode, path: number[], fn: (n: ActivityNode) => ActivityNode): ActivityNode {
  if (path.length === 0) return fn(node);
  const [head, ...rest] = path;
  return { ...node, children: node.children.map((c, i) => (i === head ? updateNode(c, rest, fn) : c)) };
}

/** Apply one server event. `now` is injectable so tests are deterministic. */
export function reduce(state: UiState, event: ServerEvent, now = Date.now()): UiState {
  switch (event.type) {
    case "status": {
      const next = { ...state, server: event.server, health: event.health, model: event.model ?? state.model, privilege: event.privilege ?? state.privilege };
      // "connecting" is the client noticing the socket dropped (a daemon restart): the turn in
      // flight is gone, and so is every question the daemon had open - it settles and forgets
      // them on close. Left as they were, the TUI showed "working…" with no input forever and
      // offered answers nobody was listening for (audit #3).
      return event.health === "connecting" ? { ...next, working: false, pending: null, pendingQueue: [] } : next;
    }

    case "reply_delta": {
      const l = last(state);
      if (l && l.kind === "assistant" && l.streaming) return replaceLast(state, { ...l, text: l.text + event.text });
      // Bump seq: a later narration segment (after a tool call) must get a fresh id, or two
      // assistant blocks share one and the renderer collides on the React key (audit U3).
      return push({ ...state, working: true, seq: state.seq + 1 }, { kind: "assistant", id: `a${state.seq + 1}`, text: event.text, streaming: true, at: now });
    }

    case "reply": {
      const l = last(state);
      // The final text is authoritative; if streaming produced the same text this is a no-op.
      const next = l && l.kind === "assistant" && l.streaming
        ? replaceLast(state, { ...l, text: event.text || l.text, streaming: false })
        : event.text
          ? push(state, { kind: "assistant", id: `a${state.seq + 1}`, text: event.text, streaming: false, at: now })
          : state;
      return { ...next, working: false, seq: next.seq + 1 };
    }

    case "activity": {
      if (event.status === "running") {
        const s = closeStreaming({ ...state, working: true });
        if (event.parentId) {
          const parent = findNode(s, event.parentId);
          if (parent) {
            const block = s.blocks[parent.blockIndex] as Extract<Block, { kind: "activity" }>;
            const node = updateNode(block.node, parent.path, (n) => ({
              ...n,
              children: [...n.children, { id: event.id, parentId: event.parentId, label: event.label, status: "running", children: [], startedAt: now }],
            }));
            return { ...s, blocks: s.blocks.map((b, i) => (i === parent.blockIndex ? { ...block, node } : b)) };
          }
          // Unknown parent (e.g. a client that connected mid-turn): show it at top level rather than drop it.
        }
        return push(s, { kind: "activity", id: event.id, node: { id: event.id, label: event.label, status: "running", children: [], startedAt: now }, at: now });
      }
      const found = findNode(state, event.id);
      if (!found) return state;
      const block = state.blocks[found.blockIndex] as Extract<Block, { kind: "activity" }>;
      const node = updateNode(block.node, found.path, (n) => ({ ...n, status: event.status, detail: event.detail ?? n.detail, endedAt: now }));
      return { ...state, blocks: state.blocks.map((b, i) => (i === found.blockIndex ? { ...block, node } : b)) };
    }

    case "notice": {
      const s = push(state, { kind: "notice", id: `n${state.seq + 1}`, level: event.level, text: event.text, at: now });
      return { ...s, seq: s.seq + 1 };
    }

    case "system_plan":
      return push(closeStreaming(state), { kind: "plan", id: event.id, plan: event, at: now });

    case "operation_plan":
      return push(closeStreaming(state), { kind: "operation", id: event.id, plan: event, at: now });

    case "operation_progress":
      return { ...state, blocks: state.blocks.map((b) => (b.kind === "operation" && b.id === event.id ? { ...b, phase: event.phase } : b)) };

    case "operation_result": {
      const s = {
        ...state,
        blocks: state.blocks.map((b) => (b.kind === "operation" && b.id === event.id ? { ...b, phase: undefined, result: { outcome: event.outcome, message: event.message } } : b)),
      };
      // A lifeline that auto-resolved (timeout/revert) leaves its prompt open with nothing behind
      // it - clear it so the user can't answer a question the daemon already forgot (audit U7).
      if (s.pending?.type === "question" && s.pending.blockId === event.id) return advancePending(s);
      return s;
    }

    case "question": {
      const kind = questionKind(event.id);
      const target = event.id.slice(event.id.indexOf(":") + 1);
      const blockId = kind === "plan_confirm" || kind === "plan_change" || kind === "op_confirm" || kind === "lifeline_confirm" ? target : undefined;
      return enqueuePending(state, { type: "question", id: event.id, prompt: event.prompt, options: event.options, kind, askedAt: now, deadlineAt: event.timeoutMs ? now + event.timeoutMs : undefined, blockId });
    }

    case "secret_prompt":
      return enqueuePending(state, { type: "secret", id: event.id, prompt: event.prompt, askedAt: now });

    default:
      return state;
  }
}

/** The user sent a chat message. */
export function userSent(state: UiState, text: string, now = Date.now()): UiState {
  return { ...push(state, { kind: "user", id: `u${state.seq + 1}`, text, at: now }), working: true, seq: state.seq + 1 };
}

/** The user answered the pending prompt (value is what goes back as an `answer`). Records the
 * decision on the plan block it concerned; operation outcomes arrive later as operation_result. */
export function answered(state: UiState, id: string, value: string): UiState {
  const p = state.pending;
  if (!p || p.id !== id) return state;
  let blocks = state.blocks;
  if (p.type === "question" && p.kind === "plan_confirm" && p.blockId) {
    const decision = value === "approve" ? "approved" : value === "change" ? "changed" : "cancelled";
    blocks = blocks.map((b) => (b.kind === "plan" && b.id === p.blockId ? { ...b, decision } : b));
  }
  return advancePending({ ...state, blocks }); // promote the next queued prompt, if any (audit U1)
}

/** Maps a single key press to an answer for the pending prompt, or null if the key means nothing
 * here. Letters follow the on-screen hints; digits pick the nth option. */
export function keyToAnswer(pending: Pending | null, key: string): string | null {
  if (!pending || pending.type !== "question" || pending.options.length === 0) return null;
  const values = pending.options.map((o) => o.value);
  const has = (v: string) => (values.includes(v) ? v : null);
  switch (key) {
    // A letter answers only a question that has that option. The old fallback to the first option
    // made `y` pick "Anthropic" on the provider chooser and "cheapest" on the codegen question
    // whose recommended answer is "best" - with nothing on screen saying so (audit #5).
    case "a":
    case "y":
    case "return":
      return has("approve") ?? has("keep");
    case "c":
      return has("change");
    case "x":
    case "n":
    case "escape":
      return has("cancel") ?? has("rollback");
    case "k":
      return has("keep");
    case "r":
      return has("rollback");
    default: {
      const n = Number(key);
      return Number.isInteger(n) && n >= 1 && n <= values.length ? values[n - 1] : null;
    }
  }
}

/** Context-sensitive footer hints: what the keys do right now. */
export function footerHints(state: UiState): { key: string; label: string }[] {
  const p = state.pending;
  if (p?.type === "secret") return [{ key: "enter", label: "submit" }, { key: "esc", label: "skip" }];
  if (p?.type === "question") {
    if (p.options.length === 0) return [{ key: "enter", label: "send" }];
    const hints: { key: string; label: string }[] = [];
    for (const o of p.options) {
      const key = o.value === "approve" ? "a" : o.value === "change" ? "c" : o.value === "cancel" ? "x" : o.value === "keep" ? "k" : o.value === "rollback" ? "r" : String(p.options.indexOf(o) + 1);
      hints.push({ key, label: o.label });
    }
    return hints;
  }
  // No "esc interrupt" while working: there is no interrupt message in the protocol yet, so the
  // hint advertised a key that did nothing (audit #12). Add it back with the message.
  return state.working
    ? [{ key: "↑↓", label: "scroll" }]
    : [{ key: "enter", label: "send" }, { key: "/", label: "commands" }, { key: "↑↓", label: "scroll" }];
}

/** The slash commands a client understands, in one place: the parser, the footer and the help
 * text read this table (audit #15: two hand-kept lists had already drifted). */
export const SLASH_COMMANDS: { command: string; usage: string; help: string }[] = [
  { command: "/provider", usage: "/provider", help: "connect an AI provider or a search key" },
  { command: "/pair", usage: "/pair", help: "show the ticket a remote miro needs" },
  { command: "/memory", usage: "/memory", help: "list what Miro remembers" },
  { command: "/memory forget", usage: "/memory forget <id>", help: "forget one memory" },
];

/** A typed `/command` as the client message it means; null for anything else. An unknown slash
 * command is `{ unknown }` so the client can say so locally instead of spending a model turn on a
 * typo (audit #28). */
export function slashCommand(text: string): ClientMessage | { unknown: string } | null {
  if (!text.startsWith("/")) return null;
  if (text === "/provider") return { type: "provider_setup" };
  if (text === "/pair") return { type: "pair_request" };
  if (text === "/memory") return { type: "memory_list" };
  if (text.startsWith("/memory forget ")) {
    const id = text.slice("/memory forget ".length).trim();
    return id ? { type: "memory_forget", id } : { unknown: text };
  }
  return { unknown: text };
}

/** Steps under an activity node - every descendant. Shown on the collapsed line of a finished tree. */
export function countSteps(node: ActivityNode): number {
  return node.children.reduce((n, c) => n + 1 + countSteps(c), 0);
}

/** Seconds left on a lifeline countdown, or null. */
export function secondsLeft(pending: Pending | null, now = Date.now()): number | null {
  if (!pending || pending.type !== "question" || !pending.deadlineAt) return null;
  return Math.max(0, Math.ceil((pending.deadlineAt - now) / 1000));
}

/** Whether an activity block should render collapsed: finished without failure. The renderer can
 * still expand it on demand; the learn tree shows only while something is running or failed. */
export function isQuiet(node: ActivityNode): boolean {
  if (node.status === "running" || node.status === "failed") return false;
  return node.children.every(isQuiet);
}
