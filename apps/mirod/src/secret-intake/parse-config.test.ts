import { test, expect } from "bun:test";
import { parseConfig } from "./parse-config";

const WG = `[Interface]
# Key for miro-testing
PrivateKey = SECRETPRIVATEKEYVALUE=
Address = 10.2.0.2/32, 2a07:b944::2:2/128
DNS = 10.2.0.1

[Peer]
PublicKey = SERVERPUBLICKEY=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 31.13.189.226:51820
PersistentKeepalive = 25`;

test("WireGuard: private key -> secret ref, topology -> settings, no key in summary", () => {
  const r = parseConfig(WG, "gluetun");
  expect(r.format).toBe("wireguard");
  expect(r.secrets).toEqual([{ ref: "extension.gluetun.wg_private_key", value: "SECRETPRIVATEKEYVALUE=" }]);
  expect(r.settings["wg_endpoint"]).toBe("31.13.189.226:51820");
  expect(r.settings["wg_public_key"]).toBe("SERVERPUBLICKEY=");
  expect(r.settings["wg_addresses"]).toContain("10.2.0.2/32");
  // the private key value must NEVER appear in the summary or the settings
  expect(r.summary).not.toContain("SECRETPRIVATEKEYVALUE");
  expect(JSON.stringify(r.settings)).not.toContain("SECRETPRIVATEKEYVALUE");
});

test(".env: secret-named keys -> refs, others -> settings", () => {
  const r = parseConfig("DB_HOST=localhost\nexport DB_PASSWORD=hunter2\nAPI_KEY=\"abc123\"\nPORT=8080", "app");
  expect(r.format).toBe("env");
  const refs = r.secrets.map((s) => s.ref).sort();
  expect(refs).toEqual(["extension.app.api_key", "extension.app.db_password"]);
  expect(r.secrets.find((s) => s.ref.endsWith("db_password"))!.value).toBe("hunter2");
  expect(r.settings["DB_HOST"]).toBe("localhost");
  expect(r.settings["PORT"]).toBe("8080");
  expect(r.settings["DB_PASSWORD"]).toBeUndefined();
});

test("unrecognized input becomes a single raw secret (never left as config)", () => {
  const r = parseConfig("just-some-opaque-token-blob", "x");
  expect(r.format).toBe("raw");
  expect(r.secrets).toEqual([{ ref: "extension.x.secret", value: "just-some-opaque-token-blob" }]);
  expect(r.settings).toEqual({});
});

test("a WireGuard block is not misread as .env (wireguard tried first)", () => {
  // PrivateKey = ... is a KEY=VALUE line, but [Interface] must not make it parse as env
  expect(parseConfig(WG, "z").format).toBe("wireguard");
});
