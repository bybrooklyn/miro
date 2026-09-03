import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getHostInfo } from "../inventory/host";
import { getMounts } from "../inventory/storage";
import { listContainers, inspectContainer, containerLogs } from "../inventory/containers";
import { listServices, serviceLogs } from "../inventory/systemd";
import { getNetworkInterfaces, getTailscaleStatus } from "../inventory/network";
import { webSearch } from "../inventory/web";
import { indexRootOnDisk, queryByClassOnDisk } from "../inventory/filesystem";
import { listInstalledPackages } from "../inventory/packages";
import { detectGpus } from "../inventory/gpu";

function textResult(details: unknown): AgentToolResult<unknown> {
  // details ?? null: JSON.stringify(undefined) returns the value undefined (not a string),
  // producing a malformed {text: undefined} block - see agent/extension-tools.ts's textResult.
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

// Schemas are named so `execute` can reference `Static<typeof schema>` explicitly - TS can't
// infer a sibling property's type from another property within the same object literal.
const containerIdParams = Type.Object({ id: Type.String({ description: "Container id or name" }) });
const containerLogsParams = Type.Object({
  id: Type.String({ description: "Container id or name" }),
  tail: Type.Optional(Type.Number({ description: "Number of lines from the end (default 100)" })),
});
const webSearchParams = Type.Object({ query: Type.String({ description: "Search query" }) });
const serviceLogsParams = Type.Object({
  unit: Type.String({ description: "systemd unit name, e.g. jellyfin.service" }),
  lines: Type.Optional(Type.Number({ description: "Number of lines from the end (default 100)" })),
});
const fsIndexParams = Type.Object({ root: Type.String({ description: "Absolute directory path to scan" }) });
// Plain JSON Schema enum, not Type.Union of literals - the anyOf-of-const shape made a real
// tool-calling model fail to produce valid calls at all (found live, Stage C slice 1; AGENTS.md).
const fsQueryParams = Type.Object({
  class: Type.Unsafe<"media" | "config" | "code" | "archive" | "other">({
    type: "string",
    enum: ["media", "config", "code", "archive", "other"],
    description: "Semantic class to filter by",
  }),
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
      "Search the current web for information this model's training may not have (release notes, recent bugs, current docs). Reports unavailable if no search backend is configured.",
    parameters: webSearchParams,
    execute: async (_id: string, params: Static<typeof webSearchParams>) => textResult(await webSearch(params.query)),
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
];
