import iroh, { type Connection, type Endpoint } from "@number0/iroh";
import { IROH_ALPN, utf8Bytes } from "@miro/protocol";

const { SecretKey, EndpointTicket } = iroh;
const { Endpoint: EndpointClass } = iroh;
const ALPN = utf8Bytes(IROH_ALPN);

export function generateIrohSecretKey(): number[] {
  return SecretKey.generate().toBytes();
}

export async function startIrohEndpoint(secretKeyBytes: number[]): Promise<Endpoint> {
  return EndpointClass.bind({ secretKey: secretKeyBytes, alpns: [ALPN] });
}

/** Wait until the endpoint has a home relay, bounded. A ticket minted before then can lack a relay
 * URL, and a relay-only peer - anything in a browser, and any client that cannot hole-punch - then has
 * no way in at all. Bounded because the daemon must not hang on a slow or unreachable relay: a ticket
 * without one still works for a direct/hole-punched dial. */
export async function awaitRelay(endpoint: Endpoint, timeoutMs = 8_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([endpoint.online().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether the ticket this endpoint would mint carries a relay URL. */
export function hasRelay(endpoint: Endpoint): boolean {
  try {
    return endpoint.addr().relayUrl() !== null;
  } catch {
    return false;
  }
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
