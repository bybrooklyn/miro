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

/** Client-side socket discovery: the system socket if a root daemon is running, else the same
 * per-user path the daemon computes (so MIRO_DIR moves both ends - audit #4: the client used to
 * hardcode ~/.miro and miss a daemon started with MIRO_DIR set). */
export function resolveSocketPath(): string {
  if (process.env.MIRO_SOCKET) return process.env.MIRO_SOCKET;
  if (existsSync(SYSTEM_SOCKET_PATH)) return SYSTEM_SOCKET_PATH;
  return join(MIRO_DIR, "mirod.sock");
}

export interface StatusEvent {
  type: "status";
  server: string;
  /** "connecting" is a client-only state the TUI sets when the socket drops (audit U4); the daemon
   * only ever sends "healthy"/"degraded". */
  health: "healthy" | "degraded" | "connecting";
  /** The chat model in use, for the client's status line. Absent until a provider is connected. */
  model?: string;
  /** Whether the daemon runs as root (the system-service layout) or unprivileged. */
  privilege?: "root" | "user";
  /** The daemon's own version (the current version dir's name, via the wrapper's MIRO_VERSION).
   * Absent on a dev run without the version-layout wrapper. */
  version?: string;
}

export interface QuestionOption {
  label: string;
  value: string;
}

export interface QuestionEvent {
  type: "question";
  /** Prefix names the kind: `op_confirm:`, `lifeline_confirm:`, `plan_confirm:`, `plan_change:`, `ask:`. */
  id: string;
  prompt: string;
  /** Empty = free-text answer (the client shows an input instead of a selector). */
  options: QuestionOption[];
  /** The daemon acts on its own if no answer arrives within this window (lifeline auto-revert). */
  timeoutMs?: number;
}

/** The final text of a turn. Always sent, even when reply_delta streamed the same text first. */
export interface ReplyEvent {
  type: "reply";
  text: string;
}

/** A streamed fragment of the reply being written. Concatenate in order; `reply` closes it. */
export interface ReplyDeltaEvent {
  type: "reply_delta";
  text: string;
}

/** One node of the tool-activity tree (plan §20). Sent once with status "running" when a tool
 * call starts and again with the same id when it finishes. `parentId` nests a learning agent's
 * calls under the app_learn call that spawned it, recursively. */
export interface ActivityEvent {
  type: "activity";
  id: string;
  parentId?: string;
  label: string;
  status: "running" | "done" | "failed";
  /** Short outcome text on done/failed (an error message, a count) - never a full payload. */
  detail?: string;
}

/** A one-off line that is not part of a tool tree: a repair gave up, a credential was created.
 * `credential` carries a value the owner must save - the only time a secret crosses the wire. */
export interface NoticeEvent {
  type: "notice";
  level: "info" | "warn" | "credential";
  text: string;
}

/** Phase progress of a running operation, attached to its operation_plan by id. */
export interface OperationProgressEvent {
  type: "operation_progress";
  id: string;
  phase: "capturing" | "applying" | "verifying" | "awaiting_reachability";
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
/** What the engine puts in `details` (operations/engine.ts): the classifier's class, the sandbox
 * scope, the repair contract (expects / rollbackWhen / scopeEvidence / dryRunFidelity - "none"
 * means the effect is unknown, on purpose), plus whatever the kind added (a command, a diff).
 * Named here so a renderer's typechecker can see a field exists instead of guessing at a
 * Record<string, unknown> (audit #11: the client silently dropped the safety-relevant ones). */
export interface OperationPlanDetails {
  class?: "read" | "mutate" | "destructive" | "lifeline" | "forbidden";
  writes?: string[];
  network?: boolean;
  irreversible?: boolean;
  warning?: string;
  expects?: string;
  rollbackWhen?: string;
  scopeEvidence?: string;
  dryRunFidelity?: "exact" | "partial" | "none";
  command?: string;
  diff?: string;
  proposed?: string;
  [key: string]: unknown;
}

export interface OperationPlanEvent {
  type: "operation_plan";
  id: string;
  goal: string;
  summary: string;
  autoApprove: boolean;
  details: OperationPlanDetails | null;
}

/** Final outcome of a tracked operation (plan §38). `applied_unverified`: the change reached the
 * server but verify could not confirm it and the operation is irreversible, so nothing was rolled
 * back - distinct from both a clean commit and a true rollback. */
export interface OperationResultEvent {
  type: "operation_result";
  id: string;
  outcome: "committed" | "rolledback" | "applied_unverified";
  message: string;
}

/** The architecture Miro proposes before a multi-component change (PLAN.md §5.4 A): what it
 * found, what it will reuse vs. install, how the pieces connect, how it will verify. Approved once
 * via a paired `question` (id `plan_confirm:<id>`); routine operations inside it then flow. */
export interface SystemPlanEvent {
  type: "system_plan";
  id: string;
  title: string;
  /** What was inspected and inferred - the evidence the plan rests on. */
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
  | ReplyDeltaEvent
  | ActivityEvent
  | NoticeEvent
  | SecretPromptEvent
  | OperationPlanEvent
  | OperationProgressEvent
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

/** Triggered by the `/pair` slash command - asks mirod for its Iroh connection ticket (plan §54 Stage A). */
export interface PairRequestMessage {
  type: "pair_request";
}

/** Triggered by the `/memory` slash command (plan §37) - lists remembered facts. */
export interface MemoryListMessage {
  type: "memory_list";
}

/** Triggered by `/memory forget <id>` (plan §37) - delete-only editing this slice. */
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

/** ALPN identifying the miro wire protocol to Iroh - bump the suffix on any breaking wire change. */
export const IROH_ALPN = "miro/mirod/1";

/** UTF-8 bytes as a plain array - Iroh's connect/stream APIs take byte arrays, not Buffers. Used
 * for the ALPN and for every protocol line sent over Iroh (audit #27: it was named alpnBytes and
 * carried JSON lines at four of its call sites). */
export function utf8Bytes(text: string): number[] {
  return Array.from(Buffer.from(text, "utf8"));
}

export function encodeLine(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

/** Feeds arbitrary chunks in, calls onLine once per newline-delimited JSON line out. Bytes are
 * decoded as a stream: a multi-byte character split across two chunks (both transports hand over
 * raw byte chunks) used to decode as U+FFFD - "café" in a streamed reply became "caf��" (audit #2).
 * A line longer than MAX_LINE_BYTES is dropped, not accumulated: a peer that never sends a newline
 * is otherwise an unbounded buffer at the daemon's trust boundary. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function createLineBuffer(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  let overflowed = false;
  return (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (overflowed) overflowed = false; // the rest of the oversized line ends here; drop it
      else if (line) onLine(line);
    }
    if (buf.length > MAX_LINE_BYTES) {
      buf = "";
      overflowed = true;
    }
  };
}
