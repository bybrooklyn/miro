import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { buildContextBlock, buildCapabilitiesTool, type ServerSnapshot } from "./context";
import { ensureExtensionsTable, promote } from "../extensions/store";
import { ensureMemoryTable, remember } from "../memory/store";
import { ensureSecretsTable } from "../secrets";

// Real in-memory DB with a promoted extension and a capability document; a hand-made snapshot
// (the inventory functions are live-verified on the VM, not re-tested here).

function db() {
  const d = new Database(":memory:");
  ensureExtensionsTable(d);
  ensureMemoryTable(d);
  ensureSecretsTable(d);
  return d;
}

const snapshot: ServerSnapshot = {
  takenAt: 0,
  host: "Debian 13 · 6.12 · 2 cpu · 3GB ram",
  containers: [{ name: "jellyfin", image: "jellyfin/jellyfin:latest", state: "running" }],
  services: ["docker.service", "jellyfin.service"],
  mounts: [{ mountPoint: "/", usedPercent: 26, availableGb: 8 }],
};

const manifest = {
  app: "jellyfin",
  displayName: "Jellyfin",
  baseUrl: "http://127.0.0.1:8096",
  secrets: [],
  tools: [{ name: "system_info", kind: "tool", label: "Info", description: "Server info", parameters: {} }],
  diagnostics: [],
  operations: [{ name: "complete_wizard", kind: "operation", label: "Wizard", description: "Finish setup", parameters: {} }],
  version: 1,
  generatedAt: 0,
};

test("context block: snapshot, no systems yet, refusals", () => {
  const block = buildContextBlock(db(), snapshot);
  expect(block).toContain("jellyfin (jellyfin/jellyfin:latest, running)");
  expect(block).toContain("docker.service, jellyfin.service");
  expect(block).toContain("/ 26% used, 8GB free");
  expect(block).toContain("You operate no learned systems yet");
  expect(block).toContain("file_delete (moves to trash, recoverable)");
  expect(block).toContain("credential_create");
  expect(block).not.toContain("Credentials on file");
});

test("context block names stored extension credentials by reference only — never Miro's own refs", () => {
  const d = db();
  d.run("INSERT INTO secrets (ref, ciphertext) VALUES (?, ?), (?, ?), (?, ?)", [
    "extension.jellyfin.admin_password", "cipher-a",
    "extension.jellyfin.admin_user", "cipher-b",
    "provider.anthropic", "cipher-c",
  ]);
  const block = buildContextBlock(d, snapshot);
  expect(block).toContain("Credentials on file");
  expect(block).toContain("- extension.jellyfin.admin_password\n- extension.jellyfin.admin_user");
  expect(block).not.toContain("provider.anthropic");
  expect(block).not.toContain("cipher-");
});

test("context block lists an operated system with its read and write tool names", () => {
  const d = db();
  promote(d, "jellyfin", JSON.stringify(manifest), 1, "http://127.0.0.1:8096");
  const block = buildContextBlock(d, snapshot);
  expect(block).toContain("jellyfin v1 (learned): reads system_info; writes complete_wizard");
  expect(block).not.toContain("no learned systems");
});

test("capabilities tool returns full detail including the operational model", async () => {
  const d = db();
  promote(d, "jellyfin", JSON.stringify(manifest), 1, "http://127.0.0.1:8096");
  remember(d, "capability", "jellyfin", JSON.stringify({ summary: "media server", components: [{ name: "jellyfin", role: "server" }] }), "test");
  const r = await buildCapabilitiesTool(d).execute("1", {});
  const details = r.details as { systems: { app: string; tools: { name: string }[]; operations: { name: string }[]; operationalModel: { summary: string } }[] };
  expect(details.systems[0].app).toBe("jellyfin");
  expect(details.systems[0].tools[0].name).toBe("ext_jellyfin_system_info");
  expect(details.systems[0].operations[0].name).toBe("ext_jellyfin_complete_wizard");
  expect(details.systems[0].operationalModel.summary).toBe("media server");
  const filtered = await buildCapabilitiesTool(d).execute("1", { app: "nope" });
  expect((filtered.details as { systems: unknown[] }).systems).toEqual([]);
});
