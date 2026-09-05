import iroh from "@number0/iroh";
import { IROH_ALPN, utf8Bytes } from "@miro/protocol";

const { Endpoint, EndpointTicket } = iroh;
const ALPN = utf8Bytes(IROH_ALPN);

/** Dials a remote mirod via an Iroh ticket (plan §54 Stage A). Shaped like Bun.connect's result
 * - only `.write()`/`.end()` are used by useMiroConnection, same as the local unix-socket path.
 * `onClose` fires once when the read loop ends (EOF or error), so the remote path reconnects and
 * shows "connecting" like the local one - it used to swallow the drop and sit on a stale
 * "healthy" with a dead stream (audit #8). */
export async function dialIrohTicket(ticket: string, onData: (chunk: Buffer) => void, onClose: () => void) {
  const b = Endpoint.builder();
  b.applyN0(); // relay + discovery - this is a real remote connection, not a local test
  const ep = await b.bind();
  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const conn = await ep.connect(addr, ALPN);
  const bi = await conn.openBi();

  (async () => {
    try {
      for (;;) {
        const chunk = await bi.recv.read(65536);
        if (!chunk || chunk.length === 0) break;
        onData(Buffer.from(chunk));
      }
    } catch {
      // a torn stream ends the session like EOF does
    } finally {
      onClose();
    }
  })();

  return {
    write: (line: string) => {
      bi.send.writeAll(utf8Bytes(line)).catch((err) => console.error("[miro] iroh write failed", err));
    },
    end: () => {
      bi.send.finish().catch(() => {});
      ep.close().catch(() => {});
    },
  };
}
