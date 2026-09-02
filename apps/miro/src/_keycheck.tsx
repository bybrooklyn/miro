import { useRef } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ScrollBoxRenderable } from "@opentui/core";
import { initialState, reduce, userSent, type UiState } from "@miro/ui-model";
import { App } from "./App";
import { Transcript } from "./components/Transcript";

const out: string[] = [];
const settle = () => new Promise((r) => setTimeout(r, 120));

// ── 1. Short transcript: user block, live activity tree, streaming caret ──────────────────────
let s: UiState = userSent(initialState(), "can you set up jellyfin", 1000);
for (const e of [
  { type: "activity", id: "t1", label: "Host info", status: "done", detail: "Debian 13" },
  { type: "activity", id: "t2", label: "Learn app", status: "running" },
  { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "running" },
  { type: "reply_delta", text: "Jellyfin is installed" },
  { type: "notice", level: "info", text: "remembered: media lives on /srv/media" },
] as const) s = reduce(s, e, 1100);
// The first activity event has to arrive as "running" before it can be "done".
s = reduce(userSent(initialState(), "can you set up jellyfin", 1000), { type: "activity", id: "t1", label: "Host info", status: "running" }, 1010);
for (const e of [
  { type: "activity", id: "t1", label: "Host info", status: "done", detail: "Debian 13" },
  { type: "activity", id: "t2", label: "Learn app", status: "running" },
  { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "running" },
  { type: "reply_delta", text: "Jellyfin is installed" },
  { type: "notice", level: "info", text: "remembered: media lives on /srv/media" },
] as const) s = reduce(s, e, 1100);

let scroll: ScrollBoxRenderable | null = null;
function Probe({ state }: { state: UiState }) {
  const ref = useRef<ScrollBoxRenderable>(null);
  scroll = ref.current;
  return (
    <box flexDirection="column" width={90} height={12}>
      <Transcript blocks={state.blocks} scrollRef={ref} />
    </box>
  );
}

const short = await testRender(<Probe state={s} />, { width: 90, height: 12 });
await short.flush();
await settle();
await short.flush();
out.push("=== short transcript ===");
out.push(short.captureCharFrame());

// ── 2. Scroll mechanic: does assigning scrollTop detach and re-attach sticky-to-bottom? ───────
let many: UiState = initialState();
for (let i = 0; i < 60; i++) many = reduce(many, { type: "notice", level: "info", text: `line ${i}` }, 1000 + i);
const big = await testRender(<Probe state={many} />, { width: 90, height: 12 });
await big.flush();
await settle();
await big.flush();
const box = big.renderer.root.findDescendantById(scroll?.id ?? "") as ScrollBoxRenderable | undefined;
const target = box ?? scroll!;
const atBottom = target.scrollTop;
target.scrollTop -= 6;
await big.flush();
const afterUp = target.scrollTop;
out.push(`\n=== scroll ===\nsticky bottom scrollTop=${atBottom} (scrollHeight=${target.scrollHeight}, viewport=${target.viewport.height})`);
out.push(`after scrollTop -= 6 → ${afterUp}`);
out.push(big.captureCharFrame());
// A new block arrives while scrolled up: sticky must NOT yank the view back to the bottom.
let grown = many;
for (let i = 0; i < 5; i++) grown = reduce(grown, { type: "notice", level: "info", text: `late ${i}` }, 2000 + i);
big.renderer.root.getChildren();
out.push(`(detached from sticky: ${afterUp < atBottom ? "yes" : "NO — sticky overrode the manual scroll"})`);
target.scrollTop += 999;
await big.flush();
out.push(`after scrollTop += 999 → ${target.scrollTop} (back at bottom: ${target.scrollTop === atBottom})`);
short.renderer.destroy();
big.renderer.destroy();

// ── 3. The real App mounts (no daemon: the connection just retries in the background) ─────────
const app = await testRender(<App />, { width: 90, height: 14 });
await app.flush();
await settle();
app.mockInput.pressArrow("up");
app.mockInput.pressArrow("down");
await app.flush();
out.push("\n=== App mounted (no daemon) ===");
out.push(app.captureCharFrame());
app.renderer.destroy();

await Bun.write("/tmp/keycheck.txt", out.join("\n"));
process.exit(0);
