# AGENTS.md — working in this repo

Miro is an auto-improving AI server-management daemon/CLI for self-hosted Linux servers. This file
is operational: how to build, test, and work in this codebase. For the full product vision, every
shipped stage's design record, and every real decision made along the way, read **`PLAN.md`** at
the repo root first — it is the living source of truth, not this file.

This repo is **not a git repository**. Everything here is working-tree state.

## Layout

Bun workspaces monorepo (`workspaces: ["apps/*", "packages/*"]`):

- `apps/mirod` — the daemon. All real logic lives here: the agent loop, the operation engine,
  memory/Dreaming, self-extension, secrets, inventory tools.
- `apps/miro` — the terminal client (OpenTUI + React), talks to `mirod` over a unix socket or Iroh.
- `packages/protocol` — the client-facing wire protocol shared by both apps (`ClientMessage`/
  `ServerEvent`, JSON-line framing over `encodeLine`/`createLineBuffer`).
- `packages/sdk` — `@miro/sdk`, the API surface handed to generated/hand-authored extension code
  (`HttpClient`, `BrowserSession`, `ExtensionTool`/`ExtensionContext`). Never leaks daemon
  internals (no DB, no secrets, no raw exec) to extension code.
- `tools/dev-vm` — a disposable QEMU Debian 13 (arm64) VM, dev-only, not shipped. The only
  reliable way to live-test anything needing real systemd/Docker/network, since this dev Mac has
  neither a working systemd nor (usually) a reachable Docker/Podman daemon.

## Commands

```
bun install                          # from repo root — installs all workspaces
bun test                             # from repo root — runs every *.test.ts in the monorepo
bunx tsc --noEmit                    # run inside each package (apps/mirod, apps/miro,
                                      # packages/protocol, packages/sdk) — no repo-wide typecheck script
bun run --cwd apps/mirod dev         # run the daemon locally
bun run --cwd apps/miro dev          # run the TUI client locally
bun run dev                          # (repo root) runs both together
```

No lint config exists anywhere in this repo. Don't invent one unless asked.

## Conventions (load-bearing, not stylistic preference)

- **Plain `bun:sqlite`, no ORM, no migration framework.** Every table gets an `ensure*Table(db)`
  function run defensively at boot. camelCase in TS interfaces, snake_case in DB columns, a
  `fromRow()` converter. See `operations/store.ts` as the reference shape every other store
  (`memory/store.ts`, `extensions/store.ts`) copies.
- **No mocks, anywhere.** Tests use real `bun:sqlite` `:memory:` databases, real temp files, real
  subprocesses. If something is hard to test without a real external system (a real model API call,
  a real subprocess boundary), that's a signal to live-verify it instead of stubbing it — see
  "Live verification" below.
- **Tool names use underscores, not dots.** `web_search`, not `web.search`. OpenAI's Responses API
  (the Codex provider) rejects tool names outside `^[a-zA-Z0-9_-]+$` — found live, project-wide,
  during Stage C slice 2. `agent/tool-names.test.ts` asserts every static tool-name list matches
  this pattern; keep it passing.
- **Schemas are TypeBox** via `Type` re-exported from `@earendil-works/pi-ai` (not `typebox`
  directly) — every tool's `parameters` field is `Type.Object({...})`. For an enum field, use
  `Type.Unsafe({ type: "string", enum: [...] })` (plain JSON Schema `enum`), not
  `Type.Union([Type.Literal(...)])` (`anyOf`-of-`const`) — the latter made a real tool-calling model
  fail to produce valid calls at all; found live.
- **Secrets** go through `secrets.ts`'s `SecretStore` (`setSecret`/`getSecret`), keyed by
  `SecretRef` strings in `"<namespace>.<name>"` form (e.g. `"provider.anthropic"`,
  `"extension.gotify.api_key"`, `"oauth.openai-codex"`). Real values are resolved only inside an
  operation's `apply`/`captureState`/`verify`/`rollback` or an extension's runtime call — never in
  a `describe()`, a read-only tool, or anything the model sees directly.
- **Mutating capability goes through the operation engine** (`operations/engine.ts`'s
  `runOperation`): plan → confirm (if not auto-approved) → capture state → apply → verify →
  commit/rollback, durable across a crash via `reconcileOperations` at boot. Read-only inventory
  tools (`agent/tools.ts`) stay separate from mutating operation tools
  (`agent/operation-tools.ts`) stay separate from extension tools (`agent/extension-tools.ts`) —
  `agent/worker.ts`'s narrow investigation subagents only ever see the read-only set.
- **Extensions** (self-extension–generated *or* hand-authored "golden" integrations — same
  substrate, see `PLAN.md`) live at `~/.miro/extensions/<app>/` — outside the repo tree,
  deliberately, so a `tar`/VM resync never deletes one. A manifest + up to four files
  (`tools.ts`/`diagnostics.ts`/`browser.ts`/`tests.ts`), validated by `extensions/validate.ts`
  (TypeScript check + an *allowlist* import scan — only `@miro/sdk` + same-directory relative
  imports — + generated tests + a real live probe) before being wired into the live agent's tool
  list via `agent/extension-tools.ts`.
- **ponytail**: least code that solves the actual problem. No speculative abstraction, no
  unrequested config, no framework for a value that never changes. A deliberate simplification that
  cuts a real corner gets a `ponytail:` comment naming the ceiling and the upgrade path.

## Live verification — the actual house style

This project does not trust "tests pass" as proof something works. Every non-trivial piece of
infrastructure in this codebase — the Iroh P2P transport, the operation engine, Memory/Dreaming,
the whole self-extension system — was proven against real infrastructure on `tools/dev-vm`'s QEMU
VM, with results checked independently (a separate SSH session, a raw `curl`, a direct `bun:sqlite`
query against the daemon's real on-disk DB) rather than trusting a model's or a script's own
self-report. This live-testing discipline has found real bugs — ESM import-resolution gotchas, a
daemon that hung forever on a subprocess crash, a circular import that only "worked" by ESM's
fragile lazy-binding luck, a JSON-serialization bug affecting five files, a tool-naming convention
that broke against one specific provider's stricter API — that unit tests and `tsc --noEmit` both
completely missed, because they were about runtime behavior against a real external system, not
pure logic. When you build something non-trivial here, plan to live-verify it the same way: sync to
the dev VM (`tools/dev-vm/ssh.sh`, `up.sh`/`down.sh`), drive it for real, check the result
independently.

Two gotchas worth knowing before you try:
- No `rsync` on the dev Mac — sync via `tar czf ... | scp` + `tar xzf` on the VM side, and clean up
  macOS's `._*` AppleDouble sidecar files after (`find . -name "._*" -delete`) or Bun's test runner
  will try to run them as test files.
- `rm -rf apps && tar xzf ...` on the VM also deletes the nested workspace `node_modules` symlinks
  — follow any resync that touched `apps/` with `bun install --force`, since a plain `bun install`
  will report "no changes" without recreating them.

See `PLAN.md`'s "Working notes / gotchas" section for the full, current list.
