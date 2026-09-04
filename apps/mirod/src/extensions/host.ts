import { join } from "node:path";
import { encodeLine, createLineBuffer } from "@miro/protocol";
import type { HostRequest, HostResponse, HostToolSpec } from "./host-protocol";

const HOST_ENTRY = join(import.meta.dir, "host-entry.ts");
const IDLE_REAP_MS = 5 * 60 * 1000;
/** ponytail: one ceiling for every host call; a generated tool that legitimately needs longer
 * (a big library scan) can grow this when one shows up. Browser calls get a shorter one. */
const REQUEST_TIMEOUT_MS = 120_000;
const BROWSER_TIMEOUT_MS = 60_000;

/** The unprivileged user the extension host runs as when the daemon itself is root. Unset (and
 * unused) for an unprivileged dev daemon. ponytail: MIRO_HOST_USER env, default "miro" - the
 * installer creates that user; no lookup of "some other unprivileged account". */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const HOST_USER = isRoot ? (process.env.MIRO_HOST_USER ?? "miro") : null;
const HOST_HOME = HOST_USER ? (process.env.MIRO_HOST_HOME ?? `/home/${HOST_USER}`) : "";

interface Session {
  proc: ReturnType<typeof Bun.spawn>;
  pending: Map<string, { resolve: (v: HostResponse) => void; reject: (e: unknown) => void }>;
  readyWaiters: (() => void)[];
  ready: boolean;
  lastUsed: number;
}

export interface ExtensionHostManager {
  /** Spawns (or reuses) a real init-mode session against `dir` and calls `tool`. */
  call(dir: string, app: string, baseUrl: string, secrets: Record<string, string>, tool: string, args: unknown): Promise<unknown>;
  /** Resolves an operation binding's params for these args (pure, nothing executes in the host). */
  bind(dir: string, app: string, baseUrl: string, secrets: Record<string, string>, tool: string, args: unknown): Promise<unknown>;
  /** Mechanically derives the manifest's tool specs - spawns a fresh init-mode session. */
  listTools(dir: string, app: string, baseUrl: string, secrets: Record<string, string>): Promise<HostToolSpec[]>;
  /** Like `call`, but in a throwaway session initialised with THIS baseUrl - sessions are keyed by
   * dir and keep their first init, so a validation check against a different URL (the dead-app
   * admission check) must not share the live session. */
  probe(dir: string, app: string, baseUrl: string, secrets: Record<string, string>, tool: string, args: unknown): Promise<unknown>;
  /** Drops the live session for `dir` so the next call loads freshly promoted code. */
  invalidate(dir: string): void;
  /** Browser-automation bridge for the learning agent - keyed by app, not dir (no generated code involved). */
  browserCall(app: string, tool: string, args: unknown): Promise<unknown>;
  closeBrowserSession(app: string): void;
  reapIdle(): void;
  shutdownAll(): void;
}

let requestCounter = 0;
function nextId(): string {
  return `r${++requestCounter}`;
}

export function createExtensionHostManager(): ExtensionHostManager {
  const sessions = new Map<string, Session>();

  function attach(key: string, dir: string, session: Session): void {
    const feed = createLineBuffer((line) => {
      const res = JSON.parse(line) as HostResponse;
      if (res.type === "log") {
        console.error(`[ext-host:${key}] ${res.level} ${res.message}`);
        return;
      }
      if (res.type === "ready") {
        session.ready = true;
        for (const w of session.readyWaiters.splice(0)) w();
        return;
      }
      const id = "id" in res ? res.id : undefined;
      const pending = id ? session.pending.get(id) : undefined;
      if (pending) {
        session.pending.delete(id!);
        pending.resolve(res);
      }
    });
    (async () => {
      // bun-types' ReadableStream doesn't declare Symbol.asyncIterator (even though Bun's
      // runtime supports `for await` over it) - a manual reader loop is fully type-safe either way.
      const reader = (session.proc.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(Buffer.from(value));
      }
    })().catch((err) => console.error(`[ext-host:${key}] stdout read failed`, err));
  }

  function spawn(key: string, dir: string): Session {
    // process.execPath, not "bun" from PATH: a root daemon's PATH rarely includes the bun that
    // started it, and the host must run on exactly the same runtime anyway.
    const bun = process.execPath;
    const proc = Bun.spawn({
      // When the daemon is root (the production privilege model, PLAN.md §5.5), the host drops to
      // an unprivileged user: Chromium refuses to run as root without disabling its own sandbox
      // (found live - "Chrome process closed the pipe"), and generated read-code has no business
      // running as root either. setpriv is util-linux, present on every Debian.
      cmd: HOST_USER ? ["setpriv", `--reuid=${HOST_USER}`, `--regid=${HOST_USER}`, "--init-groups", "--", bun, "run", HOST_ENTRY] : [bun, "run", HOST_ENTRY],
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      // Scrubbed - never the daemon's full env, which can carry provider API keys (see
      // agent/index.ts's PROVIDER_CATALOG envVar fallbacks).
      env: { PATH: process.env.PATH ?? "", HOME: HOST_USER ? HOST_HOME : (process.env.HOME ?? "") },
    });
    const session: Session = { proc, pending: new Map(), readyWaiters: [], ready: false, lastUsed: Date.now() };
    attach(key, dir, session);
    sessions.set(key, session);
    return session;
  }

  function writeLine(session: Session, msg: HostRequest): void {
    (session.proc.stdin as any).write(encodeLine(msg));
    (session.proc.stdin as any).flush?.();
  }

  // Races against the process actually exiting - a subprocess that fails during init (a
  // generated file that can't even be imported) exits without ever sending "ready" (host-entry.ts
  // exits deliberately on any init-time error); without this race, awaiting readiness would hang
  // forever instead of surfacing the real failure. Found live via an isolated RPC smoke test.
  function waitReady(session: Session): Promise<void> {
    if (session.ready) return Promise.resolve();
    return Promise.race([
      new Promise<void>((resolve) => session.readyWaiters.push(resolve)),
      session.proc.exited.then(() => {
        throw new Error("extension-host process exited before it became ready - check its logs");
      }),
    ]);
  }

  function isAlive(session: Session): boolean {
    return session.proc.exitCode === null;
  }

  async function getSession(key: string, dir: string, init: HostRequest): Promise<Session> {
    const existing = sessions.get(key);
    if (existing && isAlive(existing)) {
      existing.lastUsed = Date.now();
      // Await readiness even for a reused session: spawn() registers it in the map synchronously, so
      // a SECOND concurrent call can reach here while the first call's init (loadExtension) is still
      // in flight. Without this, that call's request line reaches host-entry before `loaded` is set
      // and comes back "Unknown tool: <name>". Found live on the dev VM: the agent issued two
      // jellyfin tool calls in parallel on a cold host; the earlier one raced init and failed while
      // the later one succeeded. waitReady resolves immediately once ready, so the warm path is free.
      await waitReady(existing);
      return existing;
    }
    if (existing) sessions.delete(key); // dead, replace
    const session = spawn(key, dir);
    writeLine(session, init);
    await waitReady(session);
    return session;
  }

  // Same class of fix as waitReady: if the subprocess dies mid-request (crashes, or is killed)
  // rather than merely failing to start, the pending promise would otherwise hang forever with
  // nothing ever resolving or rejecting it.
  async function request(session: Session, req: Extract<HostRequest, { id: string }>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HostResponse> {
    session.lastUsed = Date.now();
    const pending = new Promise<HostResponse>((resolve, reject) => {
      session.pending.set(req.id, { resolve, reject });
      writeLine(session, req);
    });
    // A call that never answers (a browser navigate that hangs on a SPA - found in acceptance run
    // #3, where one browser_open stalled the learning agent and with it the whole chat turn) must
    // fail like any other tool error so the agent can move on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        session.pending.delete(req.id);
        reject(new Error(`extension-host call ${req.type}${"tool" in req ? ` ${req.tool}` : ""} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        pending,
        timeout,
        session.proc.exited.then(() => {
          throw new Error("extension-host process exited before responding - check its logs");
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async call(dir, app, baseUrl, secrets, tool, args) {
      const session = await getSession(dir, dir, { type: "init", app, baseUrl, secrets });
      const res = await request(session, { type: "call", id: nextId(), tool, args });
      if (res.type !== "result") throw new Error(`unexpected response type: ${res.type}`);
      if (!res.ok) throw new Error(res.error);
      return res.value;
    },
    async bind(dir, app, baseUrl, secrets, tool, args) {
      const session = await getSession(dir, dir, { type: "init", app, baseUrl, secrets });
      const res = await request(session, { type: "bind", id: nextId(), tool, args });
      if (res.type !== "result") throw new Error(`unexpected response type: ${res.type}`);
      if (!res.ok) throw new Error(res.error);
      return res.value;
    },
    invalidate(dir) {
      const session = sessions.get(dir);
      if (!session) return;
      writeLine(session, { type: "shutdown" });
      sessions.delete(dir);
    },
    async listTools(dir, app, baseUrl, secrets) {
      const key = `${dir}:list`;
      const session = spawn(key, dir); // always fresh - this is a one-shot introspection, not a reused session
      writeLine(session, { type: "init", app, baseUrl, secrets });
      await waitReady(session);
      const res = await request(session, { type: "list_tools", id: nextId() });
      writeLine(session, { type: "shutdown" });
      sessions.delete(key);
      if (res.type !== "tools") throw new Error(`unexpected response type: ${res.type}`);
      return res.tools;
    },
    async probe(dir, app, baseUrl, secrets, tool, args) {
      const key = `${dir}:probe:${nextId()}`;
      const session = spawn(key, dir);
      try {
        writeLine(session, { type: "init", app, baseUrl, secrets });
        await waitReady(session);
        const res = await request(session, { type: "call", id: nextId(), tool, args });
        if (res.type !== "result") throw new Error(`unexpected response type: ${res.type}`);
        if (!res.ok) throw new Error(res.error);
        return res.value;
      } finally {
        writeLine(session, { type: "shutdown" });
        sessions.delete(key);
      }
    },
    async browserCall(app, tool, args) {
      const key = `learn:${app}`;
      // learn_init mode never dynamically imports anything from cwd, so any valid directory
      // works here - the daemon's own cwd is just a convenient always-existent default.
      const session = await getSession(key, process.cwd(), { type: "learn_init", app });
      const res = await request(session, { type: "call", id: nextId(), tool, args }, BROWSER_TIMEOUT_MS);
      if (res.type !== "result") throw new Error(`unexpected response type: ${res.type}`);
      if (!res.ok) throw new Error(res.error);
      return res.value;
    },
    closeBrowserSession(app) {
      const key = `learn:${app}`;
      const session = sessions.get(key);
      if (!session) return;
      writeLine(session, { type: "shutdown" });
      sessions.delete(key);
    },
    reapIdle() {
      const now = Date.now();
      for (const [key, session] of sessions) {
        if (now - session.lastUsed > IDLE_REAP_MS) {
          writeLine(session, { type: "shutdown" });
          sessions.delete(key);
        }
      }
    },
    shutdownAll() {
      for (const [key, session] of sessions) {
        writeLine(session, { type: "shutdown" });
        sessions.delete(key);
      }
    },
  };
}
