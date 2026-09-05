import iroh, { type Connection, type Endpoint } from "@number0/iroh";
import { IROH_ALPN, alpnBytes } from "@miro/protocol";

const { SecretKey, EndpointTicket } = iroh;
const { Endpoint: EndpointClass } = iroh;
const ALPN = alpnBytes(IROH_ALPN);

export function generateIrohSecretKey(): number[] {
  return SecretKey.generate().toBytes();
}

export async function startIrohEndpoint(secretKeyBytes: number[]): Promise<Endpoint> {
  return EndpointClass.bind({ secretKey: secretKeyBytes, alpns: [ALPN] });
}

export function ticketFor(endpoint: Endpoint): string {
  return EndpointTicket.fromAddr(endpoint.addr()).toString();
}

/** The public NodeId alone - safe to log; the ticket (which grants access) is not. */
export function nodeIdOf(endpoint: Endpoint): string {
  return endpoint.addr().id().toString();
}

/** Runs until the endpoint is closed, handing each handshaked connection to onConnection. */
export async function acceptLoop(endpoint: Endpoint, onConnection: (conn: Connection) => void): Promise<void> {
  for (;;) {
    const incoming = await endpoint.acceptNext();
    if (!incoming) break;
    (async () => {
      const accepting = await incoming.accept();
      const conn = await accepting.connect();
      onConnection(conn);
    })().catch((err) => console.error("[mirod] iroh connection setup failed", err));
  }
}
