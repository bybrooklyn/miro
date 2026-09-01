import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
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
import { sandboxAvailable } from "../sandbox";
import { listTrash } from "../trash";

// Real engine, real filesystem, a real HTTP server — the kinds are exercised end to end through
// runOperation with an injected answer, exactly as engine.test.ts drives its fake kind.

const sandboxOk = await sandboxAvailable();

function ctx(answer = "approve"): { ctx: OperationToolContext; events: ServerEvent[] } {
  const db = new Database(":memory:");
  ensureOperationsTable(db);
  ensureMemoryTable(db);
  const events: ServerEvent[] = [];
  return { events, ctx: { db, send: (e) => events.push(e), waitForAnswer: async () => answer, getSecret: (ref) => (ref === "test.token" ? "s3cret" : null) } };
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
    for (const ok of ["http://127.0.0.1:8096/x", "http://localhost/x", "http://10.0.0.5/x", "http://192.168.1.2/x", "http://172.16.0.1/x", "http://jellyfin:8096/x", "http://nas.local/x", "http://[::1]/x"]) {
      expect(isLocalOrPrivateUrl(ok)).toBe(true);
    }
    for (const bad of ["http://example.com/x", "http://8.8.8.8/x", "http://172.32.0.1/x", "ftp://127.0.0.1/x", "not a url"]) {
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
        return new Response("?", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const kind = httpMutationKind((ref) => (ref === "test.token" ? "s3cret" : null));
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

    // Under /tmp an undeclared write lands in the sandbox's throwaway tmpfs (never the host) —
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
