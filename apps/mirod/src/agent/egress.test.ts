import { test, expect } from "bun:test";
import { providerTrust, scrubText, classifyContentTier, PROVIDER_TIERS_SETTING, type Tier } from "./egress";

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
