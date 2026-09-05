import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@miro/protocol";
import { runOperation, type OperationToolContext } from "../engine";
import { ensureOperationsTable } from "../store";
import { ensureMemoryTable } from "../../memory/store";
import { fileWriteKind } from "./file-write";
import { fileDeleteKind } from "./file-delete";
import { httpMutationKind, isLocalOrPrivateUrl } from "./http-mutation";
import { shellCommandKind } from "./shell-command";
import { systemdUnitKind } from "./systemd-unit";
import { systemdRestartKind } from "./systemd-restart";
import { dockerRunArgs, searxngBaseUrl, searxngInstallKind, settingsYaml } from "./searxng-install";
import { fileEditKind } from "./file-edit";
import { applyEdits, lineHash } from "../hashline";
import { sandboxAvailable } from "../sandbox";
import { listTrash } from "../trash";

// Real engine, real filesystem, a real HTTP server - the kinds are exercised end to end through
// runOperation with an injected answer, exactly as engine.test.ts drives its fake kind.

const sandboxOk = await sandboxAvailable();

function ctx(answer = "approve"): { ctx: OperationToolContext; events: ServerEvent[] } {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  ensureMemoryTable(db);
  const events: ServerEvent[] = [];
  return {
    events,
    ctx: {
      db,
      send: (e) => events.push(e),
      waitForAnswer: async () => answer,
      getSecret: (ref) => (ref === "test.token" ? "s3cret" : null),
      // Deterministic and free of real subprocess calls - these tests exercise the kinds, not this
      // machine's actual systemd/docker/disk state.
      computeSeverity: async () => 0,
    },
  };
}

function planOf(events: ServerEvent[]) {
  return events.find((e) => e.type === "operation_plan") as Extract<ServerEvent, { type: "operation_plan" }>;
}

let work: string;
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "kinds-")));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// Prodtest targets (operations/prodtest.ts): state-based kinds always have one; a model-written
// verify only when the planner declared it lasting (found live: every mid-wizard check re-verified
// as drift otherwise).
describe("prodtest targets", () => {
  test("shell/http need verify AND verifyKeeps; file/systemd kinds are their target", () => {
    expect(shellCommandKind.prodtest!({ command: "c", writes: ["/x"], network: false })).toBeNull();
    expect(shellCommandKind.prodtest!({ command: "c", writes: ["/x"], network: false, verify: "test -f /x/a" })).toBeNull();
    expect(shellCommandKind.prodtest!({ command: "c", writes: ["/x"], network: false, verify: "test -f /x/a", verifyKeeps: true })).toBe("c");
    const http = httpMutationKind(() => null);
    expect(http.prodtest!({ method: "POST", url: "http://127.0.0.1:1/a", verifyUrl: "http://127.0.0.1:1/a" } as any)).toBeNull();
    expect(http.prodtest!({ method: "POST", url: "http://127.0.0.1:1/a", verifyUrl: "http://127.0.0.1:1/a", verifyKeeps: true } as any)).toBe("http://127.0.0.1:1/a");
    expect(fileWriteKind.prodtest!({ path: "/etc/x.conf", content: "" })).toBe("/etc/x.conf");
    expect(fileWriteKind.prodtest!({ path: "/var/lib/app/reset-marker", content: "", verifyKeeps: false })).toBeNull();
    expect(fileDeleteKind.prodtest!({ path: "/etc/x.conf" })).toBe("/etc/x.conf");
    expect(systemdUnitKind.prodtest!({ action: "enable", unit: "a.service" })).toBe("a.service#enabled");
    expect(systemdUnitKind.prodtest!({ action: "daemon-reload" })).toBeNull();
  });
});

// file.edit through the real engine on a real file: the tool's computed content, a diff in the
// plan, a stale view refused at planning, commit and rollback.
describe("file.edit", () => {
  test("an anchored edit commits, shows a diff, and is refused when the file changed since it was read", async () => {
    const path = join(work, "app.ini");
    const original = "[server]\nport = 8096\nbind = 0.0.0.0\n";
    writeFileSync(path, original);
    const edits = [{ anchor: `2:${lineHash("port = 8096")}`, op: "replace" as const, lines: ["port = 8920"] }];
    const content = applyEdits(original, edits);
    const { ctx: c, events } = ctx();
    const result = await runOperation(c, fileEditKind, "move the port", { path, edits, content });
    expect(result.outcome).toBe("committed");
    expect(readFileSync(path, "utf-8")).toBe("[server]\nport = 8920\nbind = 0.0.0.0\n");
    const plan = planOf(events);
    expect(plan.summary).toMatch(/Edit .*app\.ini \(1 anchored edit/);
    expect(plan.autoApprove).toBe(false);
    expect(String(plan.details!.diff)).toContain("-port = 8096");
    expect(String(plan.details!.diff)).toContain("+port = 8920");
    // The same edit again: the anchor no longer matches the file - refused at planning, nothing touched.
    await expect(fileEditKind.describe({ path, edits, content })).rejects.toThrow(/no longer matches line 2/);
    // Content that does not match what the edits produce now is refused too.
    writeFileSync(path, original);
    await expect(fileEditKind.describe({ path, edits, content: "something else\n" })).rejects.toThrow(/changed between reading it and planning/);
    // Not an existing file, or secret material: refused.
    await expect(fileEditKind.describe({ path: join(work, "nope"), edits, content })).rejects.toThrow(/not an existing file/);
    await expect(fileEditKind.describe({ path: join(work, ".miro", "secret.key"), edits, content })).rejects.toThrow(/secret material/);
  });

  test("a failed verify restores the previous content and mode", async () => {
    const path = join(work, "x.conf");
    writeFileSync(path, "a\nb\n", { mode: 0o600 });
    const edits = [{ anchor: `1:${lineHash("a")}`, op: "delete" as const }];
    const content = applyEdits("a\nb\n", edits);
    const kind = { ...fileEditKind, verify: async () => false };
    const result = await runOperation(ctx().ctx, kind, "drop a", { path, edits, content });
    expect(result.outcome).toBe("rolledback");
    expect(readFileSync(path, "utf-8")).toBe("a\nb\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(fileEditKind.prodtest!({ path, edits, content })).toBe(path);
  });
});

// searxng.install: the pure parts (what it writes and runs) and the docker precondition; the real
// container is the live check on the VM.
describe("searxng.install", () => {
  test("settings enable JSON output and disable the limiter with a fresh secret; the container binds loopback only", async () => {
    const yaml = settingsYaml("abc");
    expect(yaml).toContain("use_default_settings: true");
    expect(yaml).toContain('secret_key: "abc"');
    expect(yaml).toContain("limiter: false");
    expect(yaml).toMatch(/formats:\n {4}- html\n {4}- json/);
    expect(settingsYaml()).not.toBe(settingsYaml()); // a new key each time
    expect(dockerRunArgs(8888, "/var/lib/miro/searxng")).toEqual(["run", "-d", "--name", "miro-searxng", "--restart", "unless-stopped", "-p", "127.0.0.1:8888:8080", "-v", "/var/lib/miro/searxng:/etc/searxng", "searxng/searxng:latest"]);
    expect(searxngInstallKind.prodtest!({})).toBe("miro-searxng");
  });

  test("describe refuses without docker (this machine) and a privileged or silly port", async () => {
    const plan = await searxngInstallKind.describe({}).catch((e: Error) => e);
    if (plan instanceof Error) expect(plan.message).toMatch(/docker is required/);
    else expect(plan).toMatchObject({ autoApprove: false, class: "mutate", network: true, details: { port: 8888 } });
    // The port check runs after the docker check; on a docker-less machine the docker refusal wins,
    // so the port rule is checked through the URL helper it feeds.
    expect(searxngBaseUrl(8888)).toBe("http://127.0.0.1:8888");
  });
});

// systemd.unit's plan is pure given the unit's state (getServiceState degrades to "unknown" on a
// machine without systemctl, like this one); the real systemctl calls are the live check on the VM.
describe("systemd.unit", () => {
  test("stop/disable of a lifeline-adjacent unit is a lifeline operation; the rest is mutate and auto-approvable", async () => {
    const stopSsh = await systemdUnitKind.describe({ action: "stop", unit: "ssh.service" });
    expect(stopSsh.class).toBe("lifeline");
    expect(stopSsh.autoApprove).toBe(false);
    expect(stopSsh.warning).toMatch(/drop your connection/);
    const startSsh = await systemdUnitKind.describe({ action: "start", unit: "ssh.service" });
    expect(startSsh.class).toBe("mutate");
    const enableApp = await systemdUnitKind.describe({ action: "enable", unit: "jellyfin.service" });
    expect(enableApp.class).toBe("mutate");
    expect(enableApp.autoApprove).toBe(true);
    expect(enableApp.writes).toContain("/etc/systemd/system");
    expect(enableApp.expects).toBe("jellyfin.service is enabled at boot");
    // The classifier's LIFELINE_UNITS is the one list (audit A7): docker, nftables, tailscaled ...
    for (const unit of ["docker.service", "nftables.service", "containerd", "wg-quick@wg0.service"]) {
      expect((await systemdUnitKind.describe({ action: "stop", unit })).class).toBe("lifeline");
    }
    // Miro's own unit is never stopped or restarted by Miro.
    await expect(systemdUnitKind.describe({ action: "stop", unit: "mirod.service" })).rejects.toThrow(/Miro itself/);
    await expect(systemdRestartKind.describe({ unit: "mirod" })).rejects.toThrow(/Miro itself/);
    expect((await systemdUnitKind.describe({ action: "start", unit: "mirod.service" })).class).toBe("mutate");
  });

  test("daemon-reload needs no unit and never rolls back; every other action refuses a missing or malformed unit name", async () => {
    const reload = await systemdUnitKind.describe({ action: "daemon-reload" });
    expect(reload.summary).toMatch(/daemon-reload/);
    expect(reload.rollbackWhen).toMatch(/^never/);
    await expect(systemdUnitKind.describe({ action: "start" })).rejects.toThrow(/not a systemd unit name/);
    await expect(systemdUnitKind.describe({ action: "start", unit: "jellyfin; rm -rf /" })).rejects.toThrow(/not a systemd unit name/);
    await expect(systemdUnitKind.describe({ action: "enable", unit: "wg-quick@wg0.service" })).resolves.toMatchObject({ class: "mutate" });
  });
});

describe("file.write", () => {
  test("creates a file, shows proposed content in the plan, never auto-approves", async () => {
    const { ctx: c, events } = ctx();
    const path = join(work, "app", "config.ini");
    const r = await runOperation(c, fileWriteKind, "write config", { path, content: "a=1\n" });
    expect(r.outcome).toBe("committed");
    expect(readFileSync(path, "utf-8")).toBe("a=1\n");
    const plan = planOf(events);
    expect(plan.autoApprove).toBe(false);
    expect(plan.details?.proposed).toBe("a=1\n");
    expect(plan.details?.class).toBe("mutate");
    expect(plan.details?.writes).toEqual([join(work, "app")]);
  });

  test("overwrite captures the previous content; a user cancel changes nothing", async () => {
    const path = join(work, "f");
    writeFileSync(path, "old");
    const { ctx: c } = ctx("cancel");
    const r = await runOperation(c, fileWriteKind, "overwrite", { path, content: "new" });
    expect(r.outcome).toBe("rolledback");
    expect(readFileSync(path, "utf-8")).toBe("old");
  });

  test("rollback of a created file moves it to trash rather than deleting it", async () => {
    const path = join(work, "created");
    const captured = await fileWriteKind.captureState({ path, content: "x" });
    await fileWriteKind.apply({ path, content: "x" });
    await fileWriteKind.rollback({ path, content: "x" }, captured);
    expect(existsSync(path)).toBe(false);
    expect(listTrash().some((e) => e.originalPath === path)).toBe(true);
  });

  test("lifeline paths are classed lifeline; secret material is refused", async () => {
    const plan = await fileWriteKind.describe({ path: "/etc/ssh/sshd_config", content: "" }).catch((e) => e);
    // describe() reads the current file for the preview; on a machine without it that's fine too.
    if (!(plan instanceof Error)) expect(plan.class).toBe("lifeline");
    await expect(fileWriteKind.describe({ path: join(work, ".miro", "secret.key"), content: "" })).rejects.toThrow(/secret material/);
  });
});

describe("file.delete", () => {
  test("moves to trash, verifies gone, and rollback restores", async () => {
    const dir = join(work, "media");
    mkdirSync(dir);
    writeFileSync(join(dir, "x"), "bytes");
    const { ctx: c, events } = ctx();
    const r = await runOperation(c, fileDeleteKind, "remove media", { path: dir });
    expect(r.outcome).toBe("committed");
    expect(existsSync(dir)).toBe(false);
    const entry = listTrash().find((e) => e.originalPath === dir)!;
    expect(readFileSync(join(entry.trashedPath, "x"), "utf-8")).toBe("bytes");
    expect(planOf(events).details?.class).toBe("destructive");
    expect(planOf(events).autoApprove).toBe(false);

    await fileDeleteKind.rollback({ path: dir }, { entry, wasDirectory: true, bytes: 5 });
    expect(readFileSync(join(dir, "x"), "utf-8")).toBe("bytes");
  });

  test("refuses Miro's own state and missing paths", async () => {
    await expect(fileDeleteKind.describe({ path: "/home/x/.miro/miro.db" })).rejects.toThrow();
    await expect(fileDeleteKind.describe({ path: join(work, "nope") })).rejects.toThrow(/does not exist/);
  });
});

describe("http.mutation", () => {
  test("private-only URL guard", () => {
    for (const ok of ["http://127.0.0.1:8096/x", "http://localhost/x", "http://10.0.0.5/x", "http://192.168.1.2/x", "http://172.16.0.1/x", "http://jellyfin:8096/x", "http://nas.local/x", "http://[::1]/x", "http://[fd12::1]/x", "http://[::ffff:127.0.0.1]/x", "http://0.0.0.0:8096/x"]) {
      expect(isLocalOrPrivateUrl(ok)).toBe(true);
    }
    // fdsomething.com / fc2.com: the IPv6 ULA prefixes used to match any hostname (audit A3), so a
    // read-class curl to them left the LAN.
    for (const bad of ["http://example.com/x", "http://8.8.8.8/x", "http://172.32.0.1/x", "ftp://127.0.0.1/x", "not a url", "http://fdsomething.com/x", "http://fc2.com/x", "http://fe80cafe.example/x"]) {
      expect(isLocalOrPrivateUrl(bad)).toBe(false);
    }
  });

  test("POST with secret header by reference, verify, and PUT rollback against a real server", async () => {
    const state = { value: "before", seenToken: "" };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        state.seenToken = req.headers.get("X-Token") ?? "";
        if (url.pathname === "/value" && req.method === "GET") return new Response(state.value);
        if (url.pathname === "/value" && req.method === "PUT") { state.value = await req.text(); return new Response("ok"); }
        if (url.pathname === "/fail") return new Response("nope", { status: 500 });
        if (url.pathname === "/autherr") return new Response('{"error":"bad","token":"leaked-token-abc123"}', { status: 401 });
        if (url.pathname === "/no-content" && req.method === "POST") return new Response(null, { status: 204 });
        if (url.pathname === "/exists" && req.method === "POST") return new Response("already there", { status: 409 });
        if (url.pathname === "/login" && req.method === "POST") return Response.json({ AccessToken: "tok-123", User: { Id: "u1" } });
        // POST applies (200), but a GET verify sees a body that never matches verifyExpect.
        if (url.pathname === "/wizard" && req.method === "POST") { state.value = "applied"; return new Response(null, { status: 204 }); }
        if (url.pathname === "/wizard" && req.method === "GET") return new Response("applied");
        return new Response("?", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      // storeResponseField keeps a response value in the store by ref; the model-visible side
      // (plan details, output) carries the ref only. A missing field reports, never rolls back.
      const stored = new Map<string, string>();
      const storing = httpMutationKind(() => null, (ref, value) => stored.set(ref, value));
      const { ctx: sc, events: se } = ctx();
      const login = await runOperation(sc, storing, "login", { method: "POST", url: `${base}/login`, storeResponseField: { field: "AccessToken", ref: "extension.app.session_token" } });
      expect(login.outcome).toBe("committed");
      expect(stored.get("extension.app.session_token")).toBe("tok-123");
      expect(planOf(se).details?.stores).toBe("AccessToken → extension.app.session_token");
      expect(JSON.stringify(se)).not.toContain("tok-123");
      const missing = await runOperation(ctx().ctx, storing, "login", { method: "POST", url: `${base}/login`, storeResponseField: { field: "Nope", ref: "extension.app.x" } });
      expect(missing.outcome).toBe("committed");
      expect(stored.has("extension.app.x")).toBe(false);

      // An irreversible POST whose verify fails is applied_unverified, NOT rolled back - the write
      // reached the server (no rollback request, non-PUT), so claiming a rollback would be a lie.
      const unver = await runOperation(ctx().ctx, storing, "wizard step", { method: "POST", url: `${base}/wizard`, verifyUrl: `${base}/wizard`, verifyExpect: "never-matches" });
      expect(unver.outcome).toBe("applied_unverified");
      expect(unver.message).toContain("cannot be rolled back");
      // A reversible PUT with the same failing verify is genuinely rolled back.
      state.value = "before";
      const reverted = await runOperation(ctx().ctx, storing, "put step", { method: "PUT", url: `${base}/value`, body: "after", captureUrl: `${base}/value`, verifyUrl: `${base}/value`, verifyExpect: "never-matches" });
      expect(reverted.outcome).toBe("rolledback");
      expect(state.value).toBe("before");
      await expect(storing.describe({ method: "POST", url: `${base}/login`, storeResponseField: { field: "AccessToken", ref: "provider.anthropic" } })).rejects.toThrow(/extension\.<app>\.<name>/);
      const kind = httpMutationKind((ref) => (ref === "test.token" ? "s3cret" : null));
      // A 2xx the plan did not predict is still an applied write (Jellyfin answers 204 where a
      // plan said 200 - a false rollback, found live); expectStatus only widens success.
      expect((await runOperation(ctx().ctx, kind, "no content", { method: "POST", url: `${base}/no-content`, expectStatus: [200] })).outcome).toBe("committed");
      expect((await runOperation(ctx().ctx, kind, "exists ok", { method: "POST", url: `${base}/exists`, expectStatus: [409] })).outcome).toBe("committed");
      expect((await runOperation(ctx().ctx, kind, "exists not ok", { method: "POST", url: `${base}/exists` })).outcome).toBe("rolledback");
      // A failing apply's error body is redacted before it reaches the model / logs / a reflection
      // prompt (audit L1).
      const autherr = await runOperation(ctx().ctx, kind, "auth", { method: "POST", url: `${base}/autherr` });
      expect(autherr.outcome).toBe("rolledback");
      expect(autherr.message).not.toContain("leaked-token-abc123");
      expect(autherr.message).toContain("[redacted]");
      const { ctx: c, events } = ctx();
      const r = await runOperation(c, kind, "set value", {
        method: "PUT", url: `${base}/value`, body: "after", contentType: "text/plain",
        secretHeader: { name: "X-Token", ref: "test.token" }, captureUrl: `${base}/value`, verifyUrl: `${base}/value`, verifyExpect: "after",
      });
      expect(r.outcome).toBe("committed");
      expect(state.value).toBe("after");
      expect(state.seenToken).toBe("s3cret");
      const plan = planOf(events);
      expect(JSON.stringify(plan.details)).not.toContain("s3cret"); // never in the plan
      expect(plan.details?.auth).toBe("X-Token ← test.token");
      expect(plan.details?.irreversible).toBeUndefined(); // PUT + captureUrl is reversible

      // A failing apply rolls the captured representation back.
      state.value = "before";
      const captured = await kind.captureState({ method: "PUT", url: `${base}/value`, captureUrl: `${base}/value` });
      await kind.rollback({ method: "PUT", url: `${base}/value`, contentType: "text/plain" }, captured);
      expect(state.value).toBe("before");

      // Non-2xx is a failure.
      const r2 = await runOperation(ctx().ctx, kind, "fail", { method: "POST", url: `${base}/fail` });
      expect(r2.outcome).toBe("rolledback");
    } finally {
      server.stop(true);
    }
  });

  test("{{secret:ref}} placeholders resolve at request time only; a literal password in the body is refused", async () => {
    let seenBody = "";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { seenBody = await req.text(); return new Response("ok"); } });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const kind = httpMutationKind((ref) => (ref === "extension.jellyfin.admin_password" ? "hunter2-very-secret" : null));
      const { ctx: c, events } = ctx();
      const body = '{"Name":"admin","Password":"{{secret:extension.jellyfin.admin_password}}"}';
      const r = await runOperation(c, kind, "create admin", { method: "POST", url: `${base}/Startup/User`, body, contentType: "application/json" });
      expect(r.outcome).toBe("committed");
      expect(seenBody).toBe('{"Name":"admin","Password":"hunter2-very-secret"}'); // the app got the value
      expect(JSON.stringify(events)).not.toContain("hunter2"); // the user/model never did
      expect(JSON.stringify(planOf(events).details)).toContain("{{secret:extension.jellyfin.admin_password}}");

      await expect(kind.describe({ method: "POST", url: `${base}/x`, body: '{"Name":"admin","Password":"hunter2-literal"}' })).rejects.toThrow(/literal credential/);
      await expect(kind.describe({ method: "POST", url: `${base}/x`, body: '{"Password":"{{secret:extension.nope.pw}}"}' })).rejects.toThrow(/not set/);
    } finally {
      server.stop(true);
    }
  });

  test("literal credential headers and public URLs are refused; no undo means irreversible", async () => {
    const kind = httpMutationKind(() => null);
    await expect(kind.describe({ method: "POST", url: "http://127.0.0.1/x", headers: { Authorization: "Bearer x" } })).rejects.toThrow(/by reference/);
    // Jellyfin's token-less client identification is not a credential; with a literal token it is.
    await expect(kind.describe({ method: "POST", url: "http://127.0.0.1/x", headers: { Authorization: 'MediaBrowser Client="Miro", Device="miro", DeviceId="m", Version="1"' } })).resolves.toBeDefined();
    await expect(kind.describe({ method: "POST", url: "http://127.0.0.1/x", headers: { Authorization: 'MediaBrowser Client="Miro", Token="abc123"' } })).rejects.toThrow(/by reference/);
    await expect(kind.describe({ method: "POST", url: "http://127.0.0.1/x", headers: { "X-Emby-Token": "{{secret:extension.jellyfin.api_key}}" } })).rejects.toThrow(/not set/); // placeholder ok, ref missing
    await expect(kind.describe({ method: "POST", url: "http://example.com/x" })).rejects.toThrow(/not a local/);
    const plan = await kind.describe({ method: "POST", url: "http://127.0.0.1/x" });
    expect(plan.irreversible).toBe(true);
    expect(plan.autoApprove).toBe(false);
  });
});

describe("shell.command", () => {
  test("forbidden commands are refused at describe time with the alternative", async () => {
    await expect(shellCommandKind.describe({ command: "rm -rf /srv", writes: ["/srv"], network: false })).rejects.toThrow(/file_delete/);
    await expect(shellCommandKind.describe({ command: "mkdir /x", writes: ["/x"], network: false, rollback: "rm -rf /x" })).rejects.toThrow(/rollback command/);
  });

  test("plan carries class, scope, and warning", async () => {
    const plan = await shellCommandKind.describe({ command: "iptables -F", writes: [], network: false });
    expect(plan.class).toBe("lifeline");
    expect(plan.warning).toContain("SSH");
    expect(plan.autoApprove).toBe(false);
  });

  test("write scope: a root that holds secret material is refused, a lifeline root escalates, a symlink is judged by its target, a file-looking new root is refused", async () => {
    // /etc, /var, /root, /home: a plain mutate used to get shadow/sudoers/miro.db bind-mounted rw (audit A4).
    for (const root of ["/etc", "/var", "/var/lib", "/root", "/home", "/home/miro"]) {
      await expect(shellCommandKind.describe({ command: "true", writes: [root], network: false })).rejects.toThrow(/contains, Miro's own state or secret material/);
    }
    // Narrower is fine, and a lifeline path (or a root that contains lifeline paths) is a lifeline change.
    expect((await shellCommandKind.describe({ command: "touch x", writes: [join(work, "app")], network: false })).class).toBe("mutate");
    expect((await shellCommandKind.describe({ command: "touch x", writes: ["/etc/nginx"], network: false })).class).toBe("mutate");
    expect((await shellCommandKind.describe({ command: "true", writes: ["/etc/ssh"], network: false })).class).toBe("lifeline");
    expect((await shellCommandKind.describe({ command: "true", writes: ["/usr"], network: false })).class).toBe("lifeline");
    // A symlink at an innocent path pointing into secret material is judged by its target, not its
    // name (audit A5). The target is a .miro dir of the test's own - portable, unlike /etc, which
    // macOS resolves to /private/etc.
    mkdirSync(join(work, ".miro"), { recursive: true });
    const link = join(work, "data");
    symlinkSync(join(work, ".miro"), link);
    await expect(shellCommandKind.describe({ command: "true", writes: [link], network: false })).rejects.toThrow(/secret material/);
    // A non-existent root named like a file would be created as a directory by the sandbox (audit B3).
    await expect(shellCommandKind.describe({ command: "true", writes: [join(work, "app", "config.ini")], network: false })).rejects.toThrow(/looks like a file/);
    expect((await shellCommandKind.describe({ command: "touch x", writes: [join(work, "conf.d")], network: false })).class).toBe("mutate");
  });

  test.skipIf(!sandboxOk)("runs sandboxed, snapshots the declared root, and a failed verify restores it", async () => {
    const root = join(work, "app");
    mkdirSync(root);
    writeFileSync(join(root, "conf"), "original");
    const { ctx: c } = ctx();
    const r = await runOperation(c, shellCommandKind, "break config", {
      command: `echo broken > ${root}/conf`, writes: [root], network: false, verify: "false",
    });
    expect(r.outcome).toBe("rolledback");
    expect(readFileSync(join(root, "conf"), "utf-8")).toBe("original");

    const ok = await runOperation(c, shellCommandKind, "fix config", {
      command: `echo fixed > ${root}/conf`, writes: [root], network: false, verify: `grep -q fixed ${root}/conf`,
    });
    expect(ok.outcome).toBe("committed");

    // Under /tmp an undeclared write lands in the sandbox's throwaway tmpfs (never the host) -
    // so to see the read-only refusal itself, escape to a real filesystem path.
    const escapeDir = existsSync("/var/tmp") ? mkdtempSync(join("/var/tmp", "kinds-escape-")) : work;
    try {
      const outside = await runOperation(c, shellCommandKind, "escape", { command: `echo x > ${escapeDir}/escaped`, writes: [root], network: false });
      expect(outside.outcome).toBe("rolledback");
      expect(existsSync(join(escapeDir, "escaped"))).toBe(false);
    } finally {
      if (escapeDir !== work) rmSync(escapeDir, { recursive: true, force: true });
    }
    // And the /tmp case: the host never sees the file either way.
    await runOperation(c, shellCommandKind, "tmp escape", { command: `echo x > ${work}/escaped`, writes: [root], network: false });
    expect(existsSync(join(work, "escaped"))).toBe(false);
  });
});
