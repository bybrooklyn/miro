import { testRender } from "@opentui/react/test-utils";
import type { ServerEvent } from "@miro/protocol";
import { answered, initialState, reduce, userSent, type UiState } from "@miro/ui-model";
import { theme } from "./theme";
import { StatusLine } from "./components/StatusLine";
import { Transcript } from "./components/Transcript";
import { PromptArea } from "./components/PromptArea";
import { Footer } from "./components/Footer";

let t = 1000;
const now = () => (t += 100);
const apply = (s: UiState, events: ServerEvent[]) => events.reduce((acc, e) => reduce(acc, e, now()), s);

let s = reduce(initialState(), { type: "status", server: "home", health: "healthy", model: "gpt-5.6-luna", privilege: "root" }, now());
s = userSent(s, "can you set up jellyfin", now());
s = apply(s, [
  { type: "activity", id: "t1", label: "Host info", status: "running" },
  { type: "activity", id: "t1", label: "Host info", status: "done", detail: "Debian 13" },
  { type: "activity", id: "t2", label: "Learn app", status: "running" },
  { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "running" },
  { type: "activity", id: "t2a", parentId: "t2", label: "Web search", status: "done" },
  { type: "activity", id: "t2b", parentId: "t2", label: "Learn another app", status: "running" },
  { type: "activity", id: "t2b1", parentId: "t2b", label: "HTTP GET", status: "failed", detail: "404" },
  { type: "reply_delta", text: "Jellyfin is installed and healthy." },
  {
    type: "system_plan",
    id: "p1",
    title: "Set up Jellyfin",
    findings: ["Docker is running", "no media server yet"],
    components: [
      { name: "jellyfin", action: "install", detail: "container on :8096" },
      { name: "caddy", action: "reuse", detail: "already proxying" },
      { name: "old-plex", action: "remove", detail: "unused" },
      { name: "ufw", action: "configure", detail: "open 8096" },
    ],
    steps: ["pull the image", "write a compose file", "start it"],
    verification: ["the web UI answers on :8096"],
    notes: ["creates an admin password"],
  },
  {
    type: "operation_plan",
    id: "o1",
    goal: "write config",
    summary: "Overwrite /opt/jellyfin/compose.yml",
    autoApprove: false,
    details: {
      class: "destructive",
      writes: ["/opt/jellyfin"],
      network: true,
      warning: "replaces an existing file",
      command: "docker compose up -d",
      diff: [
        "--- a/compose.yml",
        "+++ b/compose.yml",
        "@@ -1,4 +1,5 @@",
        " services:",
        "   jellyfin:",
        "-    image: jellyfin/jellyfin:10.8",
        "+    image: jellyfin/jellyfin:10.9",
        "+    restart: unless-stopped",
        "     ports: [8096:8096]",
      ].join("\n"),
    },
  },
  { type: "operation_progress", id: "o1", phase: "applying" },
  { type: "notice", level: "warn", text: "the firewall rule will be reverted if you go quiet" },
  { type: "notice", level: "credential", text: "Created Jellyfin admin password — value: hunter2" },
]);

const withChoice = apply(s, [
  {
    type: "question",
    id: "plan_confirm:p1",
    prompt: "Approve this plan?",
    options: [
      { label: "Approve", value: "approve" },
      { label: "Change something", value: "change" },
      { label: "Cancel", value: "cancel" },
    ],
  },
]);
const withSecret = apply(answered(withChoice, "plan_confirm:p1", "approve"), [
  { type: "secret_prompt", id: "ask:2", prompt: "Paste the VPN password" },
]);

const out: string[] = [];
const answers: string[] = [];
const chats: string[] = [];

function Shell({ state, width, height }: { state: UiState; width: number; height: number }) {
  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.background}>
      <StatusLine state={state} />
      <Transcript blocks={state.blocks} scrollRef={null} />
      <PromptArea
        state={state}
        onAnswer={(id, value) => answers.push(`${id}=${value}`)}
        onChat={(text) => chats.push(text)}
      />
      <Footer state={state} />
    </box>
  );
}

const idle = apply(answered(withSecret, "ask:2", ""), [{ type: "reply", text: "Jellyfin is installed and healthy." }]);
const settle = () => new Promise((r) => setTimeout(r, 100));

async function frame(name: string, state: UiState, w = 100, h = 40, drive?: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>) {
  const setup = await testRender(<Shell state={state} width={w} height={h} />, { width: w, height: h });
  await setup.flush();
  if (drive) await drive(setup);
  await settle();
  await setup.flush();
  out.push(`\n=================== ${name} (${w}x${h}) ===================`);
  out.push(setup.captureCharFrame());
  setup.renderer.destroy();
}

await frame("choice prompt", withChoice);
await frame("secret prompt — typed + pasted", withSecret, 100, 40, async (setup) => {
  await setup.mockInput.typeText("sk-live");
  await setup.mockInput.pasteBracketedText("PASTED-KEY-1234");
  setup.mockInput.pressBackspace();
  await setup.flush();
});
await frame("idle chat input", idle);
await frame("narrow terminal", withChoice, 60, 24);

// Keyboard routing on a choice prompt: hint letter, digit, arrows + Enter, Escape.
for (const drive of [
  async (s: Awaited<ReturnType<typeof testRender>>) => s.mockInput.pressKey("c"),
  async (s: Awaited<ReturnType<typeof testRender>>) => s.mockInput.pressKey("2"),
  async (s: Awaited<ReturnType<typeof testRender>>) => {
    s.mockInput.pressArrow("down");
    await settle();
    s.mockInput.pressEnter();
  },
  async (s: Awaited<ReturnType<typeof testRender>>) => s.mockInput.pressEscape(),
]) {
  const setup = await testRender(<Shell state={withChoice} width={100} height={20} />, { width: 100, height: 20 });
  await setup.flush();
  await drive(setup);
  await settle();
  await setup.flush();
  setup.renderer.destroy();
}

const chatSetup = await testRender(<Shell state={idle} width={100} height={20} />, { width: 100, height: 20 });
await chatSetup.flush();
await chatSetup.mockInput.typeText("restart jellyfin");
chatSetup.mockInput.pressEnter();
await settle();
await chatSetup.flush();
chatSetup.renderer.destroy();

out.push(`\nanswers: ${JSON.stringify(answers)}`);
out.push(`chats:   ${JSON.stringify(chats)}`);
await Bun.write("/tmp/rendercheck.txt", out.join("\n"));
process.exit(0);
