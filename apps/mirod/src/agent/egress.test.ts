import { test, expect } from "bun:test";
import { providerTrust, scrubText, classifyContentTier, gateEgress, restoreText, PROVIDER_TIERS_SETTING, BLOCK_SETTING, type Tier } from "./egress";
import type { Context, Model } from "@miro/model-client";

const model = (provider: string, baseUrl: string) => ({ provider, baseUrl }) as unknown as Model;
const ctx = (): Context =>
  ({
    systemPrompt: ["you manage the box at 10.0.0.5"],
    messages: [
      { role: "user", content: "restart jellyfin, password: hunter2", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "checking nas.local" }], timestamp: 0 },
    ],
  }) as unknown as Context;

const noSetting = () => null;
const setting = (map: Record<string, string>) => (k: string) => map[k] ?? null;

test("providerTrust: on-box is secret, no-train APIs internal, everything else public (fail closed)", () => {
  expect(providerTrust("ollama", "http://localhost:11434/v1", noSetting)).toBe("secret");
  expect(providerTrust("anthropic", "https://api.anthropic.com", noSetting)).toBe("internal");
  expect(providerTrust("openai", "https://api.openai.com/v1", noSetting)).toBe("internal");
  expect(providerTrust("groq", "https://api.groq.com", noSetting)).toBe("internal");
  expect(providerTrust("openai-codex", "https://chatgpt.com/backend-api", noSetting)).toBe("internal"); // the chosen primary brain (§5.33)
  expect(providerTrust("google", "https://generativelanguage.googleapis.com", noSetting)).toBe("public"); // free tier may train
  expect(providerTrust("some-random-free-endpoint", "https://llm7.io", noSetting)).toBe("public");
});

test("a private baseUrl is secret whatever the provider id; a setting can override a public default", () => {
  expect(providerTrust("openai", "http://192.168.1.5:8000/v1", noSetting)).toBe("secret"); // pointed on-box
  const s = setting({ [PROVIDER_TIERS_SETTING]: JSON.stringify({ openrouter: "internal", google: "public", "openai-codex": "public" }) });
  expect(providerTrust("openrouter", "https://openrouter.ai/api", s)).toBe("internal");
  expect(providerTrust("google", "https://generativelanguage.googleapis.com", s)).toBe("public");
  expect(providerTrust("openai-codex", "https://chatgpt.com/backend-api", s)).toBe("public"); // owner can tighten it back
});

test("scrubText redacts private topology for a public provider, keeps public addresses", () => {
  const t = "restart jellyfin on 192.168.1.10 and check nas.local, not github.com or 8.8.8.8";
  const s = scrubText(t, true);
  expect(s.text).not.toContain("192.168.1.10");
  expect(s.text).not.toContain("nas.local");
  expect(s.text).toContain("github.com"); // public host kept
  expect(s.text).toContain("8.8.8.8"); // public IP kept
  expect(s.infra.count).toBe(2);
  expect(s.infra.types.sort()).toEqual(["internal-host", "private-ip"]);
});

test("scrubText redacts tailnet names and IPv6 ULA/loopback", () => {
  const s = scrubText("box.tail1234.ts.net at fd12:3456::1 and ::1", true);
  expect(s.text).not.toContain("ts.net");
  expect(s.text).not.toContain("fd12:3456::1");
  expect(s.infra.count).toBeGreaterThanOrEqual(2);
});

test("secret-shaped strings are ALWAYS scrubbed, even without infra redaction, and {{secret}} survives", () => {
  const t = "password: hunter2 and use {{secret:provider.anthropic}} for auth";
  const off = scrubText(t, false); // a cleared provider - infra not redacted...
  expect(off.text).not.toContain("hunter2"); // ...but the secret still is
  expect(off.secretFound).toBe(true);
  expect(off.text).toContain("{{secret:provider.anthropic}}"); // a reference is not a value
});

test("scrubText(redactInfra=false) still measures infra for the audit, without changing it", () => {
  const s = scrubText("ssh 10.0.0.4", false);
  expect(s.text).toContain("10.0.0.4"); // left intact for a cleared provider
  expect(s.infra.count).toBe(1);
});

test("classifyContentTier: secret > internal > public", () => {
  expect(classifyContentTier("token=ghp_abcdefgh12345678")).toBe("secret");
  expect(classifyContentTier("the box is at 10.1.2.3")).toBe("internal");
  expect(classifyContentTier("please summarize this article about cats")).toBe("public");
});

test("gateEgress to a public provider scrubs secrets AND infra across the whole context", () => {
  const { context, audit } = gateEgress(ctx(), model("google", "https://generativelanguage.googleapis.com"), () => null);
  const blob = JSON.stringify(context);
  expect(blob).not.toContain("hunter2");
  expect(blob).not.toContain("10.0.0.5"); // systemPrompt infra redacted
  expect(blob).not.toContain("nas.local"); // assistant TextContent infra redacted
  expect(audit).toMatchObject({ provider: "google", trust: "public", contentTier: "secret", secretRedacted: true });
  expect(audit.infraRedacted).toBeGreaterThanOrEqual(2);
});

test("gateEgress to an internal (no-train) provider keeps infra but still scrubs secrets", () => {
  const { context, audit } = gateEgress(ctx(), model("openai", "https://api.openai.com/v1"), () => null);
  const blob = JSON.stringify(context);
  expect(blob).not.toContain("hunter2"); // secret always gone
  expect(blob).toContain("10.0.0.5"); // infra kept for a no-train provider
  expect(blob).toContain("nas.local");
  expect(audit).toMatchObject({ trust: "internal", secretRedacted: true, infraRedacted: 0 });
});

// --- slice 2 ---

test("a :free model variant caps trust at public, even on a no-train provider; its paid twin does not", () => {
  expect(providerTrust("openai", "https://api.openai.com/v1", () => null, "gpt-4o:free")).toBe("public");
  expect(providerTrust("openai", "https://api.openai.com/v1", () => null, "gpt-4o")).toBe("internal");
  expect(providerTrust("openrouter", "https://openrouter.ai/api", () => null, "meta/llama-3.1:free")).toBe("public");
});

test("round-trip: infra is redacted to reversible tokens outbound and restored on the reply", () => {
  const { context, restore } = gateEgress(ctx(), model("google", "https://generativelanguage.googleapis.com"), () => null, { roundTrip: true });
  expect(restore).toBeDefined();
  const blob = JSON.stringify(context);
  expect(blob).not.toContain("10.0.0.5");
  expect(blob).not.toContain("nas.local");
  const ipToken = [...restore!.entries()].find(([, v]) => v === "10.0.0.5")?.[0];
  expect(ipToken).toBeDefined();
  expect(blob).toContain(ipToken!); // the token, not the raw IP, went out
  // the model's reply echoing the token is de-anonymised back to the real identifier
  expect(restoreText(`checked ${ipToken} and it is healthy`, restore!)).toContain("10.0.0.5");
});

test("strict block mode refuses when content out-ranks the provider, but clears content within its tier", () => {
  const block = (k: string) => (k === BLOCK_SETTING ? "true" : null);
  // ctx() carries a secret -> content tier `secret`; google is `public` -> secret > public -> refuse.
  expect(() => gateEgress(ctx(), model("google", "https://generativelanguage.googleapis.com"), block)).toThrow(/egress refused/);
  // an on-box (secret-cleared) provider clears secret content -> no throw.
  expect(() => gateEgress(ctx(), model("ollama", "http://localhost:11434/v1"), block)).not.toThrow();
  // block off -> redact-to-fit, never throw.
  expect(() => gateEgress(ctx(), model("google", "https://generativelanguage.googleapis.com"), () => null)).not.toThrow();
});
