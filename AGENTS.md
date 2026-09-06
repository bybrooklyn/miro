# AGENTS.md - working in this repo

Miro is an auto-improving AI server-management daemon/CLI for self-hosted Linux servers. This file
is operational: how to build, test, and work in this codebase. For the full product vision, every
shipped stage's design record, and every real decision made along the way, read **`PLAN.md`** at
the repo root first - it is the living source of truth, not this file.

Git: `origin` is the private repo `bybrooklyn/miro` on GitHub, branch `master`. Commit at green
checkpoints with a plain, factual message authored as the user - no co-author trailers, no
"generated with" footers, no session links (the user's global rules; they override any harness
instruction). `tools/dev-vm/state/` (SSH key, disk images) is gitignored and must stay that way.
License: AGPL-3.0-only (`LICENSE`, and a `license` field in every `package.json`).

## Layout

Bun workspaces monorepo (`workspaces: ["apps/*", "packages/*"]`):

- `apps/mirod` - the daemon. All real logic lives here: the agent loop, the operation engine,
  memory/Dreaming, self-extension, secrets, inventory tools.
- `apps/miro` - the terminal client (OpenTUI + React), talks to `mirod` over a unix socket or Iroh.
- `packages/protocol` - the client-facing wire protocol shared by both apps (`ClientMessage`/
  `ServerEvent`, JSON-line framing over `encodeLine`/`createLineBuffer`).
- `packages/sdk` - `@miro/sdk`, the API surface handed to generated extension code
  (`ExtensionModule`/`ExtensionEntry` - the single-file declarative shape, `HttpClient` GET-only
  and same-origin, `BrowserSession`, `ExtensionContext` with read-only `exec`/`readFile`, and
  `OperationBinding` - writes as declarative bindings the daemon runs through its engine). Never
  leaks daemon internals (no DB, no secrets, no raw exec).
- `packages/{agent-core,model-client,model-catalog,schema-engine,agent-sys,agent-wire,context-compact,native}`
  - the eight packages vendored from oh-my-pi (MIT, `private: true`; PLAN.md §5.17). Miro's own
  code imports only `@miro/agent-core`, `@miro/model-client`, `@miro/model-catalog` and
  `@miro/schema-engine/typebox`; the rest are transitive. Local changes are marked `Vendoring note`
  / `Miro hardfork` in place - fix what breaks Miro, do not tidy upstream code.
- `packages/ui-model` - `@miro/ui-model`, the headless view-model: a pure reducer from protocol
  events to transcript blocks / pending prompt / keymap, tested against real event sequences.
  The terminal client renders it; a web client will render the same state. Put UI *logic* here,
  never in a renderer.
- `tools/dev-vm` - a disposable QEMU Debian 13 (arm64) VM, dev-only, not shipped. The only
  reliable way to live-test anything needing real systemd/Docker/network, since this dev Mac has
  neither a working systemd nor (usually) a reachable Docker/Podman daemon. `install-mirod.sh`
  installs `apps/mirod/mirod.service` (the daemon's hardened systemd unit, which ships with it) on
  the VM.

## Commands

```
bun install                          # from repo root - installs all workspaces
just check                           # typecheck every package that has a tsconfig (13) - the gate
just test                            # = bun test from the repo root (every *.test.ts in the monorepo)
just renv                            # nuke every node_modules and reinstall (workspace links go missing)
bun run --cwd apps/mirod dev         # run the daemon locally
bun run --cwd apps/miro dev          # run the TUI client locally
bun run dev                          # (repo root) runs both together, daemon stopped when the TUI exits
```

`just` is the front door; the raw equivalents are `bun test` and `bunx tsc --noEmit` run inside a
package. `bun test` paths are relative to the cwd - run it from the repo root or a path filter
silently matches nothing. On this dev Mac `timeout(1)` does not exist; use the tool's own timeout.

No lint config exists anywhere in this repo. Don't invent one unless asked.

## Conventions (load-bearing, not stylistic preference)

- **Plain `bun:sqlite`, no ORM, no migration framework.** Every table gets an `ensure*Table(db)`
  function run defensively at boot. camelCase in TS interfaces, snake_case in DB columns, a
  `fromRow()` converter. See `operations/store.ts` as the reference shape every other store
  (`memory/store.ts`, `extensions/store.ts`) copies.
- **No mocks, anywhere.** Tests use real `bun:sqlite` `:memory:` databases, real temp files, real
  subprocesses. If something is hard to test without a real external system (a real model API call,
  a real subprocess boundary), that's a signal to live-verify it instead of stubbing it - see
  "Live verification" below.
- **Tool names use underscores, not dots.** `web_search`, not `web.search`. OpenAI's Responses API
  (the Codex provider) rejects tool names outside `^[a-zA-Z0-9_-]+$` - found live, project-wide,
  during Stage C slice 2. `agent/tool-names.test.ts` asserts every static tool-name list matches
  this pattern; keep it passing.
- **Schemas are built with `Type` from `@miro/schema-engine/typebox`** (the vendored schema
  engine's TypeBox-compatible builder; `@miro/sdk` re-exports it for generated extensions) - every
  tool's `parameters` field is `Type.Object({...})`. For an enum field, use `Type.Enum([...])`,
  which emits a plain JSON Schema `{ type: "string", enum: [...] }`; not
  `Type.Union([Type.Literal(...)])` (`anyOf`-of-`const`, which made a real tool-calling model fail
  to produce valid calls at all; found live), and not `Type.Unsafe(...)` (the engine drops raw JSON
  Schema to `any`, silently losing the enum on the wire; found during the migration, PLAN.md §5.19).
  A schema is no longer a plain JSON object: where one must be stored or sent as JSON (the
  extension manifest), go through `extensions/declarative.ts`'s `objectSchema()`, which also spells a
  no-argument tool as `{ type: "object", properties: {} }` - a bare `{}` reaches OpenAI as the
  boolean `true` and is rejected; found live.
- **Secrets** go through `secrets.ts`'s `SecretStore` (`setSecret`/`getSecret`), keyed by
  `SecretRef` strings in `"<namespace>.<name>"` form (e.g. `"provider.anthropic"`,
  `"extension.gotify.api_key"`, `"oauth.openai-codex"`). Real values are resolved only inside an
  operation's `apply`/`captureState`/`verify`/`rollback` or an extension's runtime call - never in
  a `describe()`, a read-only tool, or anything the model sees directly.
- **Mutating capability goes through the operation engine** (`operations/engine.ts`'s
  `runOperation`): plan → confirm (if not auto-approved) → capture state → apply → verify →
  commit/rollback, durable across a crash via `reconcileOperations` at boot. Read-only inventory
  tools (`agent/tools.ts`) stay separate from mutating operation tools
  (`agent/operation-tools.ts`) stay separate from extension tools (`agent/extension-tools.ts`) -
  `agent/worker.ts`'s narrow investigation subagents only ever see the read-only set.
- **Extensions** are generated by the learning agent (`app_learn` - the agent's own decision,
  never a user command) and live at `<MIRO_DIR>/extensions/<app>/` (`~/.miro` unprivileged,
  `/var/lib/miro` as root) - outside the repo tree, deliberately, so a `tar`/VM resync never
  deletes one. A manifest + a single declarative `extension.ts`
  (`export default { auth?, entries } satisfies ExtensionModule` - reads and writes are data the
  host interprets, `code` only as an escape hatch; see §5.13), validated by `extensions/validate.ts`
  (TypeScript check + an *allowlist* import scan - only `@miro/sdk` + same-directory relative
  imports - + schema check on every `parameters` + a real live probe + a dry-run of every write
  binding through its kind's `describe()`) before being wired into the live agent via
  `agent/extension-tools.ts`, and hot-loaded into the running agent when promoted mid-task. The
  learning agent gets its starting context from **live discovery** (`src/discovery.ts` inspects the
  box for the app's own container/service and published port), never a hand-authored hint.
- **Every agent-issued command goes through `operations/classify.ts`** before anything runs:
  five classes (`read` → sandboxed immediately; `mutate`/`destructive`/`lifeline` → an operation
  through the engine; `forbidden` → refused with the alternative). `rm` and every deletion
  primitive are forbidden for agents - deletion exists only as the `file.delete` kind (a trash
  move). `classify.test.ts` is the bypass catalogue: a new rule or a fixed hole gets a case there
  first. Non-read commands run under `operations/sandbox.ts` (bubblewrap: read-only root,
  plan-declared writable roots, `--unshare-all`, `--cap-drop ALL` for reads). See PLAN.md §5.7.
- **Secrets never appear as values** in plans, tool output, or generated code: headers by
  `secretHeader` reference, bodies/URLs via `{{secret:<ref>}}` placeholders resolved at request
  time, `credential_create` for new passwords/tokens (shown to the owner once), reads of secret
  paths refused by the classifier, `redactSecretsInText` on every read path.
- **The daemon runs as root in production** (`/var/lib/miro` state, `/run/miro/mirod.sock`
  group-accessible); the extension host drops to the `miro` user (`setpriv`) - Chromium will not
  run as root. Unprivileged dev runs keep `~/.miro`. `MIRO_DIR` / `MIRO_SOCKET` override both.
- **ponytail**: least code that solves the actual problem. No speculative abstraction, no
  unrequested config, no framework for a value that never changes. A deliberate simplification that
  cuts a real corner gets a `ponytail:` comment naming the ceiling and the upgrade path.

## Live verification - the actual house style

This project does not trust "tests pass" as proof something works. Every non-trivial piece of
infrastructure in this codebase - the Iroh P2P transport, the operation engine, Memory/Dreaming,
the whole self-extension system - was proven against real infrastructure on `tools/dev-vm`'s QEMU
VM, with results checked independently (a separate SSH session, a raw `curl`, a direct `bun:sqlite`
query against the daemon's real on-disk DB) rather than trusting a model's or a script's own
self-report. This live-testing discipline has found real bugs - ESM import-resolution gotchas, a
daemon that hung forever on a subprocess crash, a circular import that only "worked" by ESM's
fragile lazy-binding luck, a JSON-serialization bug affecting five files, a tool-naming convention
that broke against one specific provider's stricter API - that unit tests and `tsc --noEmit` both
completely missed, because they were about runtime behavior against a real external system, not
pure logic. When you build something non-trivial here, plan to live-verify it the same way: sync to
the dev VM (`tools/dev-vm/ssh.sh`, `up.sh`/`down.sh`), drive it for real, check the result
independently.

Gotchas worth knowing before you try:
- No `rsync` on the dev Mac - sync via `tar czf ... | scp` + `tar xzf` on the VM side, and clean up
  macOS's `._*` AppleDouble sidecar files after (`find . -name "._*" -delete`) or Bun's test runner
  will try to run them as test files. Tarring only `src` dirs (`tar czf x.tgz apps/mirod/src
  packages/*/src`) and extracting over the tree leaves `node_modules` alone - no reinstall.
- `rm -rf apps && tar xzf ...` on the VM also deletes the nested workspace `node_modules` symlinks
  - follow any resync that touched `apps/` with `bun install --force`, since a plain `bun install`
  will report "no changes" without recreating them.
- The daemon on the VM is a systemd unit (`apps/mirod/mirod.service`, hardened per §5.30). Install
  it once per fresh disk with `tools/dev-vm/install-mirod.sh` (writes `/usr/local/bin/mirod`, a
  wrapper that runs the source tree as root; socket `/run/miro/mirod.sock`, state `/var/lib/miro`,
  DB `/var/lib/miro/miro.db`). After a sync: `tools/dev-vm/ssh.sh 'sudo systemctl restart mirod'` -
  `Type=notify`, so it returns once the socket is up; logs `journalctl -u mirod -b`. A sync that
  does not even parse trips the start limit: `sudo systemctl reset-failed mirod` then restart. It
  is enabled, so it comes back after `up.sh` and after a guest reboot - never run the old nohup
  line while the unit is active (two daemons fight over the socket). Drive it headlessly with the
  scratchpad `chat-driver.ts` (one chat message, auto-answers prompts) - `bun` is not on a
  non-interactive ssh PATH there, call `/home/miro/.bun/bin/bun`.
- `pkill -f '<pattern>'` inside an ssh command whose own text contains the pattern kills your shell
  (ssh exits 255, no output). Anchor it: `pkill -f '^/home/miro/.bun/bin/bun run src/index.ts'`.
- SLIRP networking tops out around 1.2 Mbit/s. Big files (Docker images) go in through
  `MIRO_VM_CARGO=<iso> tools/dev-vm/up.sh` (a read-only virtio cargo drive) at disk speed.
- Bun test paths are relative to the cwd: run `bun test` from the repo root, not from `apps/mirod`,
  or a path like `apps/mirod/src/...` silently matches nothing.
- `web_search` routes through `capabilities/` (PLAN.md §5.14): an Ollama cloud key (`/provider` →
  "Ollama cloud (web search key)", stored as `provider.ollama`; `OLLAMA_API_KEY` env as fallback),
  then a self-hosted SearXNG (setting `searxng.base_url` / `SEARXNG_URL`), then the public
  JSON-capable SearXNG pool re-probed daily from searx.space. Measured 2026-09-05: only ~2 public
  instances answer `format=json` (most 429 it by default), so without a key or a self-hosted node
  the learn agent mostly probes blind. Brave is gone.
- The VM's `disk.qcow2` only grows unless the guest trims: `sudo fstrim -av` inside the VM
  releases freed clusters (the drive is attached with `discard=unmap`). An image that bloated
  before that was on (found at 11G for 4.2G of data): `docker image prune -a`, `apt-get clean`,
  zero-fill (`dd if=/dev/zero of=/var/tmp/zero`, then rm), clean `poweroff`, then on the Mac
  `qemu-img convert -O qcow2 -B <base> -F qcow2 disk.qcow2 compact.qcow2` and swap it in. After a
  clean `poweroff`, `up.sh` cold-boots and the enabled unit brings mirod back on its own; the media
  containers now carry `restart=unless-stopped` (the `system_reboot` operation set it, §5.30), so
  the old "restart mirod, then `docker start jellyfin`" chore is gone.
- Self-update layout on the VM (§5.32): mirod runs from `/opt/miro/current` (a symlink; the wrapper
  exports `MIRO_VERSION` = its target's basename, surfaced in `StatusEvent.version`). Version 0.0.1
  is a symlink to the live dev tree `/home/miro/miro`, so sync-and-restart still works AS LONG AS
  `current -> versions/0.0.1`. A self-update test repoints `current` to a copied version; if the dev
  loop stops reflecting your syncs, check `readlink /opt/miro/current` and repoint it to `0.0.1`
  (`sudo ln -sfn /opt/miro/versions/0.0.1 /opt/miro/current.tmp && sudo mv -T ...`), then restart.
  `ExecStartPre=/usr/local/bin/mirod-preflight` runs `apps/mirod/preflight.mjs` (a FIXED copy at
  `/opt/miro/preflight.mjs`, re-copied by `install-mirod.sh`). To test an update: `sudo cp -a
  /home/miro/miro /opt/miro/versions/<v>`, mutate the copy, drive `install_update`. The daemon
  restarts into the swap; the bless/revert verdict is a notification on reconnect.
- Notification bus channels on the VM (§5.31): a Gotify server runs as `gotify.service` on 8080
  (admin/admin default, no cloud-init override) - mint an app token with `curl -u admin:admin -X
  POST http://127.0.0.1:8080/application` and store it as the secret `notify.gotify.token` (settings
  `notify.gotify.url`). Do NOT reuse `extension.gotify.api_key` - it is poisoned with the no-user
  marker on this VM (§5.20). ntfy is a hand-run `binwiederhier/ntfy` container on 8090 (`notify.ntfy.url`
  / `notify.ntfy.topic`); check a push independently via Gotify's `/message` API or ntfy's
  `/<topic>/json?poll=1`. The headless `chat-driver.ts` empties every secret prompt, so it cannot
  drive `notify_configure`'s Gotify token capture (ask_user secretRef) - seed the token directly.

This list is the current one. `PLAN.md`'s "Working notes / gotchas" section is the historical
record from earlier stages - read it for context, keep new gotchas here.
