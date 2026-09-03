import { test, expect } from "bun:test";
import type { ServerEvent } from "@miro/protocol";
import { initialState, reduce, userSent, answered, keyToAnswer, footerHints, secondsLeft, isQuiet, type Block } from "./index";

// Drives the reducer with the event sequence a real "set up jellyfin" turn produces (shape taken
// from the live acceptance run on the dev VM), asserting the transcript a renderer would draw.

function run(events: ServerEvent[], start = initialState(), t0 = 1_000) {
  let s = start;
  let t = t0;
  for (const e of events) s = reduce(s, e, (t += 100));
  return s;
}

const T = 1_000;

test("status fills the status line", () => {
  const s = reduce(initialState(), { type: "status", server: "home", health: "healthy", model: "gpt-5.6-luna", privilege: "root" }, T);
  expect(s).toMatchObject({ server: "home", health: "healthy", model: "gpt-5.6-luna", privilege: "root" });
});

test("a turn: user → tool tree (nested learn) → streamed reply", () => {
  let s = userSent(initialState(), "can you set up jellyfin", T);
  expect(s.working).toBe(true);
  expect(s.blocks[0]).toMatchObject({ kind: "user", text: "can you set up jellyfin" });

  s = run(
    [
      { type: "activity", id: "t1", label: "Host info", status: "running" },
      { type: "activity", id: "t1", label: "Host info", status: "done", detail: "Debian 13" },
      { type: "activity", id: "t2", label: "Learn app", status: "running" },
      { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "running" },
      { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "done" },
      { type: "activity", id: "t2b", parentId: "t2", label: "Learn another app", status: "running" },
      { type: "activity", id: "t2b1", parentId: "t2b", label: "HTTP GET", status: "running" },
    ],
    s,
  );
  const [, host, learn] = s.blocks as Extract<Block, { kind: "activity" }>[];
  expect(host.node).toMatchObject({ label: "Host info", status: "done", detail: "Debian 13" });
  expect(isQuiet(host.node)).toBe(true);
  expect(learn.node.children.map((c) => c.label)).toEqual(["Web search", "Learn another app"]);
  expect(learn.node.children[1].children[0]).toMatchObject({ label: "HTTP GET", status: "running" });
  expect(isQuiet(learn.node)).toBe(false); // still running - shown

  s = run(
    [
      { type: "activity", id: "t2b1", parentId: "t2b", label: "HTTP GET", status: "failed", detail: "404" },
      { type: "activity", id: "t2b", parentId: "t2", label: "Learn another app", status: "done" },
      { type: "activity", id: "t2", label: "Learn app", status: "done" },
      { type: "reply_delta", text: "Jellyfin is " },
      { type: "reply_delta", text: "installed and healthy." },
    ],
    s,
  );
  const learnDone = s.blocks[2] as Extract<Block, { kind: "activity" }>;
  expect(isQuiet(learnDone.node)).toBe(false); // a failed descendant keeps it visible
  const streaming = s.blocks[3] as Extract<Block, { kind: "assistant" }>;
  expect(streaming).toMatchObject({ kind: "assistant", text: "Jellyfin is installed and healthy.", streaming: true });

  s = reduce(s, { type: "reply", text: "Jellyfin is installed and healthy." }, T);
  expect(s.blocks[3]).toMatchObject({ kind: "assistant", text: "Jellyfin is installed and healthy.", streaming: false });
  expect(s.working).toBe(false);
  expect(s.blocks.length).toBe(4); // the final reply did not add a second assistant block
});

test("a tool call closes a streaming assistant block; the next delta opens a new one", () => {
  let s = run([
    { type: "reply_delta", text: "Checking…" },
    { type: "activity", id: "t1", label: "List containers", status: "running" },
    { type: "activity", id: "t1", label: "List containers", status: "done" },
    { type: "reply_delta", text: "Found one." },
    { type: "reply", text: "Found one." },
  ]);
  expect(s.blocks.map((b) => b.kind)).toEqual(["assistant", "activity", "assistant"]);
  expect((s.blocks[0] as Extract<Block, { kind: "assistant" }>).streaming).toBe(false);
  // The two assistant blocks must have distinct ids (audit U3 - a reused key collides in React).
  const ids = s.blocks.filter((b) => b.kind === "assistant").map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a second question does not drop the first; both are answered in turn (audit U1)", () => {
  let s = reduce(initialState(), { type: "question", id: "lifeline_confirm:o1", prompt: "still there?", options: [{ label: "keep", value: "keep" }, { label: "roll back", value: "rollback" }], timeoutMs: 90_000 }, T);
  s = reduce(s, { type: "question", id: "op_confirm:o2", prompt: "approve?", options: [{ label: "approve", value: "approve" }, { label: "cancel", value: "cancel" }] }, T);
  expect(s.pending?.id).toBe("lifeline_confirm:o1"); // the first still shows
  expect(s.pendingQueue.map((p) => p.id)).toEqual(["op_confirm:o2"]);
  s = answered(s, "lifeline_confirm:o1", "keep");
  expect(s.pending?.id).toBe("op_confirm:o2"); // the queued one is promoted
  expect(s.pendingQueue).toEqual([]);
  s = answered(s, "op_confirm:o2", "approve");
  expect(s.pending).toBeNull();
});

test("an operation result clears a still-open prompt that decided it (audit U7)", () => {
  let s = reduce(initialState(), { type: "question", id: "lifeline_confirm:o9", prompt: "still there?", options: [{ label: "keep", value: "keep" }, { label: "roll back", value: "rollback" }], timeoutMs: 90_000 }, T);
  s = reduce(s, { type: "operation_plan", id: "o9", plan: { summary: "ufw" } } as unknown as ServerEvent, T);
  s = reduce(s, { type: "operation_result", id: "o9", outcome: "rolledback", message: "reverted on timeout" }, T);
  expect(s.pending).toBeNull(); // the auto-resolved lifeline prompt is gone
});

test("system plan → question → answer records the decision on the plan block", () => {
  const plan: ServerEvent = { type: "system_plan", id: "p1", title: "Set up Jellyfin", findings: ["running"], components: [{ name: "jellyfin", action: "configure", detail: "wizard" }], steps: ["a"], verification: ["b"] };
  let s = run([plan, { type: "question", id: "plan_confirm:p1", prompt: "Approve this plan?", options: [{ label: "Approve", value: "approve" }, { label: "Change something", value: "change" }, { label: "Cancel", value: "cancel" }] }]);
  expect(s.pending).toMatchObject({ type: "question", kind: "plan_confirm", blockId: "p1" });
  expect(keyToAnswer(s.pending, "a")).toBe("approve");
  expect(keyToAnswer(s.pending, "c")).toBe("change");
  expect(keyToAnswer(s.pending, "x")).toBe("cancel");
  expect(keyToAnswer(s.pending, "2")).toBe("change");
  expect(footerHints(s).map((h) => h.key)).toEqual(["a", "c", "x"]);
  s = answered(s, "plan_confirm:p1", "approve");
  expect(s.pending).toBeNull();
  expect(s.blocks[0]).toMatchObject({ kind: "plan", decision: "approved" });
});

test("operation card: plan → confirm → progress → result", () => {
  let s = run([
    { type: "operation_plan", id: "o1", goal: "write config", summary: "Overwrite /opt/x", autoApprove: false, details: { class: "mutate", writes: ["/opt"], network: false } },
    { type: "question", id: "op_confirm:o1", prompt: "Approve: Overwrite /opt/x?", options: [{ label: "Approve", value: "approve" }, { label: "Cancel", value: "cancel" }] },
  ]);
  expect(s.pending).toMatchObject({ kind: "op_confirm", blockId: "o1" });
  expect(keyToAnswer(s.pending, "y")).toBe("approve");
  expect(keyToAnswer(s.pending, "n")).toBe("cancel");
  s = answered(s, "op_confirm:o1", "approve");
  s = run(
    [
      { type: "operation_progress", id: "o1", phase: "capturing" },
      { type: "operation_progress", id: "o1", phase: "applying" },
      { type: "operation_progress", id: "o1", phase: "verifying" },
      { type: "operation_result", id: "o1", outcome: "committed", message: "Done - write config, verified." },
    ],
    s,
  );
  expect(s.blocks[0]).toMatchObject({ kind: "operation", phase: undefined, result: { outcome: "committed" } });
});

test("lifeline question carries a countdown and k/r keys", () => {
  const s = reduce(initialState(), { type: "question", id: "lifeline_confirm:o9", prompt: "still connected?", options: [{ label: "Still here - keep it", value: "keep" }, { label: "Roll back", value: "rollback" }], timeoutMs: 90_000 }, T);
  expect(secondsLeft(s.pending, T + 30_000)).toBe(60);
  expect(keyToAnswer(s.pending, "k")).toBe("keep");
  expect(keyToAnswer(s.pending, "r")).toBe("rollback");
  expect(keyToAnswer(s.pending, "return")).toBe("keep");
  expect(footerHints(s).map((h) => h.key)).toEqual(["k", "r"]);
});

test("free-text and secret prompts, notices", () => {
  let s = reduce(initialState(), { type: "question", id: "ask:1", prompt: "Where is media?", options: [] }, T);
  expect(s.pending).toMatchObject({ kind: "ask", options: [] });
  expect(keyToAnswer(s.pending, "a")).toBeNull(); // free text - keys don't answer
  expect(footerHints(s)[0].label).toBe("send");
  s = answered(s, "ask:1", "/srv/media");
  s = reduce(s, { type: "secret_prompt", id: "ask:2", prompt: "VPN password" }, T);
  expect(s.pending).toMatchObject({ type: "secret" });
  s = answered(s, "ask:2", "");
  s = reduce(s, { type: "notice", level: "credential", text: "Created admin password - value: abc" }, T);
  expect(s.blocks.at(-1)).toMatchObject({ kind: "notice", level: "credential" });
});

test("an activity for an unknown parent still shows, at top level", () => {
  const s = reduce(initialState(), { type: "activity", id: "z", parentId: "missing", label: "Late join", status: "running" }, T);
  expect(s.blocks[0]).toMatchObject({ kind: "activity", node: { label: "Late join" } });
});
