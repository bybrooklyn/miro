import { test, expect } from "bun:test";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFileKind } from "./secret-file";

const getSecret = (ref: string) => (ref === "extension.gluetun.wg_key" ? "PRIVATEKEYVALUE123" : null);
const kind = secretFileKind(getSecret);

test("secret.file: describe refuses a template with no placeholder", async () => {
  await expect(kind.describe({ path: "/tmp/x.env", template: "NO_SECRET=here" })).rejects.toThrow(/placeholder/);
});

test("secret.file: describe refuses secret-material paths", async () => {
  await expect(kind.describe({ path: "/etc/wireguard/wg0.conf", template: "KEY={{secret:extension.gluetun.wg_key}}" })).rejects.toThrow(/secret material/);
});

test("secret.file: the plan shows the template, never the resolved value", async () => {
  const plan = await kind.describe({ path: "/tmp/x.env", template: "WG={{secret:extension.gluetun.wg_key}}" });
  const s = JSON.stringify(plan);
  expect(s).toContain("{{secret:");
  expect(s).not.toContain("PRIVATEKEYVALUE123");
});

test("secret.file: apply resolves the secret and writes 0600", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sf-")), "gluetun.env");
  const params = { path, template: "WIREGUARD_PRIVATE_KEY={{secret:extension.gluetun.wg_key}}\n" };
  await kind.captureState(params);
  await kind.apply(params);
  expect(readFileSync(path, "utf8")).toBe("WIREGUARD_PRIVATE_KEY=PRIVATEKEYVALUE123\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(await kind.verify(params)).toBe(true);
});

test("secret.file: apply throws when a referenced secret is unset", async () => {
  const params = { path: join(mkdtempSync(join(tmpdir(), "sf-")), "x.env"), template: "K={{secret:does.not.exist}}" };
  await kind.captureState(params);
  await expect(kind.apply(params)).rejects.toThrow(/not set/);
});

test("secret.file: rollback removes a file this op created", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sf-")), "x.env");
  const params = { path, template: "K={{secret:extension.gluetun.wg_key}}" };
  const captured = await kind.captureState(params);
  await kind.apply(params);
  expect(existsSync(path)).toBe(true);
  await kind.rollback(params, captured);
  expect(existsSync(path)).toBe(false);
});
