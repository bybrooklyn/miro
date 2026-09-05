import { test, expect } from "bun:test";
import irohPkg from "@number0/iroh";
import { encodeLine, createLineBuffer, IROH_ALPN, utf8Bytes, type ServerEvent } from "@miro/protocol";
import { generateIrohSecretKey, startIrohEndpoint, ticketFor, acceptLoop } from "./iroh";

const { EndpointTicket } = irohPkg;

// Real Iroh endpoints, no mocks - matches this repo's convention (see reachability.test.ts).
// Same-process/same-machine only proves the ticket/ALPN/wire-protocol glue is correct, not real
// NAT/relay traversal - that needs tools/dev-vm/ as a genuinely separate network endpoint.
test("a persistent Iroh connection survives multiple round trips", async () => {
  const server = await startIrohEndpoint(generateIrohSecretKey());
  const client = await startIrohEndpoint(generateIrohSecretKey());
  const ticket = ticketFor(server);

  const received: ServerEvent[] = [];

  acceptLoop(server, (conn) => {
    (async () => {
      const bi = await conn.acceptBi();
      const feed = createLineBuffer((line) => received.push(JSON.parse(line) as ServerEvent));
      for (let i = 0; i < 3; i++) {
        const chunk = await bi.recv.read(1024);
        feed(Buffer.from(chunk));
        await bi.send.writeAll(utf8Bytes(`ack${i}\n`));
      }
    })().catch(() => {});
  }).catch(() => {});

  // The client's 3rd ack only arrives after the server has already pushed its 3rd received
  // message (the send happens after the push) - so awaiting this alone is enough synchronization.
  const clientTurns = (async () => {
    const addr = EndpointTicket.fromString(ticket).endpointAddr();
    const conn = await client.connect(addr, utf8Bytes(IROH_ALPN));
    const bi = await conn.openBi();
    for (let i = 0; i < 3; i++) {
      await bi.send.writeAll(utf8Bytes(encodeLine({ type: "reply", text: `turn${i}` })));
      await bi.recv.read(1024);
    }
  })();

  await Promise.race([
    clientTurns,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 8000)),
  ]);

  expect(received).toEqual([
    { type: "reply", text: "turn0" },
    { type: "reply", text: "turn1" },
    { type: "reply", text: "turn2" },
  ]);

  await server.close();
  await client.close();
});
