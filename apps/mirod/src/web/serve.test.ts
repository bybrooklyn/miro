import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { encodeLine, type ServerEvent } from "@miro/protocol";
import { ensureDevicesTable, mintPairingCode, createDevice, revokeDevice } from "../devices/store";
import { startWebServer, tokenFromCookie, webConfigFrom, DEFAULT_WEB_PORT, WEB_ENABLED, WEB_PORT, WEB_HOST } from "./serve";

// A real listener on a real port, real sqlite, a real browser-shaped WebSocket. The seam the daemon
// fills in (createConnection/closeConnection) is supplied here by a tiny real implementation - there is
// no agent in the loop, which is the point: this covers auth, routing and the bridge, nothing else.

const WEB = join(import.meta.dir, "../../../web");

function fixture() {
  const db = new Database(":memory:");
  ensureDevicesTable(db);
  const opened: { fed: string[]; closed: boolean }[] = [];
  const server = startWebServer(
    {
      db,
      createConnection: (send) => {
        const conn = { fed: [] as string[], closed: false };
        opened.push(conn);
        // Announce ourselves the way the daemon's real connection does, so a client sees a first event.
        send({ type: "status", server: "test-box", health: "healthy" } as ServerEvent);
        return {
          feed: (chunk: Buffer) => {
            conn.fed.push(chunk.toString());
          },
        };
      },
      closeConnection: () => {
        const last = opened[opened.length - 1];
        if (last) last.closed = true;
      },
      indexHtml: join(WEB, "index.html"),
      entry: join(WEB, "src/main.tsx"),
    },
    { port: 0, hostname: "127.0.0.1" },
  );
  return { db, server, opened, base: `http://127.0.0.1:${server.port}` };
}

test("tokenFromCookie finds the token among other cookies, and refuses nothing-there", () => {
  expect(tokenFromCookie("miro_token=abc123")).toBe("abc123");
  expect(tokenFromCookie("other=1; miro_token=abc123; another=2")).toBe("abc123");
  expect(tokenFromCookie("  miro_token = abc123  ")).toBe(null); // a space before "=" is not our cookie name
  expect(tokenFromCookie("other=1")).toBe(null);
  expect(tokenFromCookie("miro_token=")).toBe(null);
  expect(tokenFromCookie(null)).toBe(null);
  // A base64url token contains "=" padding in other encodings - must not be truncated.
  expect(tokenFromCookie("miro_token=a=b=c")).toBe("a=b=c");
});

test("an unpaired browser is told so, and cannot open the socket", async () => {
  const { server, base } = fixture();
  try {
    const session = await (await fetch(`${base}/api/session`)).json();
    expect(session).toEqual({ authenticated: false });

    const ws = await fetch(`${base}/ws`, { headers: { upgrade: "websocket" } });
    expect(ws.status).toBe(401);
  } finally {
    server.stop();
  }
});

test("a pairing code exchanges for a cookie, and the cookie then opens the socket", async () => {
  const { db, server, base, opened } = fixture();
  try {
    const code = mintPairingCode(db);
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "test browser" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deviceName: string };
    expect(body.ok).toBe(true);
    expect(body.deviceName).toBe("test browser");

    const setCookie = res.headers.get("set-cookie") ?? "";
    // HttpOnly is the point: a page script must never be able to read the token.
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure"); // plain http here; TLS adds it
    const cookie = setCookie.split(";")[0]!;

    expect(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).toMatchObject({ authenticated: true });

    // The real thing: a WebSocket carrying the cookie gets a bridged connection.
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { cookie } } as unknown as string[]);
    const firstEvent = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no event within 5s")), 5000);
      ws.onmessage = (e) => {
        clearTimeout(timer);
        resolve(String(e.data));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket error"));
      };
    });
    expect(JSON.parse(firstEvent.trim())).toMatchObject({ type: "status", server: "test-box" });

    // And a client message reaches the connection unchanged - the browser speaks the same protocol.
    ws.send(encodeLine({ type: "chat", text: "hello from a browser" }));
    await Bun.sleep(150);
    expect(opened[0]!.fed.join("")).toContain("hello from a browser");
    ws.close();
    await Bun.sleep(150);
    expect(opened[0]!.closed).toBe(true);
  } finally {
    server.stop();
  }
});

test("a used code, an unknown code and a revoked token are each refused", async () => {
  const { db, server, base } = fixture();
  try {
    expect((await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000000" }) })).status).toBe(403);

    const code = mintPairingCode(db);
    const first = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    expect(first.status).toBe(200);
    const replay = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    expect(replay.status).toBe(403);
    expect((await replay.json()) as { error: string }).toMatchObject({ error: "that pairing code was already used" });

    const { device, token } = createDevice(db, "phone", "web");
    const cookie = `miro_token=${token}`;
    expect(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).toMatchObject({ authenticated: true });
    revokeDevice(db, device.id);
    expect(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).toMatchObject({ authenticated: false });
    expect((await fetch(`${base}/ws`, { headers: { upgrade: "websocket", cookie } })).status).toBe(401);
  } finally {
    server.stop();
  }
});

test("the shell is served for any path, and the app really bundles for a browser", async () => {
  const { server, base } = fixture();
  try {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('src="/app.js"');
    // A deep link must serve the shell too: the browser routes, not the server.
    expect(await (await fetch(`${base}/anything/else`)).text()).toContain('<div id="root">');

    // The genuine bundle, built by the same code path a browser hits. Catches a broken import or a
    // renderer that cannot compile for the browser at all.
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js.length).toBeGreaterThan(10_000);
    expect(js).not.toContain("bundle failed to build");
    expect(js).toContain("miro_token" in {} ? "" : "root"); // mounts on #root
  } finally {
    server.stop();
  }
}, 30_000);

test("webConfigFrom is off unless enabled, and defaults the rest", () => {
  const off = webConfigFrom(() => null);
  expect(off).toBeNull();
  const on = webConfigFrom((k) => (k === WEB_ENABLED ? "true" : null));
  expect(on).toEqual({ port: DEFAULT_WEB_PORT, hostname: "0.0.0.0", tls: undefined });
  const custom = webConfigFrom((k) => (k === WEB_ENABLED ? "true" : k === WEB_PORT ? "9999" : k === WEB_HOST ? "127.0.0.1" : null));
  expect(custom).toMatchObject({ port: 9999, hostname: "127.0.0.1" });
  // A nonsense port falls back rather than binding something absurd.
  expect(webConfigFrom((k) => (k === WEB_ENABLED ? "true" : k === WEB_PORT ? "not-a-port" : null))?.port).toBe(DEFAULT_WEB_PORT);
});
