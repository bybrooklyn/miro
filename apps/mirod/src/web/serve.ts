import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerEvent } from "@miro/protocol";
import { encodeLine } from "@miro/protocol";
import { authenticateDevice, redeemPairingCode, type Device } from "../devices/store";

// The web spine (PLAN.md deploy-anywhere PR 3a): mirod serves the React renderer and bridges a
// WebSocket to the very same protocol the terminal client speaks. Nothing about the agent, the
// operations or the transcript is re-implemented here - the browser is another client.
//
// Auth is the device tokens from PR 2, in an HttpOnly cookie so page scripts cannot read one: a browser
// redeems a pairing code once, then reconnects on its own. There is no session state beyond the cookie.

export const WEB_ENABLED = "web.enabled";
export const WEB_PORT = "web.port";
export const WEB_HOST = "web.host";
export const WEB_CERT = "web.cert";
export const WEB_KEY = "web.key";
export const DEFAULT_WEB_PORT = 4280;

const COOKIE = "miro_token";

/** The seam the daemon fills in: a browser session becomes an ordinary connection state, exactly like a
 * socket or Iroh one, so the agent side cannot tell the difference. */
export interface WebDeps {
  db: Database;
  /** Build a connection whose events go to `send`; returns the same handle the other transports use. */
  createConnection: (send: (event: ServerEvent) => void) => { feed: (chunk: Buffer) => void };
  /** Tear one down (settles pending questions, deregisters from the notification broadcast). */
  closeConnection: (conn: { feed: (chunk: Buffer) => void }) => void;
  /** Absolute path to the web app's index.html. */
  indexHtml: string;
  /** Absolute path to the web app's entry module, bundled on first request. */
  entry: string;
}

export interface WebConfig {
  port: number;
  hostname: string;
  tls?: { cert: string; key: string };
}

/** Read the browser's token from the Cookie header. Deliberately tolerant of ordering and spacing, and
 * of other cookies being present, but never of a token in a query string: a URL lands in logs and
 * browser history, a cookie does not. */
export function tokenFromCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE && rest.length > 0) {
      const v = rest.join("=").trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

function cookieFor(token: string, secure: boolean): string {
  // A year: the token is revocable server-side, so its lifetime is the owner's decision, not a timer's.
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=31536000"];
  if (secure) attrs.push("Secure");
  return `${COOKIE}=${token}; ${attrs.join("; ")}`;
}

/** Bundle the web app for the browser. Done on first request rather than at boot so a daemon nobody
 * browses pays nothing, and cached after: the bundle only changes when the version does.
 *
 * A subprocess with the app's own directory as cwd, not the in-process `Bun.build`, because the bundler
 * anchors bare-specifier resolution on the CWD - and the daemon's cwd is apps/mirod, where `react` and
 * `@miro/ui-model` are not resolvable. Found while testing: in-process builds failed with "Could not
 * resolve react" while the identical build from apps/web succeeded. */
async function buildApp(entry: string): Promise<{ ok: true; js: string } | { ok: false; error: string }> {
  const appDir = dirname(dirname(entry)); // <app>/src/main.tsx -> <app>
  const outDir = join(tmpdir(), `miro-web-build-${process.pid}`);
  const proc = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--minify", "--outdir", outDir], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) return { ok: false, error: err.trim() || `the bundler exited ${code}` };
  try {
    const js = await Bun.file(join(outDir, "main.js")).text();
    return { ok: true, js };
  } catch (e) {
    return { ok: false, error: `the bundler produced no output (${e instanceof Error ? e.message : e})` };
  }
}

export interface WebServerHandle {
  port: number;
  hostname: string;
  tls: boolean;
  stop: () => void;
}

export function startWebServer(deps: WebDeps, config: WebConfig): WebServerHandle {
  let bundle: Promise<{ ok: true; js: string } | { ok: false; error: string }> | null = null;
  const secure = Boolean(config.tls);

  const server = Bun.serve<{ conn: { feed: (chunk: Buffer) => void } | null; device: Device }, never>({
    port: config.port,
    hostname: config.hostname,
    ...(config.tls ? { tls: { cert: config.tls.cert, key: config.tls.key } } : {}),
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const device = authenticateDevice(deps.db, tokenFromCookie(req.headers.get("cookie")) ?? "");
        if (!device) return new Response("pair first", { status: 401 });
        // `data` rides along to the socket handlers - the device is resolved once, at upgrade.
        if (server.upgrade(req, { data: { conn: null, device } })) return undefined as unknown as Response;
        return new Response("expected a websocket upgrade", { status: 400 });
      }

      if (url.pathname === "/api/session") {
        const device = authenticateDevice(deps.db, tokenFromCookie(req.headers.get("cookie")) ?? "");
        return Response.json({ authenticated: device !== null, deviceName: device?.name });
      }

      if (url.pathname === "/api/pair" && req.method === "POST") {
        let body: { code?: unknown; deviceName?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "malformed request" }, { status: 400 });
        }
        const code = typeof body.code === "string" ? body.code : "";
        const name = typeof body.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim() : "browser";
        const res = redeemPairingCode(deps.db, code, name, "web");
        if ("error" in res) {
          const why = { unknown: "no such pairing code", expired: "that pairing code has expired", used: "that pairing code was already used" }[res.error];
          // 403, not 401: the request was understood and refused. Same wording the Iroh path uses.
          return Response.json({ ok: false, error: why }, { status: 403 });
        }
        return Response.json(
          { ok: true, deviceId: res.device.id, deviceName: res.device.name },
          { headers: { "set-cookie": cookieFor(res.token, secure) } },
        );
      }

      if (url.pathname === "/app.js") {
        bundle ??= buildApp(deps.entry);
        const built = await bundle;
        if (!built.ok) {
          bundle = null; // let the next request retry rather than caching a failure forever
          return new Response(`console.error(${JSON.stringify(`Miro web bundle failed to build:\n${built.error}`)})`, {
            status: 500,
            headers: { "content-type": "application/javascript; charset=utf-8" },
          });
        }
        return new Response(built.js, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      }

      // Everything else is the app shell: the browser routes, not the server.
      try {
        return new Response(readFileSync(deps.indexHtml), { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("the web app is not present in this installation", { status: 500 });
      }
    },
    websocket: {
      open(ws) {
        ws.data.conn = deps.createConnection((event) => {
          try {
            ws.send(encodeLine(event));
          } catch {
            // a closing socket is not an error worth taking the daemon down for
          }
        });
        console.log(`[mirod] web client connected: ${ws.data.device.name} (${ws.data.device.id})`);
      },
      message(ws, message) {
        ws.data.conn?.feed(Buffer.from(message as string | Uint8Array));
      },
      close(ws) {
        if (ws.data.conn) deps.closeConnection(ws.data.conn);
        ws.data.conn = null;
      },
    },
  });

  return {
    // Bun types the port as optionally undefined (a unix-socket server has none); this one always binds
    // a TCP port, and a caller printing "undefined" in a URL would be worse than a fallback.
    port: server.port ?? config.port,
    hostname: config.hostname,
    tls: secure,
    stop: () => server.stop(true),
  };
}

/** Resolve the configured server from settings, or null when the web UI is off. */
export function webConfigFrom(getSetting: (k: string) => string | null): WebConfig | null {
  if (getSetting(WEB_ENABLED) !== "true") return null;
  const port = Number(getSetting(WEB_PORT) ?? DEFAULT_WEB_PORT);
  const certPath = getSetting(WEB_CERT);
  const keyPath = getSetting(WEB_KEY);
  let tls: { cert: string; key: string } | undefined;
  if (certPath && keyPath) {
    try {
      tls = { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
    } catch (err) {
      // Serving plaintext because a cert path is wrong would be a silent downgrade - say it loudly and
      // keep serving, since the alternative is no web UI at all on a box the owner just configured.
      console.warn(`[mirod] web TLS disabled: cannot read ${certPath}/${keyPath} (${err instanceof Error ? err.message : err})`);
    }
  }
  return {
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_WEB_PORT,
    hostname: getSetting(WEB_HOST) ?? "0.0.0.0",
    tls,
  };
}
