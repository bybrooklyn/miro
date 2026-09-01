import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { OperationToolContext } from "../operations/engine";
import { runOperation } from "../operations/engine";
import { systemdRestartKind } from "../operations/kinds/systemd-restart";
import { shellCommandKind, takeOutput as takeShellOutput, type ShellCommandParams } from "../operations/kinds/shell-command";
import { fileWriteKind, type FileWriteParams } from "../operations/kinds/file-write";
import { fileDeleteKind, type FileDeleteParams } from "../operations/kinds/file-delete";
import { httpMutationKind, takeOutput as takeHttpOutput, type HttpMutationParams } from "../operations/kinds/http-mutation";
import { classifyCommand } from "../operations/classify";
import { runSandboxed } from "../operations/sandbox";

function textResult(details: unknown): AgentToolResult<unknown> {
  // details ?? null: JSON.stringify(undefined) returns the value undefined (not a string),
  // producing a malformed {text: undefined} block — see agent/extension-tools.ts's textResult.
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

const serviceRestartParams = Type.Object({
  unit: Type.String({ description: "systemd unit name, e.g. jellyfin.service" }),
});

const shellCommandParams = Type.Object({
  command: Type.String({ description: "The shell command. It is classified first: forbidden commands (rm, mkfs, reboot, interactive shells, ...) are refused with the safe alternative; read-only commands run immediately; anything else becomes a confirmed, sandboxed, rollback-able operation." }),
  writes: Type.Array(Type.String(), { description: "Every path this command may write (files, directories, sockets). The kernel sandbox refuses writes anywhere else — declare exactly what is needed, nothing more." }),
  network: Type.Boolean({ description: "Whether the command needs network access. Off means no network at all, not even localhost." }),
  reason: Type.String({ description: "Why this change is needed, in one line — shown to the user as the goal." }),
  verify: Type.Optional(Type.String({ description: "A read-only command whose exit code 0 proves the change worked (e.g. 'test -f /opt/app/config.ini')." })),
  rollback: Type.Optional(Type.String({ description: "A command that undoes the change. The declared roots are also snapshotted and restored automatically on failure." })),
  cwd: Type.Optional(Type.String()),
});

const fileWriteParams = Type.Object({
  path: Type.String({ description: "Absolute path to write." }),
  content: Type.String({ description: "Full new file content. The user sees it before approving." }),
  reason: Type.String({ description: "Why, in one line — shown to the user as the goal." }),
  mode: Type.Optional(Type.Integer({ description: "Octal file mode as a number, e.g. 420 for 0644." })),
});

const fileDeleteParams = Type.Object({
  path: Type.String({ description: "Absolute path to move to Miro's trash. Recoverable; never a permanent delete." }),
  reason: Type.String({ description: "Why, in one line — shown to the user as the goal." }),
});

const httpMutationParams = Type.Object({
  method: Type.Unsafe<"POST" | "PUT" | "PATCH" | "DELETE">({ type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] }),
  url: Type.String({ description: "Local or private-network URL only." }),
  reason: Type.String({ description: "Why, in one line — shown to the user as the goal." }),
  body: Type.Optional(Type.String()),
  contentType: Type.Optional(Type.String({ description: "e.g. application/json" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Non-credential headers only. Credentials go in secretHeader by reference." })),
  secretHeader: Type.Optional(Type.Object({ name: Type.String(), ref: Type.String({ description: "Secret store reference, e.g. extension.jellyfin.api_key" }) })),
  expectStatus: Type.Optional(Type.Array(Type.Integer())),
  captureUrl: Type.Optional(Type.String({ description: "GET this before applying; for PUT it is what rollback restores." })),
  verifyUrl: Type.Optional(Type.String({ description: "GET this after applying; 2xx (and verifyExpect, if given) proves success." })),
  verifyExpect: Type.Optional(Type.String()),
  rollback: Type.Optional(
    Type.Object({
      method: Type.Unsafe<"POST" | "PUT" | "PATCH" | "DELETE">({ type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] }),
      url: Type.String(),
      body: Type.Optional(Type.String()),
      contentType: Type.Optional(Type.String()),
    }),
  ),
});

/** Mutating tools go through the operation engine (plan §38, §54 Stage B; PLAN.md §5.4 B) —
 * tracked, confirmed, sandboxed, verified, rolled back on failure. Kept separate from
 * agent/tools.ts's read-only AGENT_TOOLS so subagents spawned via worker.ts never see these. */
export function buildOperationTools(ctx: OperationToolContext) {
  const httpKind = httpMutationKind(ctx.getSecret ?? (() => null));
  return [
    {
      name: "service_restart",
      label: "Restart service",
      description:
        "Restart a systemd service as a tracked, reversible operation — captures state first, verifies afterward, rolls back on failure. Use this instead of any raw shell command.",
      parameters: serviceRestartParams,
      execute: async (_id: string, params: { unit: string }) =>
        textResult(await runOperation(ctx, systemdRestartKind, `restart ${params.unit}`, { unit: params.unit })),
    },
    {
      name: "shell_command",
      label: "Run command",
      description:
        "Run a shell command on the server. Read-only commands run immediately in a read-only sandbox and return their output. Anything that changes state becomes a tracked operation: the user sees the command and its declared scope, approves, the declared paths are snapshotted, the command runs in a kernel sandbox limited to that scope, and it is rolled back if verification fails. rm and other destructive primitives are refused — use file_delete (trash) instead.",
      parameters: shellCommandParams,
      execute: async (_id: string, params: ShellCommandParams & { reason: string }) => {
        const c = classifyCommand(params.command);
        if (c.class === "forbidden") {
          return textResult({ refused: true, reasons: c.reasons, alternative: c.alternative });
        }
        if (c.class === "read") {
          const r = await runSandboxed(["sh", "-c", params.command], { writableRoots: [], network: params.network, cwd: params.cwd, timeoutMs: 60_000 });
          return textResult({ class: "read", exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, truncated: r.truncated });
        }
        const { reason, ...p } = params;
        const result = await runOperation(ctx, shellCommandKind, reason, p);
        const out = takeShellOutput(p);
        return textResult({ ...result, class: c.class, stdout: out?.stdout ?? null, stderr: out?.stderr ?? null, exitCode: out?.exitCode ?? null });
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
        return textResult({ ...result, status: out?.status ?? null, body: out?.body ?? null });
      },
    },
  ];
}

/** Every kind the engine must know at boot for crash reconciliation (index.ts's OPERATION_KINDS). */
export function allOperationKinds(getSecret: (ref: string) => string | null) {
  const http = httpMutationKind(getSecret);
  return {
    [systemdRestartKind.kind]: systemdRestartKind,
    [shellCommandKind.kind]: shellCommandKind,
    [fileWriteKind.kind]: fileWriteKind,
    [fileDeleteKind.kind]: fileDeleteKind,
    [http.kind]: http,
  };
}
