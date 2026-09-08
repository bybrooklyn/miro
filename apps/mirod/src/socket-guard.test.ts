import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSocketLive } from "./socket-guard";

// Real unix sockets, real listener, real stale file - the distinction this makes is what stops a
// second mirod from stealing a running one's socket and leaving it dead.
const dir = () => mkdtempSync(join(tmpdir(), "miro-sockguard-"));

test("a socket with a live listener is reported live", async () => {
  const path = join(dir(), "live.sock");
  const server = Bun.listen({ unix: path, socket: { data: () => {}, open: () => {}, close: () => {} } });
  try {
    expect(await isSocketLive(path)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a socket file with nobody listening is not live (the stale-after-crash case)", async () => {
  const path = join(dir(), "stale.sock");
  // A plain file at the socket path: exactly what a killed daemon leaves behind, and what must be
  // unlinked rather than treated as an owner.
  writeFileSync(path, "");
  expect(await isSocketLive(path)).toBe(false);
});

test("a path that does not exist is not live", async () => {
  expect(await isSocketLive(join(dir(), "absent.sock"))).toBe(false);
});

test("a listener that has stopped is no longer live", async () => {
  const path = join(dir(), "gone.sock");
  const server = Bun.listen({ unix: path, socket: { data: () => {}, open: () => {}, close: () => {} } });
  expect(await isSocketLive(path)).toBe(true);
  server.stop(true);
  expect(await isSocketLive(path)).toBe(false);
});
