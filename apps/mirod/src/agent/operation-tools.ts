import { Type } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import type { OperationToolContext } from "../operations/engine";
import { runOperation } from "../operations/engine";
import { systemdRestartKind } from "../operations/kinds/systemd-restart";
import { systemdUnitKind, UNIT_ACTIONS, type SystemdUnitParams } from "../operations/kinds/systemd-unit";
import { searxngInstallKind, searxngBaseUrl, DEFAULT_SEARXNG_PORT, SEARXNG_SETTING } from "../operations/kinds/searxng-install";
import { shellCommandKind, takeOutput as takeShellOutput, type ShellCommandParams } from "../operations/kinds/shell-command";
import { fileWriteKind, type FileWriteParams } from "../operations/kinds/file-write";
import { fileEditKind } from "../operations/kinds/file-edit";
import { applyEdits, type AnchoredEdit } from "../operations/hashline";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isSensitivePath } from "../operations/classify";
import { fileDeleteKind, type FileDeleteParams } from "../operations/kinds/file-delete";
import { httpMutationKind, takeOutput as takeHttpOutput, type HttpMutationParams } from "../operations/kinds/http-mutation";
import { classifyCommand, redactSecretsInText } from "../operations/classify";
import { runSandboxed } from "../operations/sandbox";

const serviceRestartParams = Type.Object({
  unit: Type.String({ description: "systemd unit name, e.g. jellyfin.service" }),
});

const serviceControlParams = Type.Object({
  action: Type.Enum(UNIT_ACTIONS, { description: "start | stop | enable | disable a unit, or daemon-reload after writing a unit file (no unit needed)." }),
  unit: Type.Optional(Type.String({ description: "systemd unit name, e.g. jellyfin.service - required for every action but daemon-reload." })),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
});

const shellCommandParams = Type.Object({
  command: Type.String({ description: "The shell command. It is classified first: forbidden commands (rm, mkfs, reboot, interactive shells, ...) are refused with the safe alternative; read-only commands run immediately; anything else becomes a confirmed, sandboxed, rollback-able operation." }),
  writes: Type.Array(Type.String(), { description: "Every path this command may write (directories, sockets, existing files). The kernel sandbox refuses writes anywhere else - declare exactly what is needed, nothing more. A command that works through a daemon's socket (docker, podman) writes the SOCKET (/var/run/docker.sock) plus the host directories it bind-mounts - never /var/lib/docker, which is dockerd's own store and makes the operation a lifeline change. /etc, /var, /root and /home as a whole are refused: name the exact directory." }),
  network: Type.Boolean({ description: "Whether the command needs network access. Off means no network at all, not even localhost." }),
  reason: Type.String({ description: "Why this change is needed, in one line - shown to the user as the goal." }),
  verify: Type.Optional(Type.String({ description: "A read-only command whose exit code 0 proves the change worked (e.g. 'test -f /opt/app/config.ini')." })),
  verifyKeeps: Type.Optional(Type.Boolean({ description: "true when verify describes a LASTING state (a mount is read-only, a config line exists) that Miro should re-check periodically and report as drift if it stops holding. false/omitted for a step of a sequence (a wizard is still open, a temporary name exists)." })),
  rollback: Type.Optional(Type.String({ description: "A command that undoes the change. The declared roots are also snapshotted and restored automatically on failure." })),
  cwd: Type.Optional(Type.String()),
});

const searxngInstallParams = Type.Object({
  port: Type.Optional(Type.Integer({ description: `Loopback port for the node (default ${DEFAULT_SEARXNG_PORT}).` })),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
});

const fileWriteParams = Type.Object({
  path: Type.String({ description: "Absolute path to write." }),
  content: Type.String({ description: "Full new file content. The user sees it before approving." }),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
  mode: Type.Optional(Type.Integer({ description: "Octal file mode as a number, e.g. 420 for 0644." })),
  verifyKeeps: Type.Optional(Type.Boolean({ description: "Omit for a file that should keep this content (a config file) - Miro re-checks it periodically and reports drift. Set false for a one-shot marker or trigger file the app consumes." })),
});

const fileEditParams = Type.Object({
  path: Type.String({ description: "Absolute path of an existing file you have read with read_file(anchored: true)." }),
  edits: Type.Array(
    Type.Object({
      anchor: Type.String({ description: "The N:hhhh tag of the first line of the range, exactly as read_file showed it." }),
      to: Type.Optional(Type.String({ description: "The N:hhhh tag of the last line of the range (inclusive); defaults to anchor. Not used by insert_after." })),
      op: Type.Enum(["replace", "insert_after", "delete"], { description: "replace the range with lines; insert lines after the anchor line; delete the range." }),
      lines: Type.Optional(Type.Array(Type.String(), { description: "The new lines (replace / insert_after), without trailing newlines." })),
    }),
    { description: "Non-overlapping edits; applied together." },
  ),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
});

const fileDeleteParams = Type.Object({
  path: Type.String({ description: "Absolute path to move to Miro's trash. Recoverable; never a permanent delete." }),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
});

const httpMutationParams = Type.Object({
  method: Type.Enum(["POST", "PUT", "PATCH", "DELETE"]),
  url: Type.String({ description: "Local or private-network URL only." }),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
  body: Type.Optional(Type.String({ description: "Request body. Never a literal credential: write {{secret:<ref>}} where a password or token belongs (create one with credential_create); the daemon substitutes it at request time and the user sees only the placeholder." })),
  contentType: Type.Optional(Type.String({ description: "e.g. application/json" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Non-credential headers only, or {{secret:<ref>}} placeholders. Credentials go in secretHeader by reference." })),
  secretHeader: Type.Optional(Type.Object({ name: Type.String(), ref: Type.String({ description: "Secret store reference, e.g. extension.jellyfin.api_key" }) })),
  expectStatus: Type.Optional(Type.Array(Type.Integer())),
  captureUrl: Type.Optional(Type.String({ description: "GET this before applying; for PUT it is what rollback restores." })),
  verifyUrl: Type.Optional(Type.String({ description: "GET this after applying; 2xx (and verifyExpect, if given) proves success." })),
  verifyExpect: Type.Optional(Type.String()),
  verifyKeeps: Type.Optional(Type.Boolean({ description: "true when verifyUrl/verifyExpect describe a LASTING state (a library exists with this path) that Miro should re-check periodically and report as drift if it stops holding. false/omitted for a step of a sequence (the setup wizard is still open, a temporary entry exists)." })),
  rollback: Type.Optional(
    Type.Object({
      method: Type.Enum(["POST", "PUT", "PATCH", "DELETE"]),
      url: Type.String(),
      body: Type.Optional(Type.String()),
      contentType: Type.Optional(Type.String()),
    }),
  ),
  storeResponseField: Type.Optional(
    Type.Object({
      field: Type.String({ description: "What to keep: a JSON field of the response body, dotted path allowed (AccessToken, data.token); 'header:<name>' for a response header; 'cookie:<name>' for one cookie's value from Set-Cookie (a session id such as SID)." }),
      ref: Type.String({ description: "Where to store it: extension.<app>.<name>. You get the ref back, never the value - use it via secretHeader, {{secret:<ref>}} in a body or URL, or a Cookie header value like 'SID={{secret:<ref>}}'." }),
    }, { description: "Retain a token, key or session cookie the response returns (a login's AccessToken or SID cookie, a minted API key) directly in the secret store." }),
  ),
});

/** Mutating tools go through the operation engine (plan §38, §54 Stage B; PLAN.md §5.4 B) -
 * tracked, confirmed, sandboxed, verified, rolled back on failure. Kept separate from
 * agent/tools.ts's read-only AGENT_TOOLS so subagents spawned via worker.ts never see these. */
export function buildOperationTools(ctx: OperationToolContext) {
  const httpKind = httpMutationKind(ctx.getSecret ?? (() => null), ctx.setSecret);
  return [
    {
      name: "service_restart",
      label: "Restart service",
      description:
        "Restart a systemd service as a tracked, reversible operation - captures state first, verifies afterward, rolls back on failure. Use this instead of any raw shell command.",
      parameters: serviceRestartParams,
      execute: async (_id: string, params: { unit: string }) =>
        textResult(await runOperation(ctx, systemdRestartKind, `restart ${params.unit}`, { unit: params.unit })),
    },
    {
      name: "service_control",
      label: "Control service",
      description:
        "Start, stop, enable or disable a systemd unit, or daemon-reload after writing a unit file - a tracked, verified, reversible operation. This is the ONLY way to change a unit's state: `systemctl` inside shell_command is refused because it cannot reach systemd from the command sandbox. Use service_restart for restarts.",
      parameters: serviceControlParams,
      execute: async (_id: string, params: SystemdUnitParams & { reason: string }) => {
        const { reason, ...p } = params;
        return textResult(await runOperation(ctx, systemdUnitKind, reason, p));
      },
    },
    {
      name: "searxng_install",
      label: "Self-host SearXNG",
      description:
        "Set up a self-hosted SearXNG (docker, loopback only, JSON output on) so web_search no longer depends on public nodes or a cloud key - a confirmed operation that pulls the image, starts the container, verifies it answers JSON, and rolls back otherwise. On success web_search uses it first. Needs Docker on this machine.",
      parameters: searxngInstallParams,
      execute: async (_id: string, params: { port?: number; reason: string }) => {
        const { reason, ...p } = params;
        const result = await runOperation(ctx, searxngInstallKind, reason, p);
        const baseUrl = searxngBaseUrl(p.port ?? DEFAULT_SEARXNG_PORT);
        // The commit configures Miro itself: web.search's self-hosted implementation reads this.
        if (result.outcome === "committed") ctx.setSetting?.(SEARXNG_SETTING, baseUrl);
        return textResult({ ...result, ...(result.outcome === "committed" ? { baseUrl, setting: SEARXNG_SETTING } : {}) });
      },
    },
    {
      name: "shell_command",
      label: "Run command",
      description:
        "Run a shell command on the server. Read-only commands run immediately in a read-only sandbox and return their output. Anything that changes state becomes a tracked operation: the user sees the command and its declared scope, approves, the declared paths are snapshotted, the command runs in a kernel sandbox limited to that scope, and it is rolled back if verification fails. rm and other destructive primitives are refused - use file_delete (trash) instead.",
      parameters: shellCommandParams,
      execute: async (_id: string, params: ShellCommandParams & { reason: string }) => {
        const c = classifyCommand(params.command);
        if (c.class === "forbidden") {
          return textResult({ refused: true, reasons: c.reasons, alternative: c.alternative });
        }
        if (c.class === "read") {
          // Same containment as shell_inspect: host network only for network-inspecting commands.
          const r = await runSandboxed(["sh", "-c", params.command], { writableRoots: [], network: c.needsNetwork, cwd: params.cwd, timeoutMs: 60_000 });
          return textResult({ class: "read", exitCode: r.exitCode, stdout: redactSecretsInText(r.stdout), stderr: redactSecretsInText(r.stderr), timedOut: r.timedOut, truncated: r.truncated });
        }
        const { reason, ...p } = params;
        const result = await runOperation(ctx, shellCommandKind, reason, p);
        const out = takeShellOutput(p);
        // Redact the write path's output too - an installer or `curl -u` echoes credentials to
        // stdout, and this branch (unlike the read branch above) had no scrub (audit L2).
        return textResult({ ...result, class: c.class, stdout: out ? redactSecretsInText(out.stdout) : null, stderr: out ? redactSecretsInText(out.stderr) : null, exitCode: out?.exitCode ?? null });
      },
    },
    {
      name: "file_write",
      label: "Write file",
      description:
        "Create or overwrite a file as a tracked operation. The user sees the current and proposed content before approving; the previous content is captured and restored on rollback. Files that can affect SSH, networking, or Miro itself are flagged as lifeline changes.",
      parameters: fileWriteParams,
      execute: async (_id: string, params: FileWriteParams & { reason: string }) => {
        const { reason, ...p } = params;
        return textResult(await runOperation(ctx, fileWriteKind, reason, p));
      },
    },
    {
      name: "file_edit",
      label: "Edit file",
      description:
        "Edit an existing file by hash anchors: read it with read_file(anchored: true), then replace / insert_after / delete ranges named by their N:hhhh tags. Refused, not guessed, if the file changed since you read it. The user approves a diff. Prefer this over file_write for any existing file - never retype a whole config.",
      parameters: fileEditParams,
      execute: async (_id: string, params: { path: string; edits: AnchoredEdit[]; reason: string }) => {
        const { reason, path, edits } = params;
        if (isSensitivePath(path)) return textResult({ refused: true, reason: `${path} is secret material` });
        if (!existsSync(path) || !statSync(path).isFile()) return textResult({ refused: true, reason: `${path} is not an existing file - use file_write to create one` });
        let content: string;
        try {
          content = applyEdits(readFileSync(path, "utf-8"), edits);
        } catch (err) {
          return textResult({ refused: true, reason: String(err instanceof Error ? err.message : err) });
        }
        return textResult(await runOperation(ctx, fileEditKind, reason, { path, edits, content }));
      },
    },
    {
      name: "file_delete",
      label: "Delete (to trash)",
      description:
        "Move a file or directory to Miro's trash as a tracked operation. This is the only way to delete anything: it is recoverable and can be rolled back. Always confirmed by the user.",
      parameters: fileDeleteParams,
      execute: async (_id: string, params: FileDeleteParams & { reason: string }) => {
        const { reason, ...p } = params;
        return textResult(await runOperation(ctx, fileDeleteKind, reason, p));
      },
    },
    {
      name: "http_mutation",
      label: "HTTP write",
      description:
        "Change an app's state through its HTTP API (POST/PUT/PATCH/DELETE to a local or private address) as a tracked operation. Declare captureUrl/verifyUrl so the change can be verified and rolled back; pass credentials only as a secretHeader reference, never literally.",
      parameters: httpMutationParams,
      execute: async (_id: string, params: HttpMutationParams & { reason: string }) => {
        const { reason, ...p } = params;
        const result = await runOperation(ctx, httpKind, reason, p);
        const out = takeHttpOutput(p);
        // Redacted: a raw login response ({"AccessToken": …}) here is how a session token got
        // into a transcript (found live, run #5). A value worth keeping goes through
        // storeResponseField, and only its ref comes back.
        return textResult({ ...result, status: out?.status ?? null, body: out ? redactSecretsInText(out.body) : null, ...(out?.stored !== undefined ? { stored: out.stored, storeError: out.storeError } : {}) });
      },
    },
  ];
}

/** Every kind the engine must know at boot for crash reconciliation (index.ts's OPERATION_KINDS). */
export function allOperationKinds(getSecret: (ref: string) => string | null, setSecret?: (ref: string, value: string) => void) {
  const http = httpMutationKind(getSecret, setSecret);
  return {
    [systemdRestartKind.kind]: systemdRestartKind,
    [systemdUnitKind.kind]: systemdUnitKind,
    [searxngInstallKind.kind]: searxngInstallKind,
    [shellCommandKind.kind]: shellCommandKind,
    [fileWriteKind.kind]: fileWriteKind,
    [fileEditKind.kind]: fileEditKind,
    [fileDeleteKind.kind]: fileDeleteKind,
    [http.kind]: http,
  };
}
