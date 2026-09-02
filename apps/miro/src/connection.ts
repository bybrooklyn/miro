import { useEffect, useRef } from "react";
import {
  resolveSocketPath,
  encodeLine,
  createLineBuffer,
  type ClientMessage,
  type ServerEvent,
} from "@miro/protocol";
import { dialIrohTicket } from "./iroh-connect";

/** Only `.write()`/`.end()` are ever called on the connection — satisfied by both Bun.connect's
 * unix-socket result and dialIrohTicket's remote Iroh result. */
interface MiroTransport {
  write(data: string): unknown;
  end(): unknown;
}

async function connectWithRetry(
  feedChunk: (chunk: Buffer) => void,
  onClose: () => void,
  maxAttempts = 20,
  delayMs = 150,
): Promise<MiroTransport> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await Bun.connect({
        unix: resolveSocketPath(),
        socket: {
          open() {},
          data(_socket, chunk) {
            feedChunk(chunk);
          },
          close() {
            onClose();
          },
          error() {
            onClose();
          },
        },
      });
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`could not connect to mirod at ${resolveSocketPath()}`);
}

/** Connects to mirod and returns a `send` function. Calls onEvent for each server event.
 * Set MIRO_TICKET to dial a remote daemon via Iroh instead of the local unix socket.
 * Reconnects automatically when the daemon restarts (routine: hot-load, deploy) — otherwise a
 * dropped socket would leave the TUI showing a stale "healthy" forever (audit U4). */
export function useMiroConnection(onEvent: (event: ServerEvent) => void) {
  const socketRef = useRef<MiroTransport | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const lastServerRef = useRef("home");

  useEffect(() => {
    let cancelled = false;

    const emit = (event: ServerEvent) => {
      if (event.type === "status") lastServerRef.current = event.server;
      onEventRef.current(event);
    };
    // One bad line (a torn frame on the remote path, a version mismatch) must degrade to a dropped
    // line, never an uncaught throw inside the socket data callback that takes down the TUI (U5).
    const feed = createLineBuffer((line) => {
      try {
        emit(JSON.parse(line) as ServerEvent);
      } catch (err) {
        console.error("[miro] dropping unparseable line:", (err as Error).message);
      }
    });

    const ticket = process.env.MIRO_TICKET;

    const establish = () => {
      if (cancelled) return;
      const connect = ticket ? dialIrohTicket(ticket, feed) : connectWithRetry(feed, onClose);
      connect
        .then((socket) => {
          if (cancelled) {
            socket.end();
            return;
          }
          socketRef.current = socket;
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[miro]", err.message);
          onClose(); // exhausted retries — flag disconnected and try the whole cycle again
        });
    };

    const onClose = () => {
      if (cancelled) return;
      socketRef.current = null;
      emit({ type: "status", server: lastServerRef.current, health: "connecting" });
      setTimeout(establish, 300); // brief backoff before re-dialing a restarting daemon
    };

    establish();

    return () => {
      cancelled = true;
      socketRef.current?.end();
    };
  }, []);

  return (msg: ClientMessage) => socketRef.current?.write(encodeLine(msg));
}
