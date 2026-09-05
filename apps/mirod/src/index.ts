import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync, existsSync, readFileSync, chownSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  MIRO_DIR,
  SOCKET_PATH,
  DB_PATH,
  encodeLine,
  createLineBuffer,
  utf8Bytes,
  type ClientMessage,
  type ServerEvent,
} from "@miro/protocol";
import type { Agent } from "@miro/agent-core";
import { Effort, type Model } from "@miro/model-client";
import { getBundledModel } from "@miro/model-catalog";
import { createMiroAgent, pickDefaultModel, runTurn, PROVIDER_CATALOG, ROUTING_POLICIES, type RoutingPolicy } from "./agent";
import { createModelRegistry } from "./agent/models";
import { registerOllamaIfReachable } from "./agent/ollama";
import { ensureTimelineTable, recordEvent } from "./timeline";
import { createSecretStore } from "./secrets";
import { generateIrohSecretKey, startIrohEndpoint, ticketFor, nodeIdOf, acceptLoop } from "./iroh";
import { ensureUsageTable } from "./capabilities/usage";
import { reconcileOperations, type OperationToolContext, type ReflectionTrigger } from "./operations/engine";
import { reverifyCommitted } from "./operations/prodtest";
import { configureCapabilities, refreshWebSearchPool } from "./capabilities";
import { allOperationKinds } from "./agent/operation-tools";
import { buildContextBlock, takeSnapshot } from "./agent/context";
import { runDiscovery } from "./discovery";
import { ensureMemoryTable, buildSummary, listAll, forget, formatForDisplay } from "./memory/store";
import { reflectOnOperation, reflectOnCorrection, isLikelyCorrection } from "./memory/dreaming";
import { ensureExtensionsTable, listEnabled } from "./extensions/store";
import { createExtensionHostManager } from "./extensions/host";
import { ensureNodeModulesSymlink, extensionDir, MIROD_NODE_MODULES } from "./extensions/paths";
import type { CodegenSelection } from "./extensions/learn";
import { maybeTriggerRepair, reprobeExtensions, type RepairTrigger } from "./extensions/repair";
import { requiresArguments } from "./extensions/validate";
import { createCodexAuth, importCodexCredentialFromCli, loginCodex } from "./agent/codex-auth";
import { run } from "./inventory/exec";

const OPERATION_KINDS = allOperationKinds((ref) => secretStore.getSecret(db, ref), (ref, value) => secretStore.setSecret(db, ref, value));

mkdirSync(MIRO_DIR, { recursive: true });
// H2: the secret material lives in the DB and the key file, both locked to the owner below (and
// secrets.ts already writes secret.key 0600). MIRO_DIR itself is NOT tightened - the extension host
// drops to the `miro` user and must traverse MIRO_DIR/extensions to load generated code, so a
// blanket chmod here would break it (found live: "Cannot find module tools.ts" when the host, as
// miro, could not enter a root-owned 0700 dir).
try {
  unlinkSync(SOCKET_PATH);
} catch {
  // no stale socket to remove
}

const db = new Database(DB_PATH);
try {
  chmodSync(DB_PATH, 0o600);
} catch {
  // ignore
}
db.exec("PRAGMA journal_mode = WAL"); // required for durable operation phases (plan §47)
db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
ensureTimelineTable(db);
ensureMemoryTable(db);
ensureExtensionsTable(db);
ensureUsageTable(db);
recordEvent(db, "mirod", "started");

// Defensive re-ensure for already-promoted extensions - cheap and idempotent (see paths.ts),
// guards against the node_modules symlink having gone missing some other way.
for (const ext of listEnabled(db)) {
  ensureNodeModulesSymlink(extensionDir(ext.app), MIROD_NODE_MODULES);
}

const secretStore = createSecretStore(join(MIRO_DIR, "secret.key"));
secretStore.ensureTable(db);
const getStoredKey = (provider: string) => secretStore.getSecret(db, `provider.${provider}`);

function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

function setSetting(key: string, value: string) {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

function personality(): "casual" | "professional" {
  const stored = getSetting("personality");
  return stored === "professional" ? "professional" : "casual";
}

function routingPolicy(): RoutingPolicy {
  const stored = getSetting("routing_policy");
  return (ROUTING_POLICIES as readonly string[]).includes(stored ?? "") ? (stored as RoutingPolicy) : "cheapest";
}

/** Generated code becomes a standing capability, so this defaults higher than the general chat
 * routing_policy (plan §37/self-extension grilling - confirmed user-configurable, default best). */
function storedCodegenPolicy(): RoutingPolicy | null {
  const stored = getSetting("codegen_policy");
  return (ROUTING_POLICIES as readonly string[]).includes(stored ?? "") ? (stored as RoutingPolicy) : null;
}

const codexAuth = createCodexAuth(db, secretStore);
const models = createModelRegistry(getStoredKey, codexAuth.apiKey);

// One-time import of a credential logged in via pi-ai's own CLI (`login openai-codex`), so the
// daemon doesn't need its own interactive OAuth login UX yet. Idempotent - re-importing a fresh
// login just overwrites the stored credential. Only runs if the well-known drop file exists.
{
  const codexAuthDropFile = join(MIRO_DIR, "codex-auth-import.json");
  if (existsSync(codexAuthDropFile)) {
    // A hand-dropped file arrives half-written sometimes; an unguarded parse here was a boot loop
    // (the file survives the crash, so every restart died the same way - audit B2). Left in place
    // so the owner can fix it; logged on every boot until they do.
    try {
      const parsed = JSON.parse(readFileSync(codexAuthDropFile, "utf8"));
      if (importCodexCredentialFromCli(db, secretStore, parsed)) {
        unlinkSync(codexAuthDropFile);
        console.log("[mirod] imported OpenAI Codex OAuth credential");
      } else {
        console.warn(`[mirod] ${codexAuthDropFile} has no usable openai-codex credential - ignored`);
      }
    } catch (err) {
      console.error(`[mirod] ignoring unreadable ${codexAuthDropFile}:`, err instanceof Error ? err.message : err);
    }
  }
}
if (await registerOllamaIfReachable(models)) {
  console.log("[mirod] Ollama detected - its models are available with no key needed");
}

/** Ollama is registered at boot only if it answered then. When nothing at all is connected, one
 * more 1.5s probe before giving up makes an Ollama started after the daemon usable without a
 * restart (audit R3) - and costs nothing on the connected path. */
async function pickModelOrProbeOllama(policy: RoutingPolicy): Promise<Model<any> | null> {
  const picked = pickDefaultModel(models, getStoredKey, policy);
  if (picked) return picked;
  return (await registerOllamaIfReachable(models)) ? pickDefaultModel(models, getStoredKey, policy) : null;
}

// The capability layer (PLAN.md §5.14): web.search routed over an Ollama cloud key, a self-hosted
// SearXNG and the public JSON-capable pool, with per-provider usage/health in the DB.
configureCapabilities({ db, getStoredKey, getSetting, setSetting });

const hostMgr = createExtensionHostManager();
setInterval(() => hostMgr.reapIdle(), 60_000);

// Resume any operation interrupted by a crash/power loss before accepting connections (plan §47).
// A reboot's post-boot verdict (the kind's reconcile hook, PLAN.md §5.30) goes to the first client
// after boot. ponytail: last report wins - only one daemon-ending operation can be in flight.
for (const report of await reconcileOperations(db, OPERATION_KINDS)) {
  setSetting("boot_report", JSON.stringify({ level: report.outcome === "committed" ? "info" : "warn", text: report.message }));
}

// Budgeted Dreaming reflection pass (plan §36-37) - fire-and-forget, never spends the user's
// "best" routing budget, never blocks the operation/chat turn that triggered it.
function reflect(trigger: ReflectionTrigger): void {
  resolveReflectionModel()
    .then((model) => (model ? reflectOnOperation(db, models, model, trigger) : undefined))
    .catch((err) => console.error("[mirod] reflection failed", err));
}

/** A hash of every enabled extension's (app, version) - compared every turn (same mechanism as
 * lastMemorySummary) to rebuild the agent when an extension is freshly learned/repaired, so its
 * tools become usable on the very next turn with no restart. */
function extensionVersionHash(): string {
  return listEnabled(db)
    .map((e) => `${e.app}@${e.version}`)
    .sort()
    .join(",");
}

interface ConnState {
  feed: (chunk: Buffer) => void;
  agent?: Agent;
  pendingProvider?: string;
  // Lets an operation tool's execute() genuinely block on a human answer (e.g. approve/cancel a
  // dangerous operation) instead of the fixed UI-flow answers below being the only kind that
  // resolve anything - without this, "dangerous requires the user" would just be advisory text.
  pendingAnswers: Map<string, (value: string) => void>;
  turnActive?: boolean; // a chat turn is running; a second concurrent chat would race this state (audit U2)
  lastReply?: string; // for the user-correction heuristic (plan §37)
  lastChatModelId?: string; // what this connection's status line last named (audit R7: was a module global shared by every connection)
  lastMemorySummary?: string; // forces an agent rebuild when Memory changes mid-connection
  lastExtensionVersion?: string; // forces an agent rebuild when an extension is learned/repaired
  lastContextBlock?: string; // forces an agent rebuild when the server snapshot changes
}

function waitForAnswer(state: ConnState, id: string): Promise<string> {
  return new Promise((resolve) => state.pendingAnswers.set(id, resolve));
}

/** A resolver value that is neither "approve" nor "keep", so every confirmation/lifeline gate
 * treats it as a cancel. */
const CONNECTION_CLOSED = "\u0000connection-closed"; // leading NUL: no typed answer can equal it; escaped so the file stays text for git

/** On a dropped connection, settle every outstanding question. Without this the resolver closures
 * (and the whole suspended chain - the agent turn and any operation stuck "awaiting confirmation"
 * in the DB) leak forever; only lifeline confirms had a timeout (audit D2). */
function cancelPending(state: ConnState): void {
  for (const resolve of state.pendingAnswers.values()) resolve(CONNECTION_CLOSED);
  state.pendingAnswers.clear();
}

/** Confirmed preference: whenever an OpenAI Codex login is connected, codegen ALWAYS uses it -
 * gpt-5.6-luna at medium reasoning effort - regardless of the general codegen_policy tier setting
 * (that setting only matters as a fallback when Codex isn't connected). Shared by the interactive
 * resolver below and the autonomous one Dreaming's repair pass uses. */
async function resolveCodegenSelection(policy: RoutingPolicy): Promise<CodegenSelection | null> {
  if (codexAuth.isConnected()) {
    return { model: getBundledModel("openai-codex", "gpt-5.6-luna"), reasoning: Effort.Medium };
  }
  const model = await pickModelOrProbeOllama(policy);
  return model ? { model } : null;
}

/** Lazy fallback for installs that never got the onboarding-chained codegen_policy question
 * (already-onboarded before this feature existed, or skipped straight to /learn) - asks once,
 * via the same generic pendingAnswers round-trip an operation confirmation uses, and saves the
 * answer so it's never asked again. */
async function resolveCodegenModel(state: ConnState, send: (event: ServerEvent) => void): Promise<CodegenSelection | null> {
  if (codexAuth.isConnected()) return resolveCodegenSelection("best"); // policy arg unused on the Codex path
  let policy = storedCodegenPolicy();
  if (!policy) {
    send({
      type: "question",
      id: "codegen_policy",
      prompt:
        "When Miro writes new code for an app it doesn't know yet, which model tier should it use? (Generated code becomes a standing capability, so higher quality is usually worth it.)",
      options: [
        { label: "Cheapest capable", value: "cheapest" },
        { label: "Balanced", value: "balanced" },
        { label: "Best available - Recommended", value: "best" },
      ],
    });
    const answer = await waitForAnswer(state, "codegen_policy");
    policy = (ROUTING_POLICIES as readonly string[]).includes(answer) ? (answer as RoutingPolicy) : "best";
    setSetting("codegen_policy", policy);
  }
  return resolveCodegenSelection(policy);
}

/** Autonomous path (Dreaming's repair pass, plan §36) - never interactively asks, matching
 * reflect()'s own "cheapest, no interaction" precedent for background passes. Falls back to
 * whatever codegen_policy is already stored (or "best" if never set) when Codex isn't connected. */
async function resolveCodegenModelAutonomous(): Promise<CodegenSelection | null> {
  return resolveCodegenSelection(storedCodegenPolicy() ?? "best");
}

/** Budgeted Dreaming repair pass (plan §36, §8 of PLAN.md's self-extension design) -
 * fire-and-forget, mirrors reflect()'s shape exactly. Triggered on a real extension tool-call
 * failure (agent/extension-tools.ts) or a periodic re-probe (reprobeExtensionsPeriodically below). */
/** Awaited by a failing extension call (agent/extension-tools.ts) so a successful repair can be
 * retried inline; resolves false on any error so a broken repair never breaks the caller twice. */
function repair(trigger: RepairTrigger): Promise<boolean> {
  return maybeTriggerRepair(
    trigger,
    db,
    hostMgr,
    (ref, value) => secretStore.setSecret(db, ref, value),
    (ref) => secretStore.getSecret(db, ref),
    models,
    resolveCodegenModelAutonomous,
    getStoredKey,
    // No client connection to notify from a background trigger - log instead, matching reflect()'s
    // own "invisible to the user, observable only via its effects" precedent.
    (event) => console.log(`[mirod] repair(${trigger.app})`, event.type),
  ).catch((err) => {
    console.error("[mirod] repair failed", err);
    return false;
  });
}

const REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1000; // plan §36's "useful idle period" trigger
function reprobeExtensionsPeriodically(): void {
  reprobeExtensions(
    db,
    hostMgr,
    (ref, value) => secretStore.setSecret(db, ref, value),
    (ref) => secretStore.getSecret(db, ref),
    models,
    resolveCodegenModelAutonomous,
    getStoredKey,
    (event) => console.log("[mirod] reprobe", event.type),
    requiresArguments,
  ).catch((err) => console.error("[mirod] extension re-probe failed", err));
}
setInterval(reprobeExtensionsPeriodically, REPROBE_INTERVAL_MS);

// Prodtest per repair (PLAN.md §5.15 A, operations/prodtest.ts): on the same idle period, re-run the
// verify of the latest committed operation per target. Drift becomes a reinforced incident the
// agent sees in its context - surfaced, never re-applied on its own.
function reverifyPeriodically(): void {
  reverifyCommitted(db, OPERATION_KINDS)
    .then((r) => {
      if (r.drifted.length > 0) console.log(`[mirod] prodtest: ${r.drifted.length} of ${r.checked} committed operation(s) no longer verify: ${r.drifted.map((d) => d.goal).join("; ")}`);
      else if (r.checked > 0) console.log(`[mirod] prodtest: ${r.checked} committed operation(s) still verify`);
    })
    .catch((err) => console.error("[mirod] prodtest failed", err));
}
setInterval(reverifyPeriodically, REPROBE_INTERVAL_MS);

// The public SearXNG pool decays (nodes come and go, most block JSON) - re-probed on the same idle
// period, and once at boot so the bundled seed is replaced by what actually answers today.
function refreshSearchPool(): void {
  refreshWebSearchPool()
    .then((pool) => pool && console.log(`[mirod] web_search public pool: ${pool.nodes.length} JSON-capable node(s)${pool.nodes.length ? ` (${pool.nodes.map((n) => new URL(n.url).host).join(", ")})` : ""}`))
    .catch((err) => console.error("[mirod] web_search pool refresh failed", err));
}
setInterval(refreshSearchPool, REPROBE_INTERVAL_MS);
refreshSearchPool();

// Discover what's on this box and persist it as durable server_facts (PLAN.md §5.13). Fire-and-
// forget so a slow or absent Docker never delays boot; refreshed on the same long period as the
// re-probe so present facts stay reinforced. buildSummary then surfaces them into every chat turn.
function discover(): void {
  runDiscovery(db)
    .then((r) => r.facts && console.log(`[mirod] discovery: ${r.facts} server fact(s) refreshed`))
    .catch((err) => console.error("[mirod] discovery failed", err));
}
discover();
setInterval(discover, REPROBE_INTERVAL_MS);

/** The main chat agent's model. Same standing preference as codegen: a connected Codex login means
 * gpt-5.6-luna at medium reasoning, always - it was added precisely because Ollama's cloud quota
 * was too volatile to rely on, so it is never left as codegen-only while chat has nothing. With no
 * Codex login, the cost-tier routing_policy over the other connected providers applies as before. */
async function resolveChatSelection(): Promise<CodegenSelection | null> {
  if (codexAuth.isConnected()) {
    return { model: getBundledModel("openai-codex", "gpt-5.6-luna"), reasoning: Effort.Medium };
  }
  const model = await pickModelOrProbeOllama(routingPolicy());
  return model ? { model } : null;
}

/** Reflection budget: the cheapest connected model, or Codex when it is the only thing connected. */
async function resolveReflectionModel(): Promise<Model<any> | null> {
  return pickDefaultModel(models, getStoredKey, "cheapest") ?? (await resolveChatSelection())?.model ?? null;
}

/** "degraded" is the one health signal the daemon can honestly produce today: no AI provider is
 * connected, so it can only do the fixed things. The client already renders it (audit #26). */
function hasProvider(): boolean {
  return codexAuth.isConnected() || pickDefaultModel(models, getStoredKey, routingPolicy()) !== null;
}

function statusEvent(state: ConnState): ServerEvent {
  return {
    type: "status",
    server: "home",
    health: hasProvider() ? "healthy" : "degraded",
    model: state.lastChatModelId,
    privilege: typeof process.getuid === "function" && process.getuid() === 0 ? "root" : "user",
  };
}

async function handleChat(text: string, send: (event: ServerEvent) => void, state: ConnState): Promise<void> {
  const chat = await resolveChatSelection();
  if (chat && chat.model.id !== state.lastChatModelId) {
    state.lastChatModelId = chat.model.id;
    send(statusEvent(state));
  }
  if (!chat) {
    send({
      type: "reply",
      text: "I don't have an AI provider connected yet, so I can't reason about anything - I can only do the fixed stuff. Type /provider to connect one.",
    });
    return;
  }
  const defaultModel = chat.model;
  // A correction on Miro's *previous* reply triggers a real reflection pass before this turn runs,
  // using the reply that's now being corrected (plan §37) - never awaited, doesn't add latency.
  if (state.lastReply && isLikelyCorrection(text)) {
    const reflectionModel = await resolveReflectionModel();
    if (reflectionModel) {
      reflectOnCorrection(db, models, reflectionModel, state.lastReply, text).catch((err) =>
        console.error("[mirod] reflection failed", err),
      );
    }
  }
  // Rebuild if the connected provider's model changed, OR if Memory has changed since the agent
  // was built (e.g. a fact was just remembered), OR if an extension was learned/repaired since -
  // otherwise a long-lived connection's system prompt/tool list would go stale, undercutting
  // "gets visibly better as you use it" (plan §37).
  const memorySummary = buildSummary(db);
  const extensionVersions = extensionVersionHash();
  // The assembled context (server snapshot, operated systems, refusals) is part of the prompt;
  // a changed snapshot rebuilds the agent the same way changed memory does.
  const contextBlock = buildContextBlock(db, await takeSnapshot());
  if (
    !state.agent ||
    state.agent.state.model.id !== defaultModel.id ||
    state.lastMemorySummary !== memorySummary ||
    state.lastExtensionVersion !== extensionVersions ||
    state.lastContextBlock !== contextBlock
  ) {
    const operationCtx: OperationToolContext = { db, send, waitForAnswer: (id) => waitForAnswer(state, id), cancelAnswer: (id) => state.pendingAnswers.delete(id), reflect, getSecret: (ref) => secretStore.getSecret(db, ref), setSecret: (ref, value) => secretStore.setSecret(db, ref, value), setSetting };
    state.agent = createMiroAgent(models, defaultModel, getStoredKey, personality(), operationCtx, {
      hostMgr,
      setSecret: (ref, value) => secretStore.setSecret(db, ref, value),
      getSecret: (ref) => secretStore.getSecret(db, ref),
      resolveCodegenModel: () => resolveCodegenModel(state, send),
      waitForAnswer: (id) => waitForAnswer(state, id),
      operationCtx,
      repair,
    }, chat.reasoning, contextBlock);
    state.lastMemorySummary = memorySummary;
    state.lastExtensionVersion = extensionVersions;
    state.lastContextBlock = contextBlock;
  }
  recordEvent(db, "chat", text);
  const reply = await runTurn(state.agent, text, {
    onActivity: (node) => send({ type: "activity", ...node }),
    onDelta: (delta) => send({ type: "reply_delta", text: delta }),
  });
  recordEvent(db, "chat", reply);
  // runTurn surfaces provider errors as text now, so an empty reply here means the model genuinely
  // ended the turn with no final text (e.g. tool calls only) - say so rather than pretending.
  state.lastReply = reply;
  send({ type: "reply", text: reply || "(no response)" });
}

/** The one provider connected by a login rather than a pasted key - offered alongside the key
 * providers, deliberately not part of PROVIDER_CATALOG (whose entries mean "a stored/env key
 * connects it"; Codex is connected when its OAuth credential is on file). */
const CODEX_PROVIDER = "openai-codex";
/** The Ollama cloud account key (paste-a-key; there is no OAuth to mint one) - stored as
 * provider.ollama, read by the web.search implementation. Not a chat provider either. */
const OLLAMA_SEARCH_PROVIDER = "ollama";

function startProviderSetup(send: (event: ServerEvent) => void): void {
  send({
    type: "question",
    id: "provider_choice",
    prompt: "Which AI provider do you want to connect?",
    options: [
      ...PROVIDER_CATALOG.map((p) => ({ label: p.label, value: p.provider })),
      { label: "OpenAI Codex (ChatGPT login, no API key)", value: CODEX_PROVIDER },
      // Not a chat provider: the pasted key from ollama.com/settings/keys that web_search uses first.
      { label: "Ollama cloud (web search key)", value: OLLAMA_SEARCH_PROVIDER },
      // A way out: the client renders a choice as a modal, and escape only maps to a cancel option
      // that exists (audit #5) - without this, a stray /provider trapped the owner in the chooser.
      { label: "Cancel", value: "cancel" },
    ],
  });
}

/** Shared by both the local unix-socket transport and the remote Iroh transport (plan §54 Stage A) -
 * whichever transport a connection arrives on, it gets the exact same personality/provider/chat routing. */
function createConnectionState(send: (event: ServerEvent) => void): ConnState {
  const state: ConnState = { feed: () => {}, pendingAnswers: new Map() };
  state.feed = createLineBuffer((line) => {
    // One malformed line is dropped with a warning, never thrown: a throw out of the unix socket's
    // data handler reached the error callback, which cancels every pending confirmation on the
    // connection (audit B5); on the Iroh path it ended the session. The client guards its side the
    // same way.
    let msg: ClientMessage;
    try {
      msg = JSON.parse(line) as ClientMessage;
    } catch {
      send({ type: "notice", level: "warn", text: "malformed message ignored" });
      return;
    }

    if (msg.type === "answer" && state.pendingAnswers.has(msg.id)) {
      const resolve = state.pendingAnswers.get(msg.id)!;
      state.pendingAnswers.delete(msg.id);
      resolve(msg.value);
    } else if (msg.type === "answer" && msg.id === "personality") {
      setSetting("personality", msg.value);
      send(statusEvent(state));
    } else if (msg.type === "answer" && msg.id === "provider_choice" && msg.value === "cancel") {
      send({ type: "reply", text: "Nothing changed." });
    } else if (msg.type === "answer" && msg.id === "provider_choice" && msg.value === CODEX_PROVIDER) {
      // Device-code login (PLAN.md §5.22): the flow polls for the owner's browser authorization for
      // minutes, so it runs detached - the connection stays usable, and the outcome arrives as a
      // notice. The credential lands where the resolver reads it, so the next turn uses it.
      send({ type: "reply", text: "Starting the OpenAI Codex login - watch for the URL and code." });
      // The connection may be gone by the time the flow reports (it polls for minutes) - a notice
      // that cannot be delivered is logged, never thrown into the detached flow.
      const notify = (text: string) => {
        console.log(`[mirod] codex login: ${text}`);
        try {
          send({ type: "notice", level: "info", text });
        } catch {
          // connection closed
        }
      };
      void loginCodex(db, secretStore, notify).then((ok) => {
        if (ok) {
          recordEvent(db, "provider", `connected ${CODEX_PROVIDER}`);
          send(statusEvent(state));
        }
      });
    } else if (msg.type === "answer" && msg.id === "provider_choice") {
      state.pendingProvider = msg.value;
      const entry = PROVIDER_CATALOG.find((p) => p.provider === msg.value);
      send({
        type: "secret_prompt",
        id: "provider_api_key",
        prompt: `Paste your ${entry?.label ?? msg.value} API key:`,
      });
    } else if (msg.type === "answer" && msg.id === "provider_api_key") {
      const provider = state.pendingProvider;
      state.pendingProvider = undefined;
      if (provider === OLLAMA_SEARCH_PROVIDER && msg.value.trim()) {
        secretStore.setSecret(db, `provider.${provider}`, msg.value.trim());
        recordEvent(db, "provider", `connected ${provider} (web search)`);
        send({ type: "reply", text: "Ollama cloud search connected - web_search uses it first from now on." });
      } else if (provider && msg.value.trim()) {
        secretStore.setSecret(db, `provider.${provider}`, msg.value.trim());
        recordEvent(db, "provider", `connected ${provider}`);
        send({
          type: "question",
          id: "routing_policy",
          prompt: `Connected. Which routing policy should Miro use?`,
          options: [
            { label: "Cheapest capable - Recommended", value: "cheapest" },
            { label: "Balanced", value: "balanced" },
            { label: "Best available", value: "best" },
          ],
        });
      } else {
        send({ type: "reply", text: "Didn't get a key - nothing was saved." });
      }
    } else if (msg.type === "answer" && msg.id === "routing_policy") {
      setSetting("routing_policy", msg.value);
      send({
        type: "question",
        id: "codegen_policy",
        prompt: "When Miro writes new code for an app it doesn't know yet, which model tier should it use? (Generated code becomes a standing capability, so higher quality is usually worth it.)",
        options: [
          { label: "Cheapest capable", value: "cheapest" },
          { label: "Balanced", value: "balanced" },
          { label: "Best available - Recommended", value: "best" },
        ],
      });
    } else if (msg.type === "answer" && msg.id === "codegen_policy") {
      setSetting("codegen_policy", msg.value);
      send({ type: "reply", text: `Routing set. Try asking me something, or point me at an app you'd like me to learn.` });
    } else if (msg.type === "provider_setup") {
      startProviderSetup(send);
    } else if (msg.type === "pair_request") {
      send({
        type: "reply",
        text: `Pairing ticket (anyone with this string gets full daemon access):\n${irohTicket}\n\nOn the remote machine:\n  MIRO_TICKET=${irohTicket} miro`,
      });
    } else if (msg.type === "memory_list") {
      send({ type: "reply", text: formatForDisplay(listAll(db, 50)) });
    } else if (msg.type === "memory_forget") {
      const changed = forget(db, msg.id);
      send({ type: "reply", text: changed > 0 ? "Forgotten." : "Nothing matched that id." });
    } else if (msg.type === "chat") {
      // Serialize turns per connection: handleChat is fire-and-forget, so two back-to-back chats
      // would run overlapping turns racing on this mutable ConnState (state.agent, pendingAnswers,
      // lastReply). Reject the second rather than corrupt the first (audit U2).
      if (state.turnActive) {
        send({ type: "notice", level: "warn", text: "Still working on your previous request - one at a time." });
      } else {
        state.turnActive = true;
        handleChat(msg.text, send, state)
          .catch((err) => {
            console.error("[mirod] chat error", err);
            send({ type: "reply", text: "Something went wrong on my end handling that - check mirod's logs." });
          })
          .finally(() => {
            state.turnActive = false;
          });
      }
    }
  });

  if (!getSetting("personality")) {
    send({
      type: "question",
      id: "personality",
      prompt: "How should Miro talk?",
      options: [
        { label: "Casual - Recommended", value: "casual" },
        { label: "Professional", value: "professional" },
      ],
    });
  } else {
    send(statusEvent(state));
  }
  // One-shot boot report (a reboot's post-boot verdict): this connection is the reachability
  // proof a reboot has no timed handshake for, so it is cleared on delivery.
  const bootReport = getSetting("boot_report");
  if (bootReport) {
    send({ type: "notice", ...(JSON.parse(bootReport) as { level: "info" | "warn"; text: string }) });
    setSetting("boot_report", "");
  }

  return state;
}

mkdirSync(dirname(SOCKET_PATH), { recursive: true });
Bun.listen<ConnState>({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      socket.data = createConnectionState((event) => socket.write(encodeLine(event)));
    },
    data(socket, chunk) {
      socket.data.feed(chunk);
    },
    close(socket) {
      if (socket.data) cancelPending(socket.data);
    },
    error(socket, err) {
      console.error("[mirod] socket error", err);
      if (socket.data) cancelPending(socket.data);
    },
  },
});

// System-service layout (PLAN.md §5.5): a root daemon's socket is group-accessible so the owner's
// own TUI can connect. MIRO_GROUP names that group (default "miro", created by the installer).
if (typeof process.getuid === "function" && process.getuid() === 0) {
  const group = process.env.MIRO_GROUP ?? "miro";
  // A missing getent binary throws out of spawnSync (Bun 1.4: "Executable not found in $PATH") and
  // an NSS backend over the network can block; neither may take the daemon down after it has
  // already bound the socket (audit B1). Degrade to root-only, as the not-found branch does.
  try {
    const gid = Number(Bun.spawnSync(["getent", "group", group], { timeout: 5_000 }).stdout.toString().split(":")[2]);
    if (Number.isFinite(gid)) {
      chownSync(dirname(SOCKET_PATH), 0, gid);
      chmodSync(dirname(SOCKET_PATH), 0o750);
      chownSync(SOCKET_PATH, 0, gid);
      chmodSync(SOCKET_PATH, 0o660);
    } else {
      console.warn(`[mirod] group ${group} not found - socket stays root-only`);
    }
  } catch (err) {
    console.warn(`[mirod] could not resolve group ${group} (${err instanceof Error ? err.message : err}) - socket stays root-only`);
  }
}

console.log(`mirod listening on ${SOCKET_PATH}`);

// Under systemd (Type=notify, apps/mirod/mirod.service): READY once the socket is bound and
// group-accessible - the owner can connect - and WATCHDOG=1 at half the unit's WatchdogSec so a
// wedged event loop is restarted. Deliberately before Iroh: a relay that hangs at boot must not
// hold READY past TimeoutStartSec and restart-loop a daemon whose local socket works. A nohup/dev
// run has no NOTIFY_SOCKET and skips this. ponytail: the systemd-notify binary carries both
// messages (Bun has no AF_UNIX datagram client); a raw datagram when it grows one.
if (process.env.NOTIFY_SOCKET) {
  run("systemd-notify", ["--ready"]).catch((err) => console.warn("[mirod] systemd-notify --ready failed", err));
  const watchdogUsec = Number(process.env.WATCHDOG_USEC);
  if (watchdogUsec > 0) setInterval(() => run("systemd-notify", ["WATCHDOG=1"]).catch(() => {}), watchdogUsec / 2000);
}

// Iroh transport (plan §54 Stage A) - reachable from anywhere without port-forwarding. Runs
// alongside the unix socket, not instead of it; local CLI use keeps working exactly as before.
// The secret key must be stable across restarts, or every restart mints a new NodeId and every
// ticket already shared with a remote machine goes stale.
function loadOrCreateIrohSecretKey(): number[] {
  const stored = secretStore.getSecret(db, "transport.iroh_secret_key");
  if (stored) return JSON.parse(stored);
  const key = generateIrohSecretKey();
  secretStore.setSecret(db, "transport.iroh_secret_key", JSON.stringify(key));
  return key;
}

const irohEndpoint = await startIrohEndpoint(loadOrCreateIrohSecretKey());
const irohTicket = ticketFor(irohEndpoint);
// The NodeId only: the ticket grants full daemon access and stdout is a durable, shipped log file
// in production (audit S3). /pair hands the ticket to the owner on request.
console.log(`mirod also reachable via Iroh - node ${nodeIdOf(irohEndpoint)}; /pair shows the pairing ticket`);

acceptLoop(irohEndpoint, (conn) => {
  (async () => {
    const bi = await conn.acceptBi();
    const state = createConnectionState((event) => {
      bi.send.writeAll(utf8Bytes(encodeLine(event))).catch((err) => {
        console.error("[mirod] iroh send failed", err);
      });
    });
    try {
      for (;;) {
        const chunk = await bi.recv.read(65536);
        if (!chunk || chunk.length === 0) break;
        state.feed(Buffer.from(chunk));
      }
    } finally {
      cancelPending(state); // same leak fix as the unix socket close (audit D2)
    }
  })().catch((err) => console.error("[mirod] iroh session error", err));
}).catch((err) => console.error("[mirod] iroh accept loop stopped", err));
