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
          close() {},
          error() {},
        },
      });
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`could not connect to mirod at ${resolveSocketPath()}`);
}

/** Connects to mirod and returns a `send` function. Calls onEvent for each server event.
 * Set MIRO_TICKET to dial a remote daemon via Iroh instead of the local unix socket. */
export function useMiroConnection(onEvent: (event: ServerEvent) => void) {
  const socketRef = useRef<MiroTransport | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    const feed = createLineBuffer((line) => onEventRef.current(JSON.parse(line) as ServerEvent));

    const ticket = process.env.MIRO_TICKET;
    const connect = ticket ? dialIrohTicket(ticket, feed) : connectWithRetry(feed);

    connect
      .then((socket) => {
        if (cancelled) {
          socket.end();
          return;
        }
        socketRef.current = socket;
      })
      .catch((err) => console.error("[miro]", err.message));

    return () => {
      cancelled = true;
      socketRef.current?.end();
    };
  }, []);

  return (msg: ClientMessage) => socketRef.current?.write(encodeLine(msg));
}
