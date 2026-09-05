import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@miro/agent-core";
import { streamSimple, type Effort, type Model } from "@miro/model-client";
import { Type, type Static } from "@miro/schema-engine/typebox";
import type { ModelRegistry } from "../agent/models";
import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { AGENT_TOOLS } from "../agent/tools";
// Deliberately from model-utils.ts, NOT "../agent/index" - importing from agent/index.ts here
// would recreate agent/index.ts -> agent/learn-tools.ts -> extensions/learn.ts ->
// extensions/learn-agent.ts -> agent/index.ts, the exact circular import model-utils.ts exists to
// avoid (see its own comment). It happened to still work via ESM's lazy live-binding resolution
// when tried, but that's fragile luck, not a real fix - this is the correct, leaf-module import.
import { limitTurns, runTurn } from "../agent/model-utils";
import { buildReadTools } from "../agent/read-tools";
import { buildInteractionTools, NO_USER_ANSWER } from "../agent/interaction-tools";
import { buildOperationTools } from "../agent/operation-tools";
import type { OperationToolContext } from "../operations/engine";
import { remember } from "../memory/store";
import { listSecretRefs } from "../secrets";
import type { ExtensionHostManager } from "./host";
import { validateExtension, failure, formatFailure, type ValidationFailure } from "./validate";
import { hashExtension } from "./pin";
import { buildManifest } from "./manifest";
import * as store from "./store";
import { stagingDir, extensionDir, ensureNodeModulesSymlink, promoteStagingToLive, discardStaging, MIROD_NODE_MODULES } from "./paths";
import type { CodegenSelection } from "./learn";

// The learning agent (PLAN.md §5.2 C) - the mechanism underneath "Miro autonomously expands its
// own capabilities in pursuit of a goal". Spawned by app_learn (from the main agent, or from
// another learning agent recursing), never by a user command. It inspects, researches, chooses
// the app's best control method, generates an extension (read tools as code, writes as
// declarative bindings), validates it, promotes it, and records the app's operational model.

const LEARN_SYSTEM_PROMPT = `You are Miro, learning to operate a self-hosted app you do not know yet, so that from now on you
can manage it with direct tools instead of research. Narrate briefly as you go.

DISCOVERY LADDER - cheapest first, escalate only when the rung below did not explain enough:
1. Inspect what is already here: container_list / container_inspect (image, env, volumes, ports),
   shell_inspect (processes, config directories, CLI binaries), read_file on its config. Facts on
   the machine beat documentation.
2. Official documentation and API references (web_search, http_get).
3. Probe the API for real (http_get). Prefer an API once it works.
4. The app's CLI or configuration files, if it has no usable API (shell_inspect / read_file).
5. Packet capture (net_capture) when nothing above shows how the app is really controlled: watch
   what its web UI sends to its backend, find undocumented local calls, confirm ports and paths.
6. Browser automation (browser_*) last - for bootstrapping something only the UI can do.

CONTROL METHOD IS ADAPTIVE. Decide what the best interface actually is - REST, CLI, config file,
socket - and hide that choice inside the tools you generate. The caller of download_movie(...)
must not care whether it is an HTTP POST or a CLI call underneath.

TOOLS ARE OUTCOMES, NOT ENDPOINTS. Name and shape them around what an operator wants
(add_media_library, list_active_sessions, complete_setup_wizard), not around URL paths.

CREDENTIALS ARE YOUR JOB. Discover existing ones where you legitimately can (container env,
config files via read_file). When the app needs a NEW password or token (a first admin account,
an API key), call credential_create - it generates a strong value, stores it under a reference,
and shows it to the user once; you only ever see the reference. Then pass the reference (never a
value) into operation bindings via secretHeader, or read it in generated code via ctx.secrets.
When you create an account, secret_store its username too (pass the short name "admin_user", not a
full reference - the tool adds the extension.<app>. prefix), so a later session can authenticate
with {{secret:extension.<app>.admin_user}} and {{secret:extension.<app>.admin_password}}. A token or key that
a RESPONSE returns (a login's AccessToken, a minted API key) is kept with http_mutation's
storeResponseField { field, ref } - it goes straight into the store and you get the ref; tool
output is redacted, so reading it out of a response body does not work.
Save credentials you discover with secret_store. Credentials already on file are listed at the
end of this prompt: use them, never ask the user for one of them. NEVER ask the user to invent a
password for an app on this machine. Ask the user (ask_user, secretRef) ONLY for a credential
that lives outside this machine (a VPN provider login, an external account).

ASK ABOUT INTENT, INFER IMPLEMENTATION. Before asking anything, check whether the machine already
answers it. Never ask about ports, networks, paths, or which component to use.

DECLARATIVE FIRST - write DATA, not code. The extension is ONE file, extension.ts, that
\`export default { auth?, entries } satisfies ExtensionModule\`. Each entry is one capability:
- A READ (kind "tool" or "diagnostic") is declarative data: { name, kind, description,
  read: { path, method?, query?, pick?, expectStatus? } }. The daemon GETs read.path (app-relative,
  e.g. "/Library/VirtualFolders"), substituting {placeholders} in the path from the tool's args,
  applies the module's auth, and - if you give pick - keeps only those fields (mapping over an
  array). No code runs. Prefer this for everything a GET can answer.
- A WRITE (kind "operation") is a binding: { name, kind: "operation", parameters, bind: (args) => ({
  kind: "http_mutation" | "shell_command" | "file_write", goal, ...params }) }. bind is synchronous -
  it returns plain data, never fetches - and the daemon runs it through its engine (confirmation,
  sandbox, verification, rollback). URLs may be app-relative. Give every binding a verify
  (verifyUrl/verifyExpect, or a verify command) and a rollback where the app allows one.
- CODE is the escape hatch, ONLY when a read needs logic a \`read\` cannot express (pagination,
  combining calls, a health check that returns a boolean instead of throwing): { name, kind,
  parameters, code: (ctx, args) => Promise<unknown> }. ctx is read-only (ctx.http.get, ctx.exec,
  ctx.readFile, ctx.secrets). Reach for it last.
AUTH is declarative: set the module's auth: { header, secret, prefix? } and every read sends it
automatically - { header: "X-Emby-Token", secret: "api_key" } sends the bare token; when the app
wants a scheme word in front of it, say so with prefix: { header: "Authorization", secret: "api_key",
prefix: "Bearer " } or { header: "Authorization", secret: "session_token", prefix: "MediaBrowser Token=" }.
A code entry reads ctx.secrets.<name> (the real value), or writes the placeholder {{secret:<ref>}} in a
header or query it passes to ctx.http.get - substituted at request time.
Credentials never appear as values: in a write header use secretHeader: { name, ref }; anywhere in a
body or URL write the placeholder {{secret:<ref>}} (e.g.
{"Name":"admin","Password":"{{secret:extension.jellyfin.admin_password}}"}) - the daemon
substitutes the real value at request time and the plan shows only the placeholder. The same
placeholder works when you call http_mutation yourself during learning.

SCHEMAS: for a declarative read, OMIT parameters - it is DERIVED from the {placeholders} in read.path
(each a required string). For a code entry that takes structured args, set parameters to a real JSON
Schema built with Type from "@miro/sdk" - parameters: Type.Object({ id: Type.String() }) - or
Type.Object({}) for none. Never a plain object like { id: "string" }; validation rejects it.

RECURSE WHEN YOU MUST. If operating this app requires another app you do not know (an indexer
manager, a download client), call app_learn for it, let it finish, then continue here.

WHEN YOU UNDERSTAND THE APP, call extension_write with a single extensionTs. There is no test file -
the daemon validates by typechecking it, then probing every no-arg diagnostic against the live app
and dry-running every no-arg operation binding through its real engine kind, so it is tested against
the real thing. Rules:
- extensionTs does \`export default { auth?, entries } satisfies ExtensionModule\` - import the types
  from "@miro/sdk", import nothing else.
- Prefer declarative read entries; use bind for writes; use code only where a read cannot express it.
- Every name matches ^[a-zA-Z0-9_-]+$ (underscores, never dots).
extension_write reports ALL problems at once as structured failures - { entry, field, rule, message,
fix, example } - ordered most-likely-root-cause first (auth scheme, then base URL, then headers, then
parameter types). Apply every fix and call again. You get exactly ONE repair call in this session; if
it still fails, a fresh session continues from your draft with the same structured failures - so do
not restart research, fix what is named.
- A "diagnostic" must observe the app through its own interface (its baseUrl) and signal a problem by
  THROWING: the daemon treats any returned value as healthy, and checks that every code diagnostic
  FAILS when the app is unreachable. Something that checks a container, a process or a file is a
  "tool", not a "diagnostic".

@miro/sdk SURFACE - the only import, exact shapes (write to them, do not guess):
  ExtensionModule = { auth?: { header: string; secret: string }; entries: ExtensionEntry[] }
  ExtensionEntry  = { name; kind: "tool"|"diagnostic"|"operation"; description; label?; parameters?;
                      read?; bind?; code? } - exactly ONE of read / bind / code.
  read (ReadBinding) = { path; method?: "GET"; query?; headers?; pick?: string[]; expectStatus?: number[] }
  bind(args) => { kind: "http_mutation"|"shell_command"|"file_write"; goal; ...params }
  code(ctx, args) => Promise<unknown>; ctx = { http.get(path, {query?,headers?}), exec(cmd),
      readFile(path), secrets } - http.get returns { status; ok; body; json<T>() }, never throws on non-2xx.
  Type from "@miro/sdk" for any hand-written schema.

WORKED EXAMPLE - a complete, correct extension for a token-auth HTTP app (copy this shape exactly):
  import { Type, type ExtensionModule, type ExtensionContext } from "@miro/sdk";
  export default {
    auth: { header: "X-Api-Key", secret: "api_key" },
    entries: [
      { name: "list_widgets", kind: "tool", description: "List all widgets.",
        read: { path: "/api/widgets", pick: ["id", "label"] } },
      { name: "get_widget", kind: "tool", description: "Get one widget by id.",
        read: { path: "/api/widgets/{id}" } },                       // parameters derived from {id}
      { name: "create_widget", kind: "operation", description: "Create a widget.",
        parameters: Type.Object({ label: Type.String() }),
        bind: (args: { label: string }) => ({
          kind: "http_mutation", goal: \`Create widget \${args.label}\`,
          method: "POST", url: "/api/widgets",
          body: JSON.stringify({ label: args.label }), contentType: "application/json",
          secretHeader: { name: "X-Api-Key", ref: "extension.myapp.api_key" },
          verifyUrl: "/api/widgets" }) },
      { name: "reachable", kind: "diagnostic", description: "App answers on its health endpoint.",
        code: async (ctx: ExtensionContext) => { const r = await ctx.http.get("/health"); return { healthy: r.ok, status: r.status }; } },
    ],
  } satisfies ExtensionModule;

FINALLY, call capability_write with the app's operational model: what it is for, how it is
controlled, its components and what it depends on, how data flows through it, which credentials
(by reference) it uses, and how to verify it is working. This is what makes the next request a
single tool call instead of another research session.

You are learning, not setting up: make changes only when learning needs them (creating an API
key, enabling an API). Leave configuration to whoever asked, unless the goal says otherwise.`;

function textResult(details: unknown): AgentToolResult<unknown> {
  // details ?? null: JSON.stringify(undefined) returns the value undefined (not a string),
  // producing a malformed {text: undefined} block that crashes downstream message processing.
  // Found live: browser_open (Promise<void>) resolves to undefined, and this exact shape hit
  // "undefined is not an object (evaluating 'block.text.length')" deep inside pi-agent-core.
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

function buildBrowserTools(app: string, hostMgr: ExtensionHostManager) {
  const bridge = (name: string, label: string, description: string, parameters: any) => ({
    name,
    label,
    description,
    parameters,
    execute: async (_id: string, args: unknown) => textResult(await hostMgr.browserCall(app, name, args)),
  });
  return [
    bridge("browser_open", "Open page", "Navigate the learning browser session to a URL.", Type.Object({ url: Type.String() })),
    bridge("browser_snapshot", "Inspect page", "List interactive/notable elements currently on the page.", Type.Object({})),
    bridge(
      "browser_find",
      "Find on page",
      "Find elements matching text/selector/role.",
      Type.Object({ text: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), role: Type.Optional(Type.String()) }),
    ),
    bridge("browser_click", "Click", "Click an element by selector (from snapshot/find).", Type.Object({ selector: Type.String() })),
    bridge("browser_fill", "Fill field", "Click then type into an element.", Type.Object({ selector: Type.String(), value: Type.String() })),
    bridge("browser_select", "Select option", "Set a <select> element's value.", Type.Object({ selector: Type.String(), value: Type.String() })),
    bridge(
      "browser_read",
      "Read page",
      "Read text/value/attributes of an element, or the whole page if no selector given.",
      Type.Object({ selector: Type.Optional(Type.String()) }),
    ),
    bridge(
      "browser_wait",
      "Wait for element",
      "Wait for an element to appear.",
      Type.Object({ selector: Type.String(), timeoutMs: Type.Optional(Type.Number()) }),
    ),
  ];
}

function buildSecretStoreTool(app: string, setSecret: (ref: string, value: string) => void) {
  return {
    name: "secret_store",
    label: "Store credential",
    description: "Save a credential (API key/token) discovered or created for this app. Refer to it by the returned reference afterwards - never repeat the value anywhere.",
    parameters: Type.Object({ name: Type.String({ description: "Short name only, e.g. 'api_key' or 'admin_user' - NOT a full reference." }), value: Type.String() }),
    execute: async (_id: string, args: { name: string; value: string }) => {
      // Defensive: the model sometimes passes a whole ref ("extension.jellyfin.admin_user") as the
      // name, which used to double the prefix into extension.jellyfin.extension.jellyfin.admin_user
      // (found live, run #10). Strip any leading extension.<app>. and sanitise to a bare name.
      const name = args.name.replace(/^extension\.[^.]+\./, "").replace(/[^A-Za-z0-9_]/g, "_");
      const ref = `extension.${app}.${name}`;
      const value = args.value.trim();
      // The no-user marker is an answer, never a credential (found stored as one, live - PLAN.md §5.20).
      if (!value || value === NO_USER_ANSWER) return textResult({ saved: false, reason: "that is not a credential value - nothing stored" });
      setSecret(ref, value);
      return textResult({ saved: true, ref });
    },
  };
}

const capabilityWriteParams = Type.Object({
  summary: Type.String({ description: "One or two sentences: what this app is for and how Miro controls it." }),
  components: Type.Array(Type.Object({ name: Type.String(), role: Type.String(), interface: Type.Optional(Type.String()), baseUrl: Type.Optional(Type.String()) })),
  dataFlow: Type.Array(Type.String(), { description: "How data moves, e.g. 'request → Radarr → Prowlarr search → qBittorrent (VPN) → import → Jellyfin'." }),
  credentials: Type.Array(Type.String(), { description: "Secret references only (extension.<app>.<name>), never values." }),
  verify: Type.Array(Type.String(), { description: "How to prove it works: tool names or checks." }),
  notes: Type.Optional(Type.Array(Type.String())),
});

function buildCapabilityWriteTool(app: string, db: Database) {
  return {
    name: "capability_write",
    label: "Record operational model",
    description: "Record the app's durable operational model (PLAN §5.4 E) so future requests use its tools directly instead of researching again.",
    parameters: capabilityWriteParams,
    execute: async (_id: string, args: Static<typeof capabilityWriteParams>) => {
      remember(db, "capability", app, JSON.stringify(args), "learning_agent");
      return textResult({ saved: true, key: app });
    },
  };
}

const extensionWriteParams = Type.Object({
  displayName: Type.String(),
  baseUrl: Type.String({ description: "Base URL of the app's API/web UI, e.g. http://localhost:8080" }),
  secretNames: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
  extensionTs: Type.String({ description: 'The complete extension.ts: `export default { auth?, entries } satisfies ExtensionModule` (types from "@miro/sdk"). Declarative reads/bindings preferred; code only where a read cannot express it.' }),
});

/** The write plus ONE targeted repair per session (PLAN.md §5.15): chained repairs on one draft in
 * one context converge worse than fresh regenerations seeded with the last draft and its structured
 * failures - extensions/learn.ts runs up to MAX_REGENERATIONS independent sessions. */
const MAX_WRITE_ATTEMPTS = 2;

/** What the last failed write looked like - a fresh session starts from it instead of from nothing. */
export interface LearnSeed {
  draft: string;
  failures: ValidationFailure[];
}

function buildExtensionWriteTool(
  app: string,
  db: Database,
  hostMgr: ExtensionHostManager,
  getSecret: (ref: string) => string | null,
) {
  let attempts = 0;
  let promoted = false;
  let lastAttempt: LearnSeed | null = null;

  const tool = {
    name: "extension_write",
    label: "Write extension",
    description:
      "Write and validate the local extension for this app. Call once you understand the app well enough. If it reports failures, fix exactly what they name and call again once - you get one repair call in this session.",
    parameters: extensionWriteParams,
    execute: async (_id: string, args: Static<typeof extensionWriteParams>) => {
      attempts++;
      if (attempts > MAX_WRITE_ATTEMPTS) {
        return textResult({ ok: false, failures: [failure("budget", `This session's write budget (${MAX_WRITE_ATTEMPTS}: the write plus one repair) is spent - stop and report what is still failing; a fresh session will continue from your last draft.`)] });
      }

      const dir = stagingDir(app);
      discardStaging(app);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "extension.ts"), args.extensionTs);
      ensureNodeModulesSymlink(dir, MIROD_NODE_MODULES);

      const secrets: Record<string, string> = {};
      for (const s of args.secretNames) {
        const value = getSecret(`extension.${app}.${s.name}`);
        if (value) secrets[s.name] = value;
      }

      const result = await validateExtension(dir, app, args.baseUrl, secrets, hostMgr);
      if (!result.ok) {
        lastAttempt = { draft: args.extensionTs, failures: result.failures };
        // Logged, not just returned to the model: a failed learn otherwise leaves no trace of WHY
        // (found post-mortem on a run that burned all attempts).
        console.log(`[mirod] extension_write(${app}) attempt ${attempts} failed:\n  ${result.failures.map(formatFailure).join("\n  ")}`);
        return textResult({ ok: false, failures: result.failures, attemptsRemaining: MAX_WRITE_ATTEMPTS - attempts });
      }
      console.log(`[mirod] extension_write(${app}) attempt ${attempts} validated`);

      const existing = store.getExtension(db, app);
      const version = (existing?.version ?? 0) + 1;
      const manifest = buildManifest(app, args.displayName, args.baseUrl, args.secretNames, result.tools ?? [], version);
      writeFileSync(join(dir, "manifest"), JSON.stringify(manifest, null, 2));

      // Pinned as validated (extensions/pin.ts): the rename below preserves the bytes.
      const contentHash = hashExtension(dir);
      promoteStagingToLive(app);
      hostMgr.invalidate(extensionDir(app)); // the live session (if any) has the old code loaded
      store.promote(db, app, JSON.stringify(manifest), version, args.baseUrl, contentHash);
      promoted = true;
      lastAttempt = null;

      return textResult({
        ok: true,
        version,
        toolCount: manifest.tools.length,
        diagnosticCount: manifest.diagnostics.length,
        operationCount: manifest.operations?.length ?? 0,
      });
    },
  };

  return { tool, wasPromoted: () => promoted, lastAttempt: () => lastAttempt };
}

export interface LearnAgentOptions {
  goal: string;
  app: string;
  depth: number;
  db: Database;
  hostMgr: ExtensionHostManager;
  setSecret: (ref: string, value: string) => void;
  getSecret: (ref: string) => string | null;
  models: ModelRegistry;
  model: Model<any>;
  reasoning?: Effort;
  getStoredKey: (provider: string) => string | null;
  send: (event: ServerEvent) => void;
  waitForAnswer?: (id: string) => Promise<string>;
  operationCtx?: OperationToolContext;
  /** Needed for recursion - a nested app_learn resolves its own codegen model the same way. */
  resolveCodegenModel: () => Promise<CodegenSelection | null>;
  /** This session's tool calls render nested under this activity node (the app_learn call). */
  parentActivityId?: string;
  maxTurns?: number;
  /** A previous session's last draft and its structured failures: this session starts from them
   * (an independent regeneration, PLAN.md §5.15) instead of from nothing. */
  seed?: LearnSeed;
}

const DEFAULT_MAX_TURNS = 40; // ponytail: a guess, tuned by live runs - research + codegen + operations need more than the old 24

export interface LearnAgentResult {
  text: string;
  promoted: boolean;
  /** The last failed write, for the next regeneration to start from; null if promoted or never written. */
  lastAttempt: LearnSeed | null;
}

/** The seed, phrased for the model: the draft verbatim plus the failures as the same JSON objects
 * extension_write returns, so a fresh context sees exactly what the last one was told. */
function seedText(seed: LearnSeed): string {
  return `\n\nA previous independent attempt already wrote this extension.ts:\n\`\`\`ts\n${seed.draft}\n\`\`\`\nIt failed validation with these structured failures (most likely root cause first):\n${JSON.stringify(seed.failures, null, 2)}\nStart from that draft and fix exactly what is named. Do not restart research unless a failure shows the app differs from what the draft assumes.`;
}

export async function spawnLearningAgent(o: LearnAgentOptions): Promise<LearnAgentResult> {
  const { tool: writeTool, wasPromoted, lastAttempt } = buildExtensionWriteTool(o.app, o.db, o.hostMgr, o.getSecret);

  // Lazy import breaks the learn.ts <-> learn-agent.ts cycle for recursion: learn.ts imports
  // spawnLearningAgent statically; this side only needs runLearnFlow at call time.
  const recursiveLearn = {
    name: "app_learn",
    label: "Learn another app",
    description: "Learn a dependency you discovered you need (an indexer manager, a download client, ...). Runs a nested learning session and returns when it is done; then continue here.",
    parameters: Type.Object({ app: Type.String(), hint: Type.Optional(Type.String()) }),
    execute: async (id: string, args: { app: string; hint?: string }) => {
      const { runLearnFlow } = await import("./learn");
      const r = await runLearnFlow({
        app: args.app,
        hint: args.hint,
        depth: o.depth + 1,
        db: o.db,
        hostMgr: o.hostMgr,
        setSecret: o.setSecret,
        getSecret: o.getSecret,
        models: o.models,
        resolveCodegenModel: o.resolveCodegenModel,
        getStoredKey: o.getStoredKey,
        send: o.send,
        waitForAnswer: o.waitForAnswer,
        operationCtx: o.operationCtx,
        parentActivityId: id, // nest the next level under this call
      });
      return textResult(r);
    },
  };

  const tools = [
    ...AGENT_TOOLS.filter((t) => ["web_search", "container_list", "container_inspect", "container_logs", "systemd_list", "hardware_gpu", "network_info", "packages_list"].includes(t.name)),
    ...buildReadTools({ getSecret: o.getSecret }),
    ...buildBrowserTools(o.app, o.hostMgr),
    ...buildInteractionTools({
      send: o.send,
      // No user on the other end (autonomous repair): every question resolves to a marker the
      // prompt tells the agent to treat as "decide yourself or stop".
      waitForAnswer: o.waitForAnswer ?? (async () => NO_USER_ANSWER),
      setSecret: o.setSecret,
    }).filter((t) => t.name === "ask_user" || t.name === "credential_create"),
    ...(o.operationCtx ? buildOperationTools(o.operationCtx) : []),
    buildSecretStoreTool(o.app, o.setSecret),
    buildCapabilityWriteTool(o.app, o.db),
    writeTool,
    recursiveLearn,
  ];

  const maxTurns = o.maxTurns ?? DEFAULT_MAX_TURNS;
  const refs = listSecretRefs(o.db, "extension.");
  const systemPrompt = `${LEARN_SYSTEM_PROMPT}\n\nCredentials on file (references only - values are never shown): ${refs.length > 0 ? refs.join(", ") : "none yet"}.`;
  const agent = new Agent({
    // Heterogeneous per-tool parameter schemas can't unify into one array type without erasure -
    // same cast agent/index.ts's own createMiroAgent uses for the exact same reason.
    initialState: { systemPrompt: [systemPrompt], model: o.model, tools: tools as AgentTool<any>[] },
    streamFn: (m, context, options) => streamSimple(m, context, o.reasoning ? { ...options, reasoning: o.reasoning } : options),
    getApiKey: (m) => o.models.getApiKey(m),
  });
  limitTurns(agent, maxTurns);

  try {
    const text = await runTurn(agent, o.seed ? `${o.goal}${seedText(o.seed)}` : o.goal, {
      parentActivityId: o.parentActivityId,
      onActivity: (node) => o.send({ type: "activity", ...node }),
    });
    return { text, promoted: wasPromoted(), lastAttempt: lastAttempt() };
  } finally {
    o.hostMgr.closeBrowserSession(o.app);
  }
}
