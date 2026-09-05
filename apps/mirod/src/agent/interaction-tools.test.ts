import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@miro/protocol";
import { buildInteractionTools } from "./interaction-tools";

// credential_capture (PLAN.md §5.29): a value the machine printed goes into the store by reference.
// Real temp file; the container/unit sources are the same code path over containerLogs/serviceLogs.
test("credential_capture stores the regex group by reference and never returns the value; refuses bad refs, secret paths, no match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const log = join(dir, "qbittorrent.log");
  writeFileSync(log, "(N) 2026-09-05 - qBittorrent v5 started\n(N) The WebUI administrator username is: admin\n(N) A temporary password is provided for this session: Zq8kPa2mVx\n(N) You should set your own password in program preferences.\n");
  const h = harness({});
  const capture = h.tool("credential_capture");
  const r = await capture.execute("1", { ref: "extension.qbittorrent.bootstrap_password", from: { path: log }, pattern: "temporary password is provided for this session: (\\S+)" });
  expect(r.details).toMatchObject({ saved: true, ref: "extension.qbittorrent.bootstrap_password", line: 3 });
  expect(JSON.stringify(r)).not.toContain("Zq8kPa2mVx"); // the matched line comes back redacted
  expect(h.secrets["extension.qbittorrent.bootstrap_password"]).toBe("Zq8kPa2mVx");

  expect((await capture.execute("2", { ref: "provider.anthropic", from: { path: log }, pattern: "(.+)" })).details).toMatchObject({ saved: false, reason: expect.stringMatching(/extension\.<app>\.<name>/) });
  expect((await capture.execute("3", { ref: "extension.app.x", from: { path: log }, pattern: "no groups here" })).details).toMatchObject({ saved: false, reason: expect.stringMatching(/one capture group/) });
  expect((await capture.execute("4", { ref: "extension.app.x", from: { path: log }, pattern: "nothing like this (\\d+)" })).details).toMatchObject({ saved: false, reason: expect.stringMatching(/no line/) });
  expect((await capture.execute("5", { ref: "extension.app.x", from: { path: log, container: "c" }, pattern: "(x)" })).details).toMatchObject({ saved: false, reason: expect.stringMatching(/exactly one/) });
  // Unused sources arrive as null (Codex fills every optional field) or as a JSON string - both are absent (run #2 finding).
  expect((await capture.execute("7", { ref: "extension.app.y", from: { path: log, container: null, unit: null }, pattern: "username is: (\\S+)" })).details).toMatchObject({ saved: true, ref: "extension.app.y" });
  expect((await capture.execute("8", { ref: "extension.app.z", from: JSON.stringify({ path: log }), pattern: "username is: (\\S+)" })).details).toMatchObject({ saved: true });
  expect(h.secrets["extension.app.y"]).toBe("admin");
  mkdirSync(join(dir, ".ssh"));
  writeFileSync(join(dir, ".ssh", "id_ed25519"), "key");
  expect((await capture.execute("6", { ref: "extension.app.x", from: { path: join(dir, ".ssh", "id_ed25519") }, pattern: "(.+)" })).details).toMatchObject({ saved: false, reason: expect.stringMatching(/refused/) });
  expect(Object.keys(h.secrets).sort()).toEqual(["extension.app.y", "extension.app.z", "extension.qbittorrent.bootstrap_password"]);
  rmSync(dir, { recursive: true, force: true });
});

// Real tool objects driven end to end with injected send/waitForAnswer - the same DI shape
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

test("ask_user never stores the no-user marker or an empty answer as a credential", async () => {
  const { NO_USER_ANSWER } = await import("./interaction-tools");
  const h = harness((_id, events) => ((events[events.length - 1] as { prompt: string }).prompt.includes("key") ? NO_USER_ANSWER : ""));
  const r = await h.tool("ask_user").execute("1", {
    questions: [
      { key: "k", question: "Paste the API key", secretRef: "extension.gotify.api_key" },
      { key: "p", question: "Paste the password", secretRef: "extension.gotify.password" },
    ],
  });
  expect(h.secrets).toEqual({});
  expect(r.details).toEqual({ answers: { k: NO_USER_ANSWER, p: "[no value given]" } });
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
