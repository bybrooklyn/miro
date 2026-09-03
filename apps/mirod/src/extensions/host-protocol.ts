// Daemon <-> extension-host subprocess RPC (plan §34). Deliberately NOT in packages/protocol —
// that package is the client-facing wire protocol (mirod<->miro, over a socket a real remote party
// can be on the other end of). This boundary is a same-machine child process the daemon spawns and
// owns; nothing client-facing ever sees these types. Still reuses @miro/protocol's encodeLine/
// createLineBuffer framing as-is (they're generic (msg: object) => string / (onLine) => feed
// utilities, not typed to ClientMessage/ServerEvent) — no protocol change needed to share it here.

/** One `call` covers both a real extension tool invocation (mode "init", tool name is one of the
 * generated tools/diagnostics) and a browser-automation call during learning (mode "learn_init",
 * tool name is one of "browser_*") — host-entry.ts routes based on which init mode it was started
 * in.
 *
 * Deliberately NOT included here: http_probe/secret_store/extension_write. Those need the
 * daemon's own DB/filesystem access (secrets.ts, ~/.miro/extensions/) that this subprocess
 * structurally lacks by design — they're plain trusted AgentTools in agent/learn-tools.ts,
 * running in the daemon process, no RPC involved. Only browser automation (which launches a real
 * Chromium via Bun.WebView) benefits from the subprocess boundary here, and that's for process
 * hygiene (heavyweight external process, clean teardown on kill) as much as isolation — during
 * learning there's no generated/untrusted code running yet at all. */
export type HostRequest =
  | { type: "init"; app: string; baseUrl: string; secrets: Record<string, string> }
  | { type: "learn_init"; app: string }
  | { type: "call"; id: string; tool: string; args: unknown }
  /** Resolve an operation binding's params for these args — pure, nothing executes here. The
   * daemon runs the bound operation through its own engine (PLAN.md §5.5 decision 2). */
  | { type: "bind"; id: string; tool: string; args: unknown }
  | { type: "list_tools"; id: string }
  | { type: "shutdown" };

export interface HostToolSpec {
  name: string;
  kind: "tool" | "diagnostic" | "operation";
  label: string;
  description: string;
  parameters: unknown; // a TSchema value, JSON-serialized
}

export type HostResponse =
  | { type: "ready" }
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string }
  | { type: "tools"; id: string; tools: HostToolSpec[] }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };
