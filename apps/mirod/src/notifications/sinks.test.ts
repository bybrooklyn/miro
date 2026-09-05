import { test, expect } from "bun:test";
import { buildGotifyRequest, buildNtfyRequest, type Notification } from "./sinks";

const attn: Notification = { tier: "needs_attention", title: "Disk full", body: "/ is 94% used", source: "test", at: 0 };
const info: Notification = { tier: "worth_knowing", title: "Reboot done", body: "", source: "test", at: 0 };

test("buildNtfyRequest: topic is the address, title/priority/tags are headers, body is the payload", () => {
  const r = buildNtfyRequest(attn, { url: "http://ntfy.local/", topic: "miro-home" });
  expect(r.url).toBe("http://ntfy.local/miro-home"); // trailing slash on the base collapsed
  expect(r.method).toBe("POST");
  expect(r.headers.Title).toBe("Disk full");
  expect(r.headers.Priority).toBe("urgent");
  expect(r.headers.Tags).toBe("warning");
  expect(r.body).toBe("/ is 94% used");
});

test("buildNtfyRequest: an empty body falls back to the title, and worth_knowing is default priority", () => {
  const r = buildNtfyRequest(info, { url: "http://ntfy.local", topic: "t" });
  expect(r.body).toBe("Reboot done");
  expect(r.headers.Priority).toBe("default");
});

test("buildGotifyRequest: token rides ONLY in the outbound URL, never in the notification; needs_attention is high priority", () => {
  const r = buildGotifyRequest(attn, { url: "http://gotify.local", token: "secret-token-abc" });
  expect(r.url).toBe("http://gotify.local/message?token=secret-token-abc");
  const payload = JSON.parse(r.body) as { title: string; message: string; priority: number };
  expect(payload.title).toBe("Disk full");
  expect(payload.message).toBe("/ is 94% used");
  expect(payload.priority).toBe(8);
  // The token must not have leaked into the body or the notification object.
  expect(r.body).not.toContain("secret-token-abc");
  expect(JSON.stringify(attn)).not.toContain("secret-token-abc");
});

test("buildGotifyRequest: worth_knowing is normal priority, empty body falls back to title", () => {
  const r = buildGotifyRequest(info, { url: "http://gotify.local", token: "t" });
  const payload = JSON.parse(r.body) as { message: string; priority: number };
  expect(payload.priority).toBe(4);
  expect(payload.message).toBe("Reboot done");
});
