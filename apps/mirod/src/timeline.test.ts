import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureTimelineTable, recordEvent, queryEvents } from "./timeline";

test("recordEvent/queryEvents round-trip, newest first", () => {
  const db = new Database(":memory:");
  ensureTimelineTable(db);
  recordEvent(db, "docker", "jellyfin recreated");
  recordEvent(db, "docker", "gpu mapping disappeared");

  const events = queryEvents(db);
  expect(events).toHaveLength(2);
  expect(events[0].message).toBe("gpu mapping disappeared");
  expect(events[1].message).toBe("jellyfin recreated");
  expect(events[0].source).toBe("docker");
});
