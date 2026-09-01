import { test, expect } from "bun:test";
import { probePort } from "./reachability";

test("probePort finds a real listener reachable", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open(socket) { socket.end(); }, data() {}, close() {}, error() {} },
  });
  try {
    expect(await probePort("127.0.0.1", server.port, 1000)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("probePort reports false for a port nothing is listening on", async () => {
  // Bind and immediately release a port so we know nothing else grabbed it, then probe it.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  const freePort = server.port;
  server.stop(true);

  expect(await probePort("127.0.0.1", freePort, 300)).toBe(false);
});
