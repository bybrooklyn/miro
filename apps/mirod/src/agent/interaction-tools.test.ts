import { test, expect } from "bun:test";
import type { ServerEvent } from "@miro/protocol";
import { buildInteractionTools } from "./interaction-tools";

// Real tool objects driven end to end with injected send/waitForAnswer — the same DI shape
// engine.test.ts uses for operation confirmations. No mocks: these ARE the functions the daemon
// hands in, just backed by arrays instead of a socket.

function harness(script: Record<string, string> | ((id: string, events: ServerEvent[]) => string)) {
  const events: ServerEvent[] = [];
  const secrets: Record<string, string> = {};
  const tools = buildInteractionTools({
    send: (e) => events.push(e),
    waitForAnswer: async (id) => (typeof script === "function" ? script(id, events) : (script[id.split(":")[0]] ?? "")),
    setSecret: (ref, value) => { secrets[ref] = value; },
  });
  // The two tools have different parameter types; the harness only needs `execute`, untyped.
  type AnyTool = { execute: (id: string, params: any) => Promise<{ details: unknown }> };
  return { events, secrets, tool: (n: string) => tools.find((t) => t.name === n) as unknown as AnyTool };
}

test("ask_user batches questions, returns answers by key, and stores secrets by reference only", async () => {
  const answersByPrompt: Record<string, string> = { "Movies, TV, or both?": "both", "Paste your VPN password": "hunter2", "Anything else?": "no" };
  const h = harness((_id, events) => {
    const last = events[events.length - 1] as { prompt: string };
    return answersByPrompt[last.prompt] ?? "";
  });
  const r = await h.tool("ask_user").execute("1", {
    questions: [
      { key: "media", question: "Movies, TV, or both?", options: [{ label: "Movies", value: "movies" }, { label: "Both", value: "both" }] },
      { key: "vpn", question: "Paste your VPN password", secretRef: "extension.gluetun.vpn_password" },
      { key: "else", question: "Anything else?" },
    ],
  });
  expect(r.details).toEqual({ answers: { media: "both", vpn: "[stored as extension.gluetun.vpn_password]", else: "no" } });
  expect(h.secrets).toEqual({ "extension.gluetun.vpn_password": "hunter2" });
  expect(JSON.stringify(r)).not.toContain("hunter2");
  expect(h.events.map((e) => e.type)).toEqual(["question", "secret_prompt", "question"]);
  const free = h.events[2] as Extract<ServerEvent, { type: "question" }>;
  expect(free.options).toEqual([]); // free text
});

test("credential_create stores a strong value by reference, shows it to the user once, never returns it to the model", async () => {
  const h = harness({});
  const r = await h.tool("credential_create").execute("1", { ref: "extension.jellyfin.admin_password", purpose: "Jellyfin admin password" });
  const value = h.secrets["extension.jellyfin.admin_password"];
  expect(value).toHaveLength(20);
  expect(JSON.stringify(r)).not.toContain(value);
  expect(r.details).toEqual({ created: true, ref: "extension.jellyfin.admin_password", shownToUserOnce: true });
  const shown = h.events.find((e) => e.type === "notice") as Extract<ServerEvent, { type: "notice" }>;
  expect(shown.level).toBe("credential");
  expect(shown.text).toContain(value);
  const t = await h.tool("credential_create").execute("1", { ref: "extension.x.api_key", purpose: "x", kind: "token" });
  expect(h.secrets["extension.x.api_key"]).toMatch(/^[0-9a-f]{32}$/);
  expect(t.details).toMatchObject({ created: true });
});

test("system_plan sends the plan, asks once, and reports approval", async () => {
  const h = harness({ plan_confirm: "approve" });
  const r = await h.tool("system_plan").execute("1", {
    title: "Media acquisition for Jellyfin",
    findings: ["Jellyfin 10.11 running at :8096", "no download client found"],
    components: [{ name: "jellyfin", action: "reuse", detail: "already configured" }, { name: "qbittorrent", action: "install", detail: "behind the VPN" }],
    steps: ["install qbittorrent", "configure radarr"],
    verification: ["VPN down → downloader cannot reach the internet"],
  });
  expect(r.details).toMatchObject({ approved: true, cancelled: false });
  expect(h.events.map((e) => e.type)).toEqual(["system_plan", "question"]);
  const plan = h.events[0] as Extract<ServerEvent, { type: "system_plan" }>;
  expect(plan.components[1].action).toBe("install");
});

test("system_plan: 'change something' asks what and returns the request unapproved", async () => {
  const h = harness({ plan_confirm: "change", plan_change: "use Usenet instead of torrents" });
  const r = await h.tool("system_plan").execute("1", { title: "t", findings: [], components: [], steps: [], verification: [] });
  expect(r.details).toMatchObject({ approved: false, requestedChange: "use Usenet instead of torrents" });
});

test("system_plan: cancel", async () => {
  const h = harness({ plan_confirm: "cancel" });
  const r = await h.tool("system_plan").execute("1", { title: "t", findings: [], components: [], steps: [], verification: [] });
  expect(r.details).toMatchObject({ approved: false, cancelled: true });
});
