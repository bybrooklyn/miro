# The Miro wire protocol, v1

Everything that talks to `mirod` speaks this: the terminal client, the web UI, and anything you write.
There is no second API - no REST surface to drift out of sync - so if a client can do it, you can.

`PROTOCOL_VERSION` in `@miro/protocol` is the version this document describes. The types in
`packages/protocol/src/index.ts` are normative; this file explains them.

## Framing

JSON, one object per line, UTF-8, `\n`-terminated. `encodeLine()` writes that; `createLineBuffer()`
reads it and tolerates a message split across reads. Over a WebSocket the same lines arrive as
messages - keep using a line buffer, since a single message may carry more than one.

A client **must ignore events it does not recognise**, and must not fail on unknown fields. That is
what makes an additive change (a new event type, a new optional field) a non-breaking one.

## Transports

| Transport | Where | Authentication |
| --- | --- | --- |
| Unix socket | `/run/miro/mirod.sock` (root daemon) or `~/.miro/mirod.sock` | The filesystem. The directory is `0750 root:miro` and the socket `0660`, so opening it proves you are on the box and in the `miro` group. No token. |
| Iroh QUIC | The NodeId in the invite `/pair` prints, ALPN `miro/mirod/1`, one bidirectional stream | A device token, or a pairing code redeemed for one. See below. |
| WebSocket | `/ws` on the web listener (`web_configure`) | The same device token, in the `miro_token` HttpOnly cookie set by `POST /api/pair`. |

`resolveSocketPath()` implements client-side discovery: `MIRO_SOCKET`, else the system socket if it
exists, else the per-user one.

### Authenticating a remote transport

A remote connection is served **nothing** until it authenticates, and is dropped after 20 seconds if it
does not. Send exactly one of:

```json
{"type":"auth","token":"<device token>"}
{"type":"pair_redeem","code":"123456789","deviceName":"my laptop"}
```

The daemon replies with `pair_result`. On success (`ok: true`) the session begins - a redemption also
returns the `token` to store, shown exactly once. On failure (`ok: false`, with `error`) nothing else
will be served: a revoked token stays revoked and a spent code stays spent, so do not retry in a loop.

Codes come from `/pair` on the box: nine digits, single use, ten minutes. Tokens are per-device and
revocable (`mirod devices revoke <id>`).

The web listener wraps the same exchange in HTTP: `GET /api/session` -> `{"authenticated":bool}`, and
`POST /api/pair` with `{"code","deviceName"}` -> `Set-Cookie: miro_token=...` on success, 403 on refusal.

## Client -> server

| Type | Fields | Meaning |
| --- | --- | --- |
| `chat` | `text` | A message to Miro. This is the whole interface: you ask for outcomes, not commands. |
| `answer` | `id`, `value` | Answers a `question` or a `secret_prompt` by its id. For an option question `value` must be one of the offered `value`s; for a free-text one it is the text. |
| `provider_setup` | - | Starts the provider/credential flow (the `/provider` command). |
| `pair_request` | - | Mints a pairing invite (the `/pair` command). The reply is a `reply` event. |
| `memory_list` | - | Lists what Miro remembers. |
| `memory_forget` | `id` | Forgets one memory. |
| `notice_feedback` | `source`, `action` (`quiet`\|`keep`) | Teaches Miro to tier a notification class down, or resets it. |
| `stacks_request` | - | Asks for the managed-stack view. A read; answered with `stacks`. |
| `stack_logs_request` | `app`, `lines?` | The tail of one stack's compose logs (default 200, capped at 500). Answered with `stack_logs`. |
| `stack_action` | `app`, `action` (`start`\|`stop`\|`down`\|`remove`\|`update`) | Acts on a managed stack. **Not a shortcut around the operation engine**: the daemon runs the same operation kind the agent's tools use, so you get the usual `operation_plan`, its confirming `question`, and `operation_result` - and a failure rolls back as always. |
| `auth` | `token` | Remote transports only, first message. |
| `pair_redeem` | `code`, `deviceName?` | Remote transports only, first message. |

## Server -> client

| Type | Fields | Notes |
| --- | --- | --- |
| `status` | `server`, `health`, `model?`, `privilege?`, `version?` | Sent on connect and whenever it changes. `health: "connecting"` is client-only - the daemon sends `healthy`/`degraded`. |
| `reply_delta` | `text` | A fragment of the reply being written. Concatenate in order. |
| `reply` | `text` | The turn's final text. Always sent, even after deltas. |
| `activity` | `id`, `parentId?`, `label`, `status`, `detail?` | One node of the tool-activity tree; sent as `running` then again with the same `id` when it finishes. `parentId` nests a learning agent's calls under the call that spawned it. |
| `question` | `id`, `prompt`, `options`, `timeoutMs?` | The `id` prefix names the kind (`op_confirm:`, `lifeline_confirm:`, `plan_confirm:`, `plan_change:`, `ask:`). Empty `options` means free text. `timeoutMs` means the daemon acts on its own when it lapses (a lifeline auto-revert). |
| `secret_prompt` | `id`, `prompt` | Asks for a value that must never be echoed or reach the model. Answer with `answer`. |
| `notice` | `level`, `text`, `source?` | A line outside any tool tree. `level: "credential"` is the one time a secret value crosses the wire, because the owner must save it. |
| `system_plan` | `id`, `title`, `findings`, `components`, `steps`, `verification`, `notes?` | The architecture Miro proposes before a multi-component change. Approved once, via the paired `question` with id `plan_confirm:<id>`. |
| `operation_plan` | `id`, `goal`, `summary`, `autoApprove`, `details` | A tracked mutation, before it runs. Auto-approved ones still send this; the rest are gated by `op_confirm:<id>`. `details` carries the classifier's class, the sandbox write scope, the repair contract and the kind's own specifics (see `OperationPlanDetails`). |
| `operation_progress` | `id`, `phase` | `capturing` -> `applying` -> `verifying`, or `awaiting_reachability` for a lifeline change. |
| `operation_result` | `id`, `outcome`, `message` | `committed`, `rolledback`, or `applied_unverified` (it reached the server, verify could not confirm it, and it was irreversible - so nothing was rolled back). |
| `pair_result` | `ok`, `token?`, `deviceId?`, `deviceName?`, `error?` | Remote transports only, in answer to `auth`/`pair_redeem`. |
| `stacks` | `stacks[]`, `unavailable?` | Each stack's `app`, `status`, `dir`, `running`/`declared` container counts and `images`. `unavailable` explains why the live numbers are missing (no compose CLI, docker unreachable) rather than showing everything as stopped. |
| `stack_logs` | `app`, `lines[]`, `error?` | Newest last. An app the daemon does not manage is refused, not shelled out with. |

## Rendering it

`@miro/ui-model` is a pure reducer from these events to a `UiState` - transcript blocks, the pending
prompt, whether a turn is in flight. Both shipped clients render it (the terminal with OpenTUI, the
browser with React DOM) and neither owns any UI logic of its own. If you write a client, using it means
the transcript, the activity tree, the operation cards and the prompt semantics all match for free.

## A minimal client

```ts
import { encodeLine, createLineBuffer, resolveSocketPath, type ServerEvent } from "@miro/protocol";

const socket = await Bun.connect({
  unix: resolveSocketPath(),
  socket: {
    data(_s, chunk) { feed(chunk); },
    open(s) { s.write(encodeLine({ type: "chat", text: "how much disk is left?" })); },
  },
});
const feed = createLineBuffer((line) => {
  const event = JSON.parse(line) as ServerEvent;
  if (event.type === "reply") console.log(event.text);
});
```

## Compatibility

- Additive changes keep `PROTOCOL_VERSION` at 1: new event types, new optional fields, new `question`
  id prefixes, new `notice` sources.
- Anything an existing client could misread bumps the version, and the `IROH_ALPN` suffix
  (`miro/mirod/1`) with it, so an old client fails to connect rather than misbehaving.
- The three-state `health` and the `id`-prefix convention on questions are part of the contract, not
  implementation details.
