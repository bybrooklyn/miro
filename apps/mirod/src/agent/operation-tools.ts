import { Type } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import type { OperationToolContext } from "../operations/engine";
import { runOperation } from "../operations/engine";
import { systemdRestartKind } from "../operations/kinds/systemd-restart";
import { systemdUnitKind, UNIT_ACTIONS, type SystemdUnitParams } from "../operations/kinds/systemd-unit";
import { rebootKind } from "../operations/kinds/reboot";
import { searxngInstallKind, searxngBaseUrl, DEFAULT_SEARXNG_PORT, SEARXNG_SETTING } from "../operations/kinds/searxng-install";
import { ntfyInstallKind, resolveNtfyBaseUrl, generateTopic, ntfyLocalUrl, DEFAULT_NTFY_PORT, NTFY_URL_SETTING, NTFY_TOPIC_SETTING } from "../operations/kinds/ntfy-install";
import { stageUpdate, availableVersions, currentVersion } from "../self-update";
import { checkForUpdate, fetchAndStage, type FetchDeps } from "../self-update/fetch";
import { makeVerifyManifest } from "../self-update/verify";
import { UPDATE_CHANNEL_SETTING, GITHUB_TOKEN_SECRET, getChannel, getRepo } from "../self-update/config";
import { computeSeverity } from "../operations/severity";
import { runPrivileged } from "../inventory/exec";
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
import { runBackup, pushBackup, type BackupDeps, BACKUP_ENABLED, BACKUP_REPO, BACKUP_AUTH, BACKUP_AGE_RECIPIENT, BACKUP_EXTRA_PATHS } from "../backup";
import { restoreFromBackup } from "../backup/restore";

const serviceRestartParams = Type.Object({
  unit: Type.String({ description: "systemd unit name, e.g. jellyfin.service" }),
});

const serviceControlParams = Type.Object({
  action: Type.Enum(UNIT_ACTIONS, { description: "start | stop | enable | disable a unit, or daemon-reload after writing a unit file (no unit needed)." }),
  unit: Type.Optional(Type.String({ description: "systemd unit name, e.g. jellyfin.service - required for every action but daemon-reload." })),
  reason: Type.String({ description: "Why, in one line - shown to the user as the goal." }),
});

const rebootParams = Type.Object({
  reason: Type.String({ description: "Why the server must reboot now, in one line - shown to the owner as the goal." }),
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

const installUpdateParams = Type.Object({
  toVersion: Type.String({ description: "The staged version to update to (a directory under the versions root, e.g. 0.0.2)." }),
  reason: Type.String({ description: "Why, in one line - shown to the owner as the goal." }),
});

const setUpdateChannelParams = Type.Object({
  channel: Type.Enum(["stable", "beta"], { description: "stable = released versions only; beta = also prereleases. Takes effect on the next update check." }),
});

const ntfyInstallParams = Type.Object({
  port: Type.Optional(Type.Integer({ description: `Host port for the ntfy node (default ${DEFAULT_NTFY_PORT}).` })),
  baseUrl: Type.Optional(Type.String({ description: "The address the owner's phone will use to reach ntfy, e.g. http://192.168.1.10:8090 or a tailscale/hostname URL. Omit to auto-detect (tailnet IP, else LAN IP)." })),
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

const backupConfigureParams = Type.Object({
  enable: Type.Boolean({ description: "Turn config backup on or off." }),
  repo: Type.Optional(Type.String({ description: "owner/name of the private GitHub repo to push to. Omit to let Miro create <hostname>-miro-backup under the token's account." })),
  auth: Type.Optional(Type.Enum(["auto", "deploy_key", "token", "gh"], { description: "How to authenticate the push. auto (default) prefers a per-repo deploy key, then the provider.github token, then gh." })),
  ageRecipient: Type.Optional(Type.String({ description: "An age PUBLIC key (age1...). When set, an encrypt-only secrets bundle is added so a restore can fully recover secrets - the box can never decrypt it, only your off-box private key can." })),
  extraPaths: Type.Optional(Type.String({ description: "Extra absolute config paths to back up, newline- or comma-separated, added to the built-in allowlist." })),
});

const backupNowParams = Type.Object({
  reason: Type.String({ description: "Why, in one line - used as the commit message." }),
  push: Type.Optional(Type.Boolean({ description: "Also push to GitHub after committing (default true)." })),
});

const restoreParams = Type.Object({
  source: Type.Optional(Type.String({ description: "A git URL (private repo, cloned with the provider.github token) or a local path to a checked-out backup tree. Omit to use this box's local backup repo." })),
  ageKeyRef: Type.Optional(Type.String({ description: "Secret ref holding your age PRIVATE key, to decrypt secrets.age. Omit to re-establish secrets instead of restoring them." })),
});

/** Mutating tools go through the operation engine (plan §38, §54 Stage B; PLAN.md §5.4 B) -
 * tracked, confirmed, sandboxed, verified, rolled back on failure. Kept separate from
 * agent/tools.ts's read-only AGENT_TOOLS so subagents spawned via worker.ts never see these. */
export function buildOperationTools(ctx: OperationToolContext) {
  const httpKind = httpMutationKind(ctx.getSecret ?? (() => null), ctx.setSecret);
  const backupDeps: BackupDeps = {
    db: ctx.db,
    getSetting: ctx.getSetting ?? (() => null),
    setSetting: ctx.setSetting ?? (() => {}),
    getSecret: ctx.getSecret ?? (() => null),
  };
  // The self-update fetch dependencies: repo/channel from settings, the token from its secret ref,
  // and the Sigstore verifier bound to this repo's release-workflow identity. Never surfaces the token.
  const buildFetchDeps = (): FetchDeps => {
    const getSetting = ctx.getSetting ?? (() => null);
    return {
      repo: getRepo(getSetting),
      token: ctx.getSecret?.(GITHUB_TOKEN_SECRET) ?? null,
      channel: getChannel(getSetting),
      currentVersion: currentVersion(),
      verify: makeVerifyManifest(getSetting),
    };
  };
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
      name: "system_reboot",
      label: "Reboot server",
      description:
        "Reboot the server as a confirmed, tracked operation. First, running containers with no restart policy get restart=unless-stopped so they come back (a compose file that sets restart: is respected; one that lacks it is named for the owner), and active-but-not-enabled units are named; then systemctl reboot. Miro verifies at its next boot that the same units and containers are back and reports to the owner on their first connection. This call does not return - the daemon goes down with the server. Only for a genuine reboot need (a kernel update, a wedged driver); a stuck service is service_restart.",
      parameters: rebootParams,
      execute: async (_id: string, params: { reason: string }) => textResult(await runOperation(ctx, rebootKind, params.reason, params)),
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
      name: "check_for_update",
      label: "Check for update",
      description:
        "Check the configured GitHub release channel for a newer signed Miro version. Verifies the release's Sigstore signature before reporting anything, and only reads - it does not download the artifact or install. Returns the version and summary if an update is available, or that Miro is current.",
      parameters: Type.Object({}),
      execute: async () => {
        const deps = buildFetchDeps();
        if (!deps.token) return textResult({ error: `no GitHub token configured (secret ${GITHUB_TOKEN_SECRET})` });
        try {
          const up = await checkForUpdate(deps);
          return textResult(
            up
              ? { available: true, version: up.version, summary: up.summary, channel: deps.channel, current: currentVersion() }
              : { available: false, channel: deps.channel, current: currentVersion() },
          );
        } catch (e) {
          return textResult({ error: (e as Error).message });
        }
      },
    },
    {
      name: "install_update",
      label: "Update Miro",
      description:
        "Update Miro itself to a version, then restart into it. If the version is not already staged locally, Miro fetches the newest signed release on the active channel from GitHub, verifies its Sigstore signature and digest, and stages it first. Miro then proves the new version is healthy at its next boot and AUTO-REVERTS to the current version if it is worse or does not come back - you do not have to babysit it. This call does not return: every connection drops when it restarts, then reconnects and reports whether the update was kept or rolled back. Use check_for_update first to see what is available. Only for a genuine update; there is no undo beyond the automatic health revert.",
      parameters: installUpdateParams,
      execute: async (_id: string, params: { toVersion: string; reason: string }) => {
        if (!availableVersions().includes(params.toVersion)) {
          // Not staged locally - fetch it from the release channel (slice 2): download, verify the
          // Sigstore signature + digest, unpack + install into the versions dir. Only the newest
          // release on the active channel is fetchable; an arbitrary older version must be staged.
          const deps = buildFetchDeps();
          if (!deps.token) return textResult({ refused: true, reason: `version ${params.toVersion} is not staged and no GitHub token is configured (secret ${GITHUB_TOKEN_SECRET})`, running: currentVersion() });
          let up;
          try {
            up = await checkForUpdate(deps);
          } catch (e) {
            return textResult({ refused: true, reason: `fetch/verify failed: ${(e as Error).message}` });
          }
          if (!up) return textResult({ refused: true, reason: `nothing named ${params.toVersion} is staged and no update is available on the ${deps.channel} channel` });
          if (up.version !== params.toVersion) return textResult({ refused: true, reason: `the available ${deps.channel} release is ${up.version}, not ${params.toVersion}` });
          const staged = await fetchAndStage(deps, up);
          if (!staged.ok) return textResult({ refused: true, reason: staged.reason });
        }
        const confirmId = `op_confirm:update:${crypto.randomUUID()}`;
        ctx.send({
          type: "question",
          id: confirmId,
          prompt: `Update Miro ${currentVersion() ?? "?"} -> ${params.toVersion} and restart into it? It auto-reverts if unhealthy. Every connection drops; the client reconnects and reports the result.`,
          options: [
            { label: "Update", value: "approve" },
            { label: "Cancel", value: "cancel" },
          ],
        });
        if ((await ctx.waitForAnswer(confirmId)) !== "approve") return textResult({ installed: false, cancelled: true });
        // Restarts the daemon; this call does not return. The bless/revert verdict arrives as a
        // notification on the client's reconnect (self-update/blessOrRevertUpdate at the next boot).
        const result = await stageUpdate({ db: ctx.db, computeSeverity, restart: () => runPrivileged(["systemctl", "restart", "mirod"]) }, params.toVersion);
        return textResult(result.ok ? { installing: true, toVersion: params.toVersion } : { installed: false, reason: result.reason });
      },
    },
    {
      name: "set_update_channel",
      label: "Set update channel",
      description:
        "Choose which self-update channel Miro follows: stable (released versions only) or beta (also prereleases). Takes effect on the next update check.",
      parameters: setUpdateChannelParams,
      execute: async (_id: string, params: { channel: "stable" | "beta" }) => {
        ctx.setSetting?.(UPDATE_CHANNEL_SETTING, params.channel);
        return textResult({ channel: params.channel });
      },
    },
    {
      name: "ntfy_install",
      label: "Self-host ntfy",
      description:
        "Set up a self-hosted ntfy server (docker) so your needs_attention notifications reach the owner's phone - a confirmed operation that pulls the image, starts the container, publishes a test message to prove it, and rolls back otherwise. On success it becomes the ntfy notification channel automatically. Give a baseUrl only if you know the address the phone will use; otherwise it auto-detects (tailnet, then LAN). Needs Docker. Use notify_configure instead to point at an ntfy or Gotify server that already exists.",
      parameters: ntfyInstallParams,
      execute: async (_id: string, params: { port?: number; baseUrl?: string; reason: string }) => {
        const port = params.port ?? DEFAULT_NTFY_PORT;
        const topic = generateTopic();
        const resolved = params.baseUrl ? { baseUrl: params.baseUrl.replace(/\/$/, ""), reachable: true } : await resolveNtfyBaseUrl(port);
        const result = await runOperation(ctx, ntfyInstallKind, params.reason, { port, topic, baseUrl: resolved.baseUrl });
        if (result.outcome === "committed") {
          // The commit configures Miro itself: the ntfy sink reads these. The daemon POSTs to
          // loopback (reliable); the owner subscribes at the phone-reachable address.
          ctx.setSetting?.(NTFY_URL_SETTING, ntfyLocalUrl(port));
          ctx.setSetting?.(NTFY_TOPIC_SETTING, topic);
          return textResult({ ...result, subscribeUrl: `${resolved.baseUrl}/${topic}`, topic, reachableFromPhone: resolved.reachable, setup: resolved.reachable ? "Open the ntfy app and subscribe to this URL." : "No LAN/tailnet address was detected - the server is on loopback only; give a reachable baseUrl or set up tailscale for the phone to reach it." });
        }
        return textResult(result);
      },
    },
    {
      name: "backup_configure",
      label: "Configure backup",
      description:
        "Turn on (or off) config backup: a local git repo of the server's declarative configs + Miro's own non-secret state, pushed to a private GitHub repo Miro creates for itself. Never commits plaintext secrets. Optionally enable an age-encrypted secrets bundle (give an age PUBLIC key) so a restore can fully recover secrets. Use backup_now afterward for the first snapshot; restore_from_backup rebuilds a fresh box.",
      parameters: backupConfigureParams,
      execute: async (_id: string, p: { enable: boolean; repo?: string; auth?: string; ageRecipient?: string; extraPaths?: string }) => {
        ctx.setSetting?.(BACKUP_ENABLED, p.enable ? "true" : "false");
        if (p.repo !== undefined) ctx.setSetting?.(BACKUP_REPO, p.repo);
        if (p.auth !== undefined) ctx.setSetting?.(BACKUP_AUTH, p.auth);
        if (p.ageRecipient !== undefined) ctx.setSetting?.(BACKUP_AGE_RECIPIENT, p.ageRecipient);
        if (p.extraPaths !== undefined) ctx.setSetting?.(BACKUP_EXTRA_PATHS, p.extraPaths);
        const hasToken = !!ctx.getSecret?.(GITHUB_TOKEN_SECRET);
        return textResult({
          enabled: p.enable,
          repo: ctx.getSetting?.(BACKUP_REPO) ?? "(auto)",
          auth: ctx.getSetting?.(BACKUP_AUTH) ?? "auto",
          secretsBundle: ctx.getSetting?.(BACKUP_AGE_RECIPIENT) ? "enabled" : "disabled",
          note: hasToken
            ? "Run backup_now to take the first snapshot and push."
            : `No ${GITHUB_TOKEN_SECRET} token on file - set one so Miro can create the repo and push (or set backup.auth=gh with gh already authenticated).`,
        });
      },
    },
    {
      name: "backup_now",
      label: "Back up now",
      description:
        "Take a config-backup snapshot right now (commit the configs + Miro state), and push it to GitHub unless push:false. This is how the first backup is taken after backup_configure, and how to force one on demand. No-op if backup is disabled.",
      parameters: backupNowParams,
      execute: async (_id: string, p: { reason: string; push?: boolean }) => {
        const result = await runBackup(backupDeps, p.reason);
        if ("skipped" in result) return textResult({ skipped: result.skipped, hint: "Enable backup first: backup_configure(enable: true)." });
        const push = p.push === false ? { pushed: false, reason: "push not requested" } : await pushBackup(backupDeps);
        return textResult({ committed: result.committed, snapshot: result.snapshot, push });
      },
    },
    {
      name: "restore_from_backup",
      label: "Restore from backup",
      description:
        "Reconstruct this box from a backup. Imports Miro's own state (settings, memories, extensions) directly, re-establishes secrets (decrypting the age bundle if you give ageKeyRef, else re-minting/re-prompting per app), and returns the server's backed-up config files so you can rebuild them through the operation engine (file_write each to its absolute path, then bring services up). Use on a freshly deployed mirod pointed at the backup repo or a local tree.",
      parameters: restoreParams,
      execute: async (_id: string, p: { source?: string; ageKeyRef?: string }) => {
        const token = ctx.getSecret?.(GITHUB_TOKEN_SECRET) ?? undefined;
        const ageIdentity = p.ageKeyRef ? ctx.getSecret?.(p.ageKeyRef) ?? undefined : undefined;
        try {
          const r = await restoreFromBackup({ db: ctx.db, setSecret: (ref, v) => ctx.setSecret?.(ref, v) }, { source: p.source, token, ageIdentity });
          return textResult({
            ...r,
            next: "Reconstruct each configFile with file_write to that absolute path, then bring services up (docker compose up -d / service_control enable). Any secret not restored is re-minted or re-prompted as its app is reconstructed.",
          });
        } catch (e) {
          return textResult({ refused: true, reason: (e as Error).message });
        }
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
    [rebootKind.kind]: rebootKind,
    [searxngInstallKind.kind]: searxngInstallKind,
    [ntfyInstallKind.kind]: ntfyInstallKind,
    [shellCommandKind.kind]: shellCommandKind,
    [fileWriteKind.kind]: fileWriteKind,
    [fileEditKind.kind]: fileEditKind,
    [fileDeleteKind.kind]: fileDeleteKind,
    [http.kind]: http,
  };
}
