import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerEvent } from "@miro/protocol";
import { configureNotifications, notify, noticeFor, reachesPhone, replayUndelivered, resetNotifications, channelStatus } from "./index";
import { listUndelivered } from "./store";

afterEach(() => resetNotifications());

// A test harness for the bus with a real :memory: db, an in-memory settings map, and a broadcast
// that records what it was handed and how many "clients" received it. No sinks are configured
// (getSetting returns null for notify.* keys), so no real HTTP is attempted - the phone fan-out is
// live-verified on the VM; here we prove persistence, broadcast, delivered-marking and replay.
function harness(connectedClients = 0) {
  const db = new Database(":memory:");
  const settings = new Map<string, string>();
  const sent: ServerEvent[] = [];
  configureNotifications({
    db,
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => void settings.set(k, v),
    getSecret: () => null,
    broadcast: (e) => {
      sent.push(e);
      return connectedClients;
    },
  });
  return { db, sent };
}

test("reachesPhone: only needs_attention", () => {
  expect(reachesPhone("needs_attention")).toBe(true);
  expect(reachesPhone("worth_knowing")).toBe(false);
  expect(reachesPhone("routine")).toBe(false);
});

test("noticeFor: tier maps to level, body joins under the title", () => {
  expect(noticeFor({ tier: "needs_attention", title: "T", body: "B" })).toEqual({ type: "notice", level: "warn", text: "T\nB" });
  expect(noticeFor({ tier: "worth_knowing", title: "T", body: "" })).toEqual({ type: "notice", level: "info", text: "T" });
});

test("notify persists and broadcasts; with a client connected the row is marked delivered", () => {
  const { db, sent } = harness(1);
  notify({ tier: "worth_knowing", title: "Reboot done", body: "", source: "reboot", at: 1000 });
  expect(sent).toHaveLength(1);
  expect(listUndelivered(db)).toHaveLength(0); // delivered to the connected client, not pending
});

test("notify with NO client connected leaves the row undelivered for replay", () => {
  const { db, sent } = harness(0);
  notify({ tier: "needs_attention", title: "Disk full", body: "/ 94%", source: "operation", at: 1000 });
  expect(sent).toHaveLength(1); // broadcast still called (0 recipients)
  const pending = listUndelivered(db);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.tuiDeliveredAt).toBeNull();
});

test("routine never broadcasts and never replays", () => {
  const { db, sent } = harness(1);
  notify({ tier: "routine", title: "reaped an idle host", body: "", source: "agent", at: 1000 });
  expect(sent).toHaveLength(0);
  expect(listUndelivered(db)).toHaveLength(0);
});

test("replayUndelivered delivers pending worth_knowing+ once, then marks them delivered", () => {
  const { db } = harness(0);
  notify({ tier: "worth_knowing", title: "one", body: "", source: "reboot", at: 1000 });
  notify({ tier: "needs_attention", title: "two", body: "", source: "repair", at: 2000 });
  const replayed: ServerEvent[] = [];
  replayUndelivered((e) => replayed.push(e));
  expect(replayed.map((e) => (e as { text: string }).text)).toEqual(["one", "two"]);
  expect(listUndelivered(db)).toHaveLength(0);
  const again: ServerEvent[] = [];
  replayUndelivered((e) => again.push(e));
  expect(again).toHaveLength(0); // one-shot: nothing replays twice
});

test("unconfigured: notify is a no-op, never a throw", () => {
  resetNotifications();
  expect(() => notify({ tier: "needs_attention", title: "x", body: "", source: "agent", at: 0 })).not.toThrow();
  expect(channelStatus()).toEqual([]);
});
