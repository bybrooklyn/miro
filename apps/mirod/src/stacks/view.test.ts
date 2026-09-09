import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStacksTable, upsertStack } from "./store";
import { stackLogs, stackSummaries, stripAnsi, MAX_LOG_LINES } from "./view";

// Real sqlite and real compose files on disk. Docker is not present on this dev machine, which is the
// interesting case as much as the happy one: the view must degrade to the registry rather than throw or
// claim everything is stopped when it simply cannot see.

function box() {
  const db = new Database(":memory:");
  ensureStacksTable(db);
  const dir = mkdtempSync(join(tmpdir(), "miro-stackview-"));
  return { db, dir };
}

function withCompose(dir: string, app: string, yaml: string) {
  const path = join(dir, `${app}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

test("an empty registry is an empty view, and never reports a problem it does not have", async () => {
  const { db } = box();
  expect(await stackSummaries(db)).toEqual({ stacks: [] });
});

test("a registered stack is listed with its declared service count", async () => {
  const { db, dir } = box();
  const composePath = withCompose(
    dir,
    "media",
    `services:
  jellyfin:
    image: jellyfin/jellyfin
  sonarr:
    image: linuxserver/sonarr
volumes:
  media: {}
`,
  );
  upsertStack(db, { app: "media", dir, composePath, status: "running", recipeId: null });
  const view = await stackSummaries(db);
  expect(view.stacks.length).toBe(1);
  const s = view.stacks[0]!;
  expect(s.app).toBe("media");
  expect(s.dir).toBe(dir);
  // Two services, and `volumes:` at the top level must not be counted as a third.
  if (!view.unavailable) expect(s.declared).toBe(2);
  // With no docker here, running is 0 - and that is reported without pretending to know more.
  expect(s.running).toBe(0);
});

test("a compose with no services block counts zero rather than guessing", async () => {
  const { db, dir } = box();
  const composePath = withCompose(dir, "weird", "name: nothing-here\n");
  upsertStack(db, { app: "weird", dir, composePath, status: "stopped", recipeId: null });
  const view = await stackSummaries(db);
  if (!view.unavailable) expect(view.stacks[0]!.declared).toBe(0);
  expect(view.stacks[0]!.status).toBe("stopped");
});

test("logs refuse an app Miro does not manage - the one place a client-supplied name reaches a path", async () => {
  const { db } = box();
  const res = await stackLogs(db, "../../etc/passwd");
  expect(res.lines).toEqual([]);
  expect(res.error).toContain("is not a stack Miro manages");
  // And an app that simply is not registered gets the same treatment, not an empty success.
  expect((await stackLogs(db, "nope")).error).toContain("not a stack Miro manages");
});

test("the log tail is bounded whatever a client asks for", async () => {
  const { db, dir } = box();
  const composePath = withCompose(dir, "app", "services:\n  a:\n    image: x\n");
  upsertStack(db, { app: "app", dir, composePath, status: "running", recipeId: null });
  // No docker on this machine, so this exercises the failure path; the point is that neither a huge
  // request nor a nonsense one throws.
  for (const lines of [1_000_000, -5, 0, Number.NaN]) {
    const res = await stackLogs(db, "app", lines);
    expect(Array.isArray(res.lines)).toBe(true);
    expect(res.lines.length).toBeLessThanOrEqual(MAX_LOG_LINES);
  }
});

test("log lines are stripped of the escape sequences compose emits even with --no-color", () => {
  // Exactly what came back from a real container: an erase-line sequence before the text. A terminal
  // swallows it; a browser prints it as garbage.
  const esc = String.fromCharCode(27);
  expect(stripAnsi(`${esc}[2Kwhoami-1 | 2026/09/09 16:20:13 Starting up on port 80`)).toBe(
    "whoami-1 | 2026/09/09 16:20:13 Starting up on port 80",
  );
  expect(stripAnsi(`${esc}[36mcoloured${esc}[0m`)).toBe("coloured");
  expect(stripAnsi("plain text")).toBe("plain text");
  // A bare escape char with no sequence after it must not swallow the rest of the line.
  expect(stripAnsi(`before${esc}after`)).toBe(`before${esc}after`);
});
