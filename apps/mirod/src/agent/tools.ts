import { Type, type Static } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import { getHostInfo } from "../inventory/host";
import { getMounts } from "../inventory/storage";
import { listContainers, inspectContainer, containerLogs } from "../inventory/containers";
import { listServices, serviceLogs } from "../inventory/systemd";
import { getNetworkInterfaces, getTailscaleStatus } from "../inventory/network";
import { fetchWeb, searchWeb } from "../capabilities";
import { indexRootOnDisk, queryByClassOnDisk } from "../inventory/filesystem";
import { listInstalledPackages } from "../inventory/packages";
import { detectGpus } from "../inventory/gpu";
import { listTrash } from "../operations/trash";

// Schemas are named so `execute` can reference `Static<typeof schema>` explicitly - TS can't
// infer a sibling property's type from another property within the same object literal.
const containerIdParams = Type.Object({ id: Type.String({ description: "Container id or name" }) });
const containerLogsParams = Type.Object({
  id: Type.String({ description: "Container id or name" }),
  tail: Type.Optional(Type.Number({ description: "Number of lines from the end (default 100)" })),
});
const webSearchParams = Type.Object({ query: Type.String({ description: "Search query" }) });
const webFetchParams = Type.Object({
  url: Type.String({ description: "A public http(s) URL - a docs page, release notes, an issue thread. Local/private addresses are refused here; use http_get for those." }),
  maxChars: Type.Optional(Type.Integer({ description: "Cap on the returned text (default 20000)." })),
});
const serviceLogsParams = Type.Object({
  unit: Type.String({ description: "systemd unit name, e.g. jellyfin.service" }),
  lines: Type.Optional(Type.Number({ description: "Number of lines from the end (default 100)" })),
});
const fsIndexParams = Type.Object({ root: Type.String({ description: "Absolute directory path to scan" }) });
// Plain JSON Schema enum, not Type.Union of literals - the anyOf-of-const shape made a real
// tool-calling model fail to produce valid calls at all (found live, Stage C slice 1; AGENTS.md).
const fsQueryParams = Type.Object({
  class: Type.Enum(["media", "config", "code", "archive", "other"], { description: "Semantic class to filter by" }),
});

// Read-only Stage 1/2 tool set. Mutating tool groups (operation_*, update_*, backup_*, ...) are
// Stage 3+ (Safe action) - not built yet, so not exposed to the model. Tool names use underscores,
// not dots - OpenAI's Responses API rejects names outside ^[a-zA-Z0-9_-]+$ (found live testing
// Codex integration; Ollama's more lenient endpoint never caught it).
export const AGENT_TOOLS = [
  {
    name: "host_info",
    label: "Host info",
    description: "Get OS, kernel, CPU, memory, and uptime for this server.",
    parameters: Type.Object({}),
    execute: async () => textResult(getHostInfo()),
  },
  {
    name: "storage_mounts",
    label: "Storage mounts",
    description: "List mounted filesystems with size, used, available, and used percent.",
    parameters: Type.Object({}),
    execute: async () => textResult(await getMounts()),
  },
  {
    name: "container_list",
    label: "List containers",
    description:
      "List Docker containers (running and stopped) with id, name, image, state, status, labels, and ports. Reports unavailable if Docker isn't installed or its daemon isn't reachable.",
    parameters: Type.Object({}),
    execute: async () => textResult(await listContainers()),
  },
  {
    name: "container_inspect",
    label: "Inspect container",
    description: "Get detailed state for one container: health, restart count, mounts, and port bindings.",
    parameters: containerIdParams,
    execute: async (_id: string, params: Static<typeof containerIdParams>) =>
      textResult(await inspectContainer(params.id)),
  },
  {
    name: "container_logs",
    label: "Container logs",
    description: "Get recent timestamped log lines for one container.",
    parameters: containerLogsParams,
    execute: async (_id: string, params: Static<typeof containerLogsParams>) =>
      textResult(await containerLogs(params.id, params.tail ?? 100)),
  },
  {
    name: "systemd_list",
    label: "List services",
    description:
      "List systemd services with load/active/sub state. Reports unavailable on non-systemd machines.",
    parameters: Type.Object({}),
    execute: async () => textResult(await listServices()),
  },
  {
    name: "systemd_logs",
    label: "Service logs",
    description: "Get recent journalctl log lines for one systemd service. Reports unavailable on non-systemd machines.",
    parameters: serviceLogsParams,
    execute: async (_id: string, params: Static<typeof serviceLogsParams>) =>
      textResult(await serviceLogs(params.unit, params.lines ?? 100)),
  },
  {
    name: "hardware_gpu",
    label: "GPU info",
    description:
      "List GPU/accelerator devices (via lspci) and whether NVIDIA tooling or render nodes (/dev/dri) are present. For diagnosing hardware transcode / GPU passthrough issues.",
    parameters: Type.Object({}),
    execute: async () => textResult(await detectGpus()),
  },
  {
    name: "network_info",
    label: "Network info",
    description: "List network interfaces and Tailscale connection status (IP, hostname) if installed.",
    parameters: Type.Object({}),
    execute: async () =>
      textResult({ interfaces: getNetworkInterfaces(), tailscale: await getTailscaleStatus() }),
  },
  {
    name: "web_search",
    label: "Web search",
    description:
      "Search the current web for information this model's training may not have (release notes, recent bugs, current docs). Routed through Miro's search providers (an Ollama cloud key, a self-hosted SearXNG, public SearXNG nodes) - the answer names which one served it. Reports unavailable if none is configured or reachable.",
    parameters: webSearchParams,
    execute: async (_id: string, params: Static<typeof webSearchParams>) => textResult(await searchWeb(params.query)),
  },
  {
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch a public web page as readable text (title, content, links) - to read a docs page or release notes a web_search turned up. Routed like web_search; the answer names which provider served it.",
    parameters: webFetchParams,
    execute: async (_id: string, params: Static<typeof webFetchParams>) => textResult(await fetchWeb(params.url, params.maxChars)),
  },
  {
    name: "filesystem_index",
    label: "Index filesystem",
    description:
      "Scan a directory tree and record what's there (path, size, mtime, semantic class: media/config/code/archive/other). Bounded depth and entry count - for a targeted root, not a whole disk crawl.",
    parameters: fsIndexParams,
    execute: async (_id: string, params: Static<typeof fsIndexParams>) =>
      textResult({ indexed: indexRootOnDisk(params.root) }),
  },
  {
    name: "filesystem_query",
    label: "Query filesystem index",
    description: "List previously indexed files/dirs by semantic class (call filesystem_index on a root first).",
    parameters: fsQueryParams,
    execute: async (_id: string, params: Static<typeof fsQueryParams>) => textResult(queryByClassOnDisk(params.class)),
  },
  {
    name: "packages_list",
    label: "List installed packages",
    description: "List installed system packages via apt or dnf, whichever this distro uses.",
    parameters: Type.Object({}),
    execute: async () => textResult(await listInstalledPackages()),
  },
  {
    name: "trash_list",
    label: "List trash",
    description:
      "List what Miro has moved to its trash (file_delete never deletes - it moves): each entry's original path, where it sits now, and when. Use it to find something to bring back; restoring is a shell_command move the owner approves.",
    parameters: Type.Object({}),
    // Deleted things were unrecoverable through Miro's own surface even though the trash kept them (audit C3).
    execute: async () => textResult(listTrash().map((e) => ({ originalPath: e.originalPath, trashedPath: e.trashedPath, trashedAt: new Date(e.trashedAt).toISOString() }))),
  },
];
