import { Type } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import { sanitizeNamePart } from "./extension-tools";
import type { Database } from "bun:sqlite";
import { getHostInfo } from "../inventory/host";
import { listContainers } from "../inventory/containers";
import { listServices } from "../inventory/systemd";
import { getMounts } from "../inventory/storage";
import * as extensions from "../extensions/store";
import { listSecretRefs } from "../secrets";
import type { ExtensionManifest } from "../extensions/manifest";
import { query as queryMemory } from "../memory/store";
import { capabilityContextLines, capabilityStatus } from "../capabilities";
import { notificationChannelLines } from "../notifications";
import { setupGapLines, readSetting } from "../setup/status";

// Self-assembling context (PLAN.md §5.9 client decisions: "assembled block + on-demand tool").
// The agent is handed a map of itself every turn - what is on this server right now, which
// systems it already operates and with what tools, and what it cannot do and must do instead -
// built from live state, bounded in size. `capabilities` returns the full detail when a turn
// needs it. Nothing here is hand-maintained prose about the server; it is all read from the
// same inventory, extension and memory stores the tools use.

export interface ServerSnapshot {
  takenAt: number;
  host: string;
  containers: { name: string; image: string; state: string }[];
  services: string[];
  mounts: { mountPoint: string; usedPercent: number; availableGb: number }[];
}

const SNAPSHOT_TTL_MS = 60_000;
let cached: ServerSnapshot | null = null;

/** Systemd units that are always there and never what the user means by "what runs here".
 * Exported so the discovery pass (../discovery.ts) filters the same noise it does. */
export const NOISE_UNIT = /^(systemd-|dbus|getty@|user@|polkit|cron|rsyslog|ssh|serial-getty|e2scrub|apparmor|udisks|ModemManager|unattended|apt-daily|fwupd|thermald|irqbalance|console-setup|keyboard-setup|networking|ifupdown|cloud-)/;

export async function takeSnapshot(force = false): Promise<ServerSnapshot> {
  if (cached && !force && Date.now() - cached.takenAt < SNAPSHOT_TTL_MS) return cached;
  const host = getHostInfo();
  const [containers, services, mounts] = await Promise.all([
    listContainers().catch(() => ({ available: false, containers: [] })),
    listServices().catch(() => ({ available: false, services: [] })),
    getMounts().catch(() => []),
  ]);
  cached = {
    takenAt: Date.now(),
    host: `${(host as { os?: string }).os ?? "linux"} · ${(host as { kernel?: string }).kernel ?? ""} · ${(host as { cpuCount?: number }).cpuCount ?? "?"} cpu · ${Math.round(((host as { memoryTotalBytes?: number }).memoryTotalBytes ?? 0) / 1e9)}GB ram`.replace(/ · $/, ""),
    containers: containers.containers.slice(0, 30).map((c) => ({ name: (c as { name: string }).name, image: (c as { image: string }).image, state: (c as { state: string }).state })),
    services: services.services
      .filter((s) => (s as { active?: string; activeState?: string }).active === "active" || (s as { activeState?: string }).activeState === "active")
      .map((s) => (s as { unit?: string; name?: string }).unit ?? (s as { name?: string }).name ?? "")
      .filter((n) => n && !NOISE_UNIT.test(n))
      .slice(0, 25),
    mounts: mounts
      .filter((m) => m.sizeBytes > 1e9 && !/^(overlay|tmpfs|devtmpfs|efivarfs)$/.test(m.filesystem))
      .map((m) => ({ mountPoint: m.mountPoint, usedPercent: m.usedPercent, availableGb: Math.round(m.availableBytes / 1e9) }))
      .slice(0, 12),
  };
  return cached;
}

const REFUSALS = `What is refused, and what to do instead:
- rm, rmdir, unlink, shred, find -delete, rsync --delete → file_delete (moves to trash, recoverable).
- reboot → the system_reboot operation (always confirmed; Miro reports what came back at its next boot). shutdown/poweroff → the system_shutdown operation (confirmed; the UPS monitor uses it autonomously on low battery). A raw shutdown/poweroff shell command is still refused. mkfs/dd-to-device/wipefs → never; ask the owner.
- Interactive shells, sudo -i, docker exec -it … bash → run the specific command instead.
- Writing under ~/.miro, /var/lib/miro, .ssh private keys, /etc/shadow → never.
- Reading secret material (keys, Miro's DB, .env, credential files) → refused; use secrets by reference.
- Public URLs from shell_inspect → refused as read; http_get/web_search for research, or a confirmed shell_command.
- Passwords/tokens for apps here → credential_create, never ask the owner to invent one.
- Anything that changes state → an operation (shell_command, file_write, file_delete, http_mutation, ext_* operations): confirmed, sandboxed to declared paths, verified, rolled back on failure. Lifeline changes (SSH, firewall, network, Miro) auto-revert unless the owner confirms they are still connected.`;

interface ExtensionLine {
  app: string;
  version: number;
  maturity: string;
  tools: string[];
  operations: string[];
}

function extensionLines(db: Database): ExtensionLine[] {
  return extensions.listEnabled(db).map((row) => {
    const m: ExtensionManifest = JSON.parse(row.manifest);
    return {
      app: m.app,
      version: row.version,
      maturity: extensions.maturityOf(row),
      tools: [...m.tools, ...m.diagnostics].map((t) => t.name),
      operations: (m.operations ?? []).map((t) => t.name),
    };
  });
}

/** The per-turn block. Bounded: 30 containers, 25 services, 12 mounts, every enabled extension by
 * name with its tool names, and the refusal table. Full detail is one `capabilities` call away. */
export function buildContextBlock(db: Database, snapshot: ServerSnapshot): string {
  const parts: string[] = [];
  const containers = snapshot.containers.length
    ? snapshot.containers.map((c) => `${c.name} (${c.image}, ${c.state})`).join("; ")
    : "none (or Docker not reachable)";
  const services = snapshot.services.length ? snapshot.services.join(", ") : "none of note";
  const mounts = snapshot.mounts.length ? snapshot.mounts.map((m) => `${m.mountPoint} ${m.usedPercent}% used, ${m.availableGb}GB free`).join("; ") : "n/a";
  parts.push(`This server right now (snapshot, ≤60s old - inspect for detail before acting):\n- ${snapshot.host}\n- containers: ${containers}\n- services: ${services}\n- storage: ${mounts}`);

  const exts = extensionLines(db);
  if (exts.length > 0) {
    parts.push(
      `Systems you already operate (their ext_<app>_* tools are in your tool list - use them instead of researching):\n` +
        exts.map((e) => `- ${e.app} v${e.version} (${e.maturity}): reads ${e.tools.join(", ") || "-"}; writes ${e.operations.join(", ") || "-"}`).join("\n"),
    );
  } else {
    parts.push("You operate no learned systems yet - app_learn acquires one when a request needs it.");
  }
  const refs = listSecretRefs(db, "extension.");
  if (refs.length > 0) {
    parts.push(
      `Credentials on file (references only - values are never shown; use secretHeader { name, ref } or {{secret:<ref>}} in a body/URL; never ask the user for one of these):\n- ${refs.join("\n- ")}`,
    );
  }
  // Which search/fetch providers actually exist right now (PLAN.md §5.14): the agent should know
  // whether web_search has a keyed or self-hosted source behind it or only the public pool.
  const providers = capabilityContextLines();
  if (providers.length > 0) parts.push(`Research providers (web_search / web_fetch route through these, best first):\n- ${providers.join("\n- ")}`);
  // Whether a needs_attention notification will actually reach a phone right now (PLAN.md §5.31),
  // so the agent knows before it relies on one, and can offer to set a channel up if none is configured.
  const channels = notificationChannelLines();
  if (channels.length > 0) parts.push(channels.join("\n"));
  // Proactive setup (PLAN.md magic-setup slice): surface the well-run-server baseline gaps so the
  // agent can OFFER to close them as one approvable plan - the "magic" of a sysadmin that shows up,
  // assesses, and proposes. Empty (silent) once the baseline is set up.
  const gaps = setupGapLines(db);
  if (gaps.length > 0) parts.push(gaps.join("\n"));
  // Private-by-default (PLAN.md private-by-default pillar): local-only mode is load-bearing for how
  // the agent plans, so it must see it. Silent in open mode - only the restriction needs stating.
  if (readSetting(db, "privacy.mode") === "local_only") {
    parts.push(
      "PRIVACY: LOCAL-ONLY MODE IS ON. Nothing may leave this box: every model choice is pinned to an on-box Ollama model (a *-cloud id is NOT local). No keyed cloud provider, no Codex, no free-tier fallback, and web_search/web_fetch results are the only outside data you get. If a request needs a capability no local model has, say so plainly and let the owner decide (set_privacy_mode switches back to open) - never route around it. `egress_log` shows what left the box before this was on.",
    );
  }
  parts.push(REFUSALS);
  return parts.join("\n\n");
}

/** The callable name of an extension's entry - the same sanitisation extension-tools applies when
 * it builds the real tool, so the agent's own reference manual never advertises a name that does
 * not exist (audit B6: an app named `my.app` was listed as `ext_my.app_x`, callable as `ext_my_app_x`). */
function extToolName(app: string, entry: string): string {
  return `ext_${sanitizeNamePart(app)}_${sanitizeNamePart(entry)}`;
}

/** On-demand depth: every extension's tool descriptions and operations, every capability
 * document, the operation kinds and the command classes - the agent's own reference manual. */
export function buildCapabilitiesTool(db: Database) {
  return {
    name: "capabilities",
    label: "Capabilities",
    description: "Your own reference: every learned system's tools and write operations with descriptions, the recorded operational model of each system, the generic operations you can run, and how commands are classified. Call it when you need detail beyond the summary in your context.",
    parameters: Type.Object({ app: Type.Optional(Type.String({ description: "Limit to one learned system." })) }),
    execute: async (_id: string, params: { app?: string }) => {
      const rows = extensions.listEnabled(db).filter((r) => !params.app || r.app === params.app.trim().toLowerCase());
      const systems = rows.map((row) => {
        const m: ExtensionManifest = JSON.parse(row.manifest);
        const doc = queryMemory(db, { category: "capability", keyword: m.app, limit: 1 }).find((r) => r.key === m.app);
        let model: unknown = doc?.value ?? null;
        try { model = doc ? JSON.parse(doc.value) : null; } catch { /* plain text */ }
        return {
          app: m.app,
          displayName: m.displayName,
          version: row.version,
          maturity: extensions.maturityOf(row),
          baseUrl: m.baseUrl,
          successfulRuns: row.successfulRuns,
          tools: [...m.tools, ...m.diagnostics].map((t) => ({ name: extToolName(m.app, t.name), kind: t.kind, description: t.description })),
          operations: (m.operations ?? []).map((t) => ({ name: extToolName(m.app, t.name), description: t.description })),
          operationalModel: model,
        };
      });
      return textResult({
        systems,
        capabilityProviders: capabilityStatus(),
        genericOperations: ["shell_command", "file_edit", "file_write", "file_delete", "http_mutation", "service_restart", "service_control", "searxng_install"],
        readTools: ["shell_inspect", "read_file", "http_get", "net_capture", "container_*", "systemd_*", "filesystem_*", "network_info", "hardware_gpu", "packages_list", "web_search", "web_fetch"],
        commandClasses: {
          read: "runs immediately in a read-only sandbox; host network only for network-inspecting commands",
          mutate: "an operation: confirmed unless the app is trusted, sandboxed to declared paths, verified, rolled back",
          destructive: "always confirmed; data is snapshotted to trash first where possible",
          lifeline: "always confirmed; auto-reverts unless the owner confirms they are still connected",
          forbidden: "never runs; the refusal names the alternative",
        },
      });
    },
  };
}
