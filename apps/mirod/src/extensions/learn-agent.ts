import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Model, type Static, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { AGENT_TOOLS } from "../agent/tools";
// Deliberately from model-utils.ts, NOT "../agent/index" — importing from agent/index.ts here
// would recreate agent/index.ts -> agent/learn-tools.ts -> extensions/learn.ts ->
// extensions/learn-agent.ts -> agent/index.ts, the exact circular import model-utils.ts exists to
// avoid (see its own comment). It happened to still work via ESM's lazy live-binding resolution
// when tried, but that's fragile luck, not a real fix — this is the correct, leaf-module import.
import { resolveApiKey, runTurn } from "../agent/model-utils";
import { buildReadTools } from "../agent/read-tools";
import { buildInteractionTools } from "../agent/interaction-tools";
import { buildOperationTools } from "../agent/operation-tools";
import type { OperationToolContext } from "../operations/engine";
import { remember } from "../memory/store";
import { listSecretRefs } from "../secrets";
import type { ExtensionHostManager } from "./host";
import { validateExtension } from "./validate";
import { buildManifest } from "./manifest";
import * as store from "./store";
import { stagingDir, extensionDir, ensureNodeModulesSymlink, promoteStagingToLive, discardStaging, MIROD_NODE_MODULES } from "./paths";
import type { CodegenSelection } from "./learn";

// The learning agent (PLAN.md §5.2 C) — the mechanism underneath "Miro autonomously expands its
// own capabilities in pursuit of a goal". Spawned by app_learn (from the main agent, or from
// another learning agent recursing), never by a user command. It inspects, researches, chooses
// the app's best control method, generates an extension (read tools as code, writes as
// declarative bindings), validates it, promotes it, and records the app's operational model.

const LEARN_SYSTEM_PROMPT = `You are Miro, learning to operate a self-hosted app you do not know yet, so that from now on you
can manage it with direct tools instead of research. Narrate briefly as you go.

DISCOVERY LADDER — cheapest first, escalate only when the rung below did not explain enough:
1. Inspect what is already here: container_list / container_inspect (image, env, volumes, ports),
   shell_inspect (processes, config directories, CLI binaries), read_file on its config. Facts on
   the machine beat documentation.
2. Official documentation and API references (web_search, http_get).
3. Probe the API for real (http_get). Prefer an API once it works.
4. The app's CLI or configuration files, if it has no usable API (shell_inspect / read_file).
5. Packet capture (net_capture) when nothing above shows how the app is really controlled: watch
   what its web UI sends to its backend, find undocumented local calls, confirm ports and paths.
6. Browser automation (browser_*) last — for bootstrapping something only the UI can do.

CONTROL METHOD IS ADAPTIVE. Decide what the best interface actually is — REST, CLI, config file,
socket — and hide that choice inside the tools you generate. The caller of download_movie(...)
must not care whether it is an HTTP POST or a CLI call underneath.

TOOLS ARE OUTCOMES, NOT ENDPOINTS. Name and shape them around what an operator wants
(add_media_library, list_active_sessions, complete_setup_wizard), not around URL paths.

CREDENTIALS ARE YOUR JOB. Discover existing ones where you legitimately can (container env,
config files via read_file). When the app needs a NEW password or token (a first admin account,
an API key), call credential_create — it generates a strong value, stores it under a reference,
and shows it to the user once; you only ever see the reference. Then pass the reference (never a
value) into operation bindings via secretHeader, or read it in generated code via ctx.secrets.
When you create an account, secret_store its username too (extension.<app>.admin_user), so a
later session can authenticate with {{secret:...}} placeholders for both.
Save credentials you discover with secret_store. Credentials already on file are listed at the
end of this prompt: use them, never ask the user for one of them. NEVER ask the user to invent a
password for an app on this machine. Ask the user (ask_user, secretRef) ONLY for a credential
that lives outside this machine (a VPN provider login, an external account).

ASK ABOUT INTENT, INFER IMPLEMENTATION. Before asking anything, check whether the machine already
answers it. Never ask about ports, networks, paths, or which component to use.

WRITES NEVER LIVE IN GENERATED CODE. Anything that changes the app's state is an operation
binding in operations.ts: buildOperations(ctx) returns ExtensionOperation[] whose bind(args)
synchronously returns plain data (no async, no fetch) — { kind: "http_mutation" |
"shell_command" | "file_write", goal, ...params } — and the daemon runs it through its engine
(confirmation, sandbox, verification, rollback).
Give every binding a verify (verifyUrl/verifyExpect, or a verify command) and a rollback where the
app makes one possible. Credentials never appear as values: in a header use secretHeader:
{ name, ref }; anywhere in a body or URL write the placeholder {{secret:<ref>}} (e.g.
{"Name":"admin","Password":"{{secret:extension.jellyfin.admin_password}}"}) — the daemon
substitutes the real value at request time and the plan shows only the placeholder. The same
placeholder works when you call http_mutation yourself during learning.

SCHEMAS: every tool's, diagnostic's and operation's "parameters" is a real JSON Schema built with
Type from "@miro/sdk" — e.g. parameters: Type.Object({ path: Type.String({ description: "..." }) })
— or Type.Object({}) for none. Never a plain object like { path: "string" }; validation rejects it.
In tests.ts, treat bind()'s result as loosely typed data (check bound.kind, bound.goal, and the
field that matters for that kind).

RECURSE WHEN YOU MUST. If operating this app requires another app you do not know (an indexer
manager, a download client), call app_learn for it, let it finish, then continue here.

WHEN YOU UNDERSTAND THE APP, call extension_write with:
- toolsTs / diagnosticsTs: TypeScript exporting buildTools(ctx) / buildDiagnostics(ctx) returning
  ExtensionTool[] (types from "@miro/sdk") — every element a plain { name, description,
  parameters, execute } object, never wrapped (not { tool: ... }). Read-only: ctx.http.get,
  ctx.exec (read-only shell, refused otherwise), ctx.readFile, ctx.secrets. Never import anything
  but "@miro/sdk".
- operationsTs: TypeScript exporting buildOperations(ctx) returning ExtensionOperation[] — the
  app's writes, as bindings. Empty string only if the app genuinely has nothing to configure.
- browserTs: only if browser-based diagnostics are genuinely needed; empty string otherwise.
- testsTs: "export default async function runTests()" using createFakeHttpClient /
  createFakeExec / createFakeReadFile from "@miro/sdk" with literal fixtures (no network), calling
  every tool and diagnostic, and calling every operation's bind() to check the returned kind, url
  or command, and goal. Returns [{name, passed, error?}].
Every name must match ^[a-zA-Z0-9_-]+$ (underscores, never dots). If extension_write reports
failures, fix the SPECIFIC problem named and call it again — attempts are limited.

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
    description: "Save a credential (API key/token) discovered or created for this app. Refer to it by the returned reference afterwards — never repeat the value anywhere.",
    parameters: Type.Object({ name: Type.String({ description: "Short name, e.g. 'api_key'." }), value: Type.String() }),
    execute: async (_id: string, args: { name: string; value: string }) => {
      const ref = `extension.${app}.${args.name}`;
      setSecret(ref, args.value);
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
  toolsTs: Type.String(),
  diagnosticsTs: Type.String(),
  operationsTs: Type.String({ description: "Write bindings — buildOperations(ctx). Empty string only if the app has nothing to configure." }),
  browserTs: Type.String({ description: "Empty string if this app doesn't need browser-based diagnostics." }),
  testsTs: Type.String(),
});

const MAX_WRITE_ATTEMPTS = 3;

function buildExtensionWriteTool(
  app: string,
  db: Database,
  hostMgr: ExtensionHostManager,
  getSecret: (ref: string) => string | null,
) {
  let attempts = 0;
  let promoted = false;

  const tool = {
    name: "extension_write",
    label: "Write extension",
    description:
      "Write and validate the local extension for this app. Call once you understand the app well enough. If it reports failures, fix the specific problem and call again — limited attempts.",
    parameters: extensionWriteParams,
    execute: async (_id: string, args: Static<typeof extensionWriteParams>) => {
      attempts++;
      if (attempts > MAX_WRITE_ATTEMPTS) {
        return textResult({ ok: false, failures: [`Too many attempts (${MAX_WRITE_ATTEMPTS}) — stop and report what's blocking this.`] });
      }

      const dir = stagingDir(app);
      discardStaging(app);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "tools.ts"), args.toolsTs);
      writeFileSync(join(dir, "diagnostics.ts"), args.diagnosticsTs);
      if (args.operationsTs.trim()) writeFileSync(join(dir, "operations.ts"), args.operationsTs);
      if (args.browserTs.trim()) writeFileSync(join(dir, "browser.ts"), args.browserTs);
      writeFileSync(join(dir, "tests.ts"), args.testsTs);
      ensureNodeModulesSymlink(dir, MIROD_NODE_MODULES);

      const secrets: Record<string, string> = {};
      for (const s of args.secretNames) {
        const value = getSecret(`extension.${app}.${s.name}`);
        if (value) secrets[s.name] = value;
      }

      const result = await validateExtension(dir, app, args.baseUrl, secrets, hostMgr);
      if (!result.ok) {
        // Logged, not just returned to the model: a failed learn otherwise leaves no trace of WHY
        // (found post-mortem on a run that burned all attempts).
        console.log(`[mirod] extension_write(${app}) attempt ${attempts} failed:\n  ${result.failures.join("\n  ")}`);
        return textResult({ ok: false, failures: result.failures, attemptsRemaining: MAX_WRITE_ATTEMPTS - attempts });
      }
      console.log(`[mirod] extension_write(${app}) attempt ${attempts} validated`);

      const existing = store.getExtension(db, app);
      const version = (existing?.version ?? 0) + 1;
      const manifest = buildManifest(app, args.displayName, args.baseUrl, args.secretNames, result.tools ?? [], version);
      writeFileSync(join(dir, "manifest"), JSON.stringify(manifest, null, 2));

      promoteStagingToLive(app);
      hostMgr.invalidate(extensionDir(app)); // the live session (if any) has the old code loaded
      store.promote(db, app, JSON.stringify(manifest), version, args.baseUrl);
      promoted = true;

      return textResult({
        ok: true,
        version,
        toolCount: manifest.tools.length,
        diagnosticCount: manifest.diagnostics.length,
        operationCount: manifest.operations?.length ?? 0,
      });
    },
  };

  return { tool, wasPromoted: () => promoted };
}

export interface LearnAgentOptions {
  goal: string;
  app: string;
  depth: number;
  db: Database;
  hostMgr: ExtensionHostManager;
  setSecret: (ref: string, value: string) => void;
  getSecret: (ref: string) => string | null;
  models: ReturnType<typeof builtinModels>;
  model: Model<any>;
  reasoning?: ThinkingLevel;
  getStoredKey: (provider: string) => string | null;
  send: (event: ServerEvent) => void;
  waitForAnswer?: (id: string) => Promise<string>;
  operationCtx?: OperationToolContext;
  /** Needed for recursion — a nested app_learn resolves its own codegen model the same way. */
  resolveCodegenModel: () => Promise<CodegenSelection | null>;
  /** This session's tool calls render nested under this activity node (the app_learn call). */
  parentActivityId?: string;
  maxTurns?: number;
}

const DEFAULT_MAX_TURNS = 40; // ponytail: a guess, tuned by live runs — research + codegen + operations need more than the old 24

export async function spawnLearningAgent(o: LearnAgentOptions): Promise<{ text: string; promoted: boolean }> {
  const { tool: writeTool, wasPromoted } = buildExtensionWriteTool(o.app, o.db, o.hostMgr, o.getSecret);

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
      waitForAnswer: o.waitForAnswer ?? (async () => "[no user available — decide yourself or stop]"),
      setSecret: o.setSecret,
    }).filter((t) => t.name === "ask_user" || t.name === "credential_create"),
    ...(o.operationCtx ? buildOperationTools(o.operationCtx) : []),
    buildSecretStoreTool(o.app, o.setSecret),
    buildCapabilityWriteTool(o.app, o.db),
    writeTool,
    recursiveLearn,
  ];

  let turns = 0;
  const maxTurns = o.maxTurns ?? DEFAULT_MAX_TURNS;
  const refs = listSecretRefs(o.db, "extension.");
  const systemPrompt = `${LEARN_SYSTEM_PROMPT}\n\nCredentials on file (references only — values are never shown): ${refs.length > 0 ? refs.join(", ") : "none yet"}.`;
  const agent = new Agent({
    // Heterogeneous per-tool parameter schemas can't unify into one array type without erasure —
    // same cast agent/index.ts's own createMiroAgent uses for the exact same reason.
    initialState: { systemPrompt, model: o.model, tools: tools as AgentTool<any>[] },
    streamFn: (m, context, options) => o.models.streamSimple(m, context, o.reasoning ? { ...options, reasoning: o.reasoning } : options),
    getApiKey: async (provider) => resolveApiKey(provider, o.getStoredKey),
    shouldStopAfterTurn: () => ++turns >= maxTurns,
  });

  try {
    const text = await runTurn(agent, o.goal, {
      parentActivityId: o.parentActivityId,
      onActivity: (node) => o.send({ type: "activity", ...node }),
    });
    return { text, promoted: wasPromoted() };
  } finally {
    o.hostMgr.closeBrowserSession(o.app);
  }
}
