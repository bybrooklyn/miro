import { test, expect } from "bun:test";
import { providerTrust, scrubText, classifyContentTier, gateEgress, PROVIDER_TIERS_SETTING, type Tier } from "./egress";
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
  expect(providerTrust("google", "https://generativelanguage.googleapis.com", noSetting)).toBe("public"); // free tier may train
  expect(providerTrust("some-random-free-endpoint", "https://llm7.io", noSetting)).toBe("public");
});

test("a private baseUrl is secret whatever the provider id; a setting can override a public default", () => {
  expect(providerTrust("openai", "http://192.168.1.5:8000/v1", noSetting)).toBe("secret"); // pointed on-box
  const s = setting({ [PROVIDER_TIERS_SETTING]: JSON.stringify({ openrouter: "internal", google: "public" }) });
  expect(providerTrust("openrouter", "https://openrouter.ai/api", s)).toBe("internal");
  expect(providerTrust("google", "https://generativelanguage.googleapis.com", s)).toBe("public");
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
