import iroh from "@number0/iroh";
import { IROH_ALPN, utf8Bytes, createLineBuffer, encodeLine, MIRO_DIR, type ServerEvent } from "@miro/protocol";
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { Endpoint, EndpointTicket } = iroh;
const ALPN = utf8Bytes(IROH_ALPN);

// ONE endpoint per process, never closed. `ep.close()` panics the iroh addon on teardown
// ("iroh-js/src/endpoint.rs:853: failed to delete napi ref" -> abort), which crashed the TUI on quit
// and once per reconnect - found live while testing pairing. Reusing a single endpoint also means a
// reconnect no longer builds (and leaks) another one; the OS reclaims it at exit.
let sharedEndpoint: Promise<Awaited<ReturnType<typeof bindEndpoint>>> | null = null;
function bindEndpoint() {
  const b = Endpoint.builder();
  b.applyN0(); // relay + discovery - this is a real remote connection, not a local test
  return b.bind();
}
function endpoint() {
  if (!sharedEndpoint) sharedEndpoint = bindEndpoint();
  return sharedEndpoint;
}

/** A remote daemon refused this device. Retrying cannot help - a revoked token stays revoked and a
 * spent code stays spent - so the caller reports it instead of reconnecting in a loop. */
export class MiroAuthError extends Error {}

/** Where a device keeps the tokens it has been issued, one per daemon (keyed by NodeId). 0600: it is
 * this device's credential, and the whole point of per-device tokens is that losing one is survivable. */
const devicesFile = () => join(MIRO_DIR, "devices.json");

type DeviceTokens = Record<string, { token: string; deviceId?: string; name?: string }>;

function readTokens(): DeviceTokens {
  try {
    return JSON.parse(readFileSync(devicesFile(), "utf8")) as DeviceTokens;
  } catch {
    return {};
  }
}

function saveToken(nodeId: string, entry: { token: string; deviceId?: string; name?: string }): void {
  const all = readTokens();
  all[nodeId] = entry;
  mkdirSync(MIRO_DIR, { recursive: true });
  writeFileSync(devicesFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export interface ParsedInvite {
  ticket: string;
  /** Present when the string was a pairing invite rather than a bare ticket. */
  code?: string;
}

/** MIRO_TICKET accepts either a bare Iroh ticket (a device that already holds a token) or the base64url
 * invite `/pair` prints, which carries the ticket plus a single-use code. One env var either way: the
 * person pasting it should not have to know which kind they were given. */
export function parseTicketOrInvite(raw: string): ParsedInvite {
  const s = raw.trim();
  try {
    const decoded = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as { v?: number; ticket?: string; code?: string };
    if (decoded && typeof decoded.ticket === "string" && decoded.ticket.length > 0) {
      return { ticket: decoded.ticket, code: typeof decoded.code === "string" ? decoded.code : undefined };
    }
  } catch {
    // not an invite - fall through to treating it as a plain ticket
  }
  return { ticket: s };
}

/** Dials a remote mirod via an Iroh ticket or a pairing invite (plan §54 Stage A; pairing per the
 * deploy-anywhere slice). Shaped like Bun.connect's result - only `.write()`/`.end()` are used by
 * useMiroConnection, same as the local unix-socket path. `onClose` fires once when the read loop ends
 * (EOF or error), so the remote path reconnects and shows "connecting" like the local one - it used to
 * swallow the drop and sit on a stale "healthy" with a dead stream (audit #8).
 *
 * Authentication happens here, below the UI: the daemon serves nothing on a remote transport until the
 * device presents a token or redeems a code, and neither the view-model nor any renderer needs to know
 * that. A redeemed token is stored so the next run is a plain reconnect. */
export async function dialIrohTicket(rawTicket: string, onData: (chunk: Buffer) => void, onClose: () => void) {
  const { ticket, code } = parseTicketOrInvite(rawTicket);
  const ep = await endpoint();
  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const nodeId = addr.id().toString();
  const conn = await ep.connect(addr, ALPN);
  const bi = await conn.openBi();

  const write = (line: string) => {
    bi.send.writeAll(utf8Bytes(line)).catch((err) => console.error("[miro] iroh write failed", err));
  };

  let authed = false;
  // A holder rather than a bare `let`: TS narrows a closed-over variable assigned later to `never`.
  const hs: { settle: ((err?: Error) => void) | null } = { settle: null };
  const feed = createLineBuffer((line) => {
    if (authed) {
      // Re-frame the line for the caller's own line buffer: the transport stays a byte stream.
      onData(Buffer.from(`${line}\n`));
      return;
    }
    let ev: ServerEvent;
    try {
      ev = JSON.parse(line) as ServerEvent;
    } catch {
      return; // a torn pre-auth frame is not worth failing the handshake over
    }
    if (ev.type !== "pair_result") return; // the daemon sends nothing else before auth
    if (!ev.ok) {
      hs.settle?.(new MiroAuthError(ev.error ?? "the server refused this device"));
      return;
    }
    if (ev.token) saveToken(nodeId, { token: ev.token, deviceId: ev.deviceId, name: ev.deviceName });
    authed = true;
    hs.settle?.();
  });

  (async () => {
    try {
      for (;;) {
        const chunk = await bi.recv.read(65536);
        if (!chunk || chunk.length === 0) break;
        feed(Buffer.from(chunk));
      }
    } catch {
      // a torn stream ends the session like EOF does
    } finally {
      if (!authed) hs.settle?.(new MiroAuthError("the connection closed before this device was authenticated"));
      onClose();
    }
  })();

  const stored = readTokens()[nodeId]?.token;
  // A stored token wins over a code: re-running an invite that was already redeemed should just
  // reconnect, not fail on a spent code.
  if (stored) write(encodeLine({ type: "auth", token: stored }));
  else if (code) write(encodeLine({ type: "pair_redeem", code, deviceName: hostname() }));
  else throw new MiroAuthError("this device is not paired with that server - run /pair on the box and use the invite it prints");

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MiroAuthError("the server did not answer the pairing handshake")), 20_000);
    hs.settle = (err) => {
      clearTimeout(timer);
      hs.settle = null;
      if (err) reject(err);
      else resolve();
    };
  });

  return {
    write,
    end: () => {
      // Deliberately nothing. `bi.send.finish()` races a process that exits right after it and panics
      // the iroh addon ("failed to delete napi ref" -> abort), which is exactly what quitting the TUI
      // does - found live. Dropping the stream is enough: the daemon's read loop sees the connection
      // go and runs the same teardown it runs for any lost client.
    },
  };
}
