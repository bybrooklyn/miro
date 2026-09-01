import iroh from "@number0/iroh";
import { IROH_ALPN, alpnBytes } from "@miro/protocol";

const { Endpoint, EndpointTicket } = iroh;
const ALPN = alpnBytes(IROH_ALPN);

/** Dials a remote mirod via an Iroh ticket (plan §54 Stage A). Shaped like Bun.connect's result
 * — only `.write()`/`.end()` are used by useMiroConnection, same as the local unix-socket path. */
export async function dialIrohTicket(ticket: string, onData: (chunk: Buffer) => void) {
  const b = Endpoint.builder();
  b.applyN0(); // relay + discovery — this is a real remote connection, not a local test
  const ep = await b.bind();
  const addr = EndpointTicket.fromString(ticket).endpointAddr();
  const conn = await ep.connect(addr, ALPN);
  const bi = await conn.openBi();

  (async () => {
    for (;;) {
      const chunk = await bi.recv.read(65536);
      if (!chunk || chunk.length === 0) break;
      onData(Buffer.from(chunk));
    }
  })().catch(() => {});

  return {
    write: (line: string) => {
      bi.send.writeAll(alpnBytes(line)).catch((err) => console.error("[miro] iroh write failed", err));
    },
    end: () => {
      bi.send.finish().catch(() => {});
      ep.close().catch(() => {});
    },
  };
}
