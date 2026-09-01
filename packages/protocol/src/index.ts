import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// Two layouts (PLAN.md §5.5, privilege model): an unprivileged dev run keeps everything under
// ~/.miro; the real system service runs mirod as root with state in /var/lib/miro and its socket
// in /run/miro, group-accessible so the owner's TUI (not root) can connect. MIRO_DIR / MIRO_SOCKET
// override either. `resolveSocketPath()` is what a client uses: it finds the system socket if a
// root daemon is running, else falls back to the per-user one.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

export const MIRO_DIR = process.env.MIRO_DIR ?? (isRoot ? "/var/lib/miro" : join(homedir(), ".miro"));
export const SYSTEM_SOCKET_PATH = "/run/miro/mirod.sock";
export const SOCKET_PATH = process.env.MIRO_SOCKET ?? (isRoot ? SYSTEM_SOCKET_PATH : join(MIRO_DIR, "mirod.sock"));
export const DB_PATH = join(MIRO_DIR, "miro.db");

/** Client-side socket discovery. */
export function resolveSocketPath(): string {
  if (process.env.MIRO_SOCKET) return process.env.MIRO_SOCKET;
  if (existsSync(SYSTEM_SOCKET_PATH)) return SYSTEM_SOCKET_PATH;
  return join(homedir(), ".miro", "mirod.sock");
}

export interface StatusEvent {
  type: "status";
  server: string;
  health: "healthy" | "degraded";
}

export interface QuestionOption {
  label: string;
  value: string;
}

export interface QuestionEvent {
  type: "question";
  id: string;
  prompt: string;
  /** Empty = free-text answer (the client shows an input instead of a selector). */
  options: QuestionOption[];
}

export interface ReplyEvent {
  type: "reply";
  text: string;
}

/** One step of visible tool activity while Miro investigates (plan §20). */
export interface ActivityEvent {
  type: "activity";
  text: string;
}

/** Asks the client for a free-text value (e.g. pasting an API key) rather than a selection. */
export interface SecretPromptEvent {
  type: "secret_prompt";
  id: string;
  prompt: string;
}

/** Visible plan for a tracked mutation before it runs (plan §38, §54 Stage B). Auto-approved
 * operations still send this for transparency; non-auto-approved ones pair it with a `question`
 * (id `op_confirm:<id>`, Approve/Cancel options) that actually gates execution. */
export interface OperationPlanEvent {
  type: "operation_plan";
  id: string;
  goal: string;
  summary: string;
  autoApprove: boolean;
  details: Record<string, unknown> | null;
}

/** Final outcome of a tracked operation (plan §38). */
export interface OperationResultEvent {
  type: "operation_result";
  id: string;
  outcome: "committed" | "rolledback";
  message: string;
}

/** The architecture Miro proposes before a multi-component change (PLAN.md §5.4 A): what it
 * found, what it will reuse vs. install, how the pieces connect, how it will verify. Approved once
 * via a paired `question` (id `plan_confirm:<id>`); routine operations inside it then flow. */
export interface SystemPlanEvent {
  type: "system_plan";
  id: string;
  title: string;
  /** What was inspected and inferred — the evidence the plan rests on. */
  findings: string[];
  /** Each component and what happens to it. */
  components: { name: string; action: "reuse" | "install" | "configure" | "remove"; detail: string }[];
  /** Ordered steps Miro will take. */
  steps: string[];
  /** How Miro will prove it worked. */
  verification: string[];
  /** Anything the user should know before approving (irreversible parts, credentials created, ...). */
  notes?: string[];
}

export type ServerEvent =
  | StatusEvent
  | QuestionEvent
  | ReplyEvent
  | ActivityEvent
  | SecretPromptEvent
  | OperationPlanEvent
  | OperationResultEvent
  | SystemPlanEvent;

export interface ChatMessage {
  type: "chat";
  text: string;
}

export interface AnswerMessage {
  type: "answer";
  id: string;
  value: string;
}

/** Triggered by the `/provider` slash command (plan §12, §17). */
export interface ProviderSetupMessage {
  type: "provider_setup";
}

/** Triggered by the `/pair` slash command — asks mirod for its Iroh connection ticket (plan §54 Stage A). */
export interface PairRequestMessage {
  type: "pair_request";
}

/** Triggered by the `/memory` slash command (plan §37) — lists remembered facts. */
export interface MemoryListMessage {
  type: "memory_list";
}

/** Triggered by `/memory forget <id>` (plan §37) — delete-only editing this slice. */
export interface MemoryForgetMessage {
  type: "memory_forget";
  id: string;
}

// There is deliberately no "learn this app" client message: learning is something the agent
// decides to do on its own mid-request (the app_learn tool), never a command the user has to know
// about. A /learn slash command existed briefly in Stage C slice 2 and was removed in Stage D.

export type ClientMessage =
  | ChatMessage
  | AnswerMessage
  | ProviderSetupMessage
  | PairRequestMessage
  | MemoryListMessage
  | MemoryForgetMessage;

/** ALPN identifying the miro wire protocol to Iroh — bump the suffix on any breaking wire change. */
export const IROH_ALPN = "miro/mirod/1";

/** Iroh's connect/stream APIs take byte arrays, not Buffers. */
export function alpnBytes(alpn: string): number[] {
  return Array.from(Buffer.from(alpn, "utf8"));
}

export function encodeLine(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

/** Feeds arbitrary chunks in, calls onLine once per newline-delimited JSON line out. */
export function createLineBuffer(onLine: (line: string) => void) {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}
