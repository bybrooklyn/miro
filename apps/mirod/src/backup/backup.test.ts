import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "./snapshot";
import { ensureRepo, commitAll } from "./git";
import { commandExists } from "../inventory/exec";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  db.run("CREATE TABLE memories (id TEXT PRIMARY KEY, body TEXT)");
  db.run("CREATE TABLE secrets (ref TEXT PRIMARY KEY, ciphertext TEXT)");
  db.run("INSERT INTO settings VALUES ('notify.ntfy.url', 'http://127.0.0.1:8090')");
  db.run("INSERT INTO memories VALUES ('m1', 'jellyfin runs on 8096')");
  db.run("INSERT INTO secrets VALUES ('provider.github', 'ciphertext-should-never-be-exported')");
  return db;
}

test("buildSnapshot mirrors configs redacted, exports non-secret state, never the secrets table", async () => {
  const db = seedDb();
  const configDir = tmp("miro-cfg-");
  const composeFile = join(configDir, "docker-compose.yml");
  writeFileSync(composeFile, "services:\n  app:\n    environment:\n      DB_PASSWORD: hunter2\n");
  const backupDir = tmp("miro-bk-");

  const r = await buildSnapshot(db, backupDir, { configPaths: [composeFile], skipComposeDiscovery: true });

  // config mirrored at its absolute path, secret redacted
  const mirrored = join(backupDir, "configs", composeFile.replace(/^\/+/, ""));
  expect(existsSync(mirrored)).toBe(true);
  const body = readFileSync(mirrored, "utf8");
  expect(body).toContain("[redacted]");
  expect(body).not.toContain("hunter2");

  // Miro state exported, secrets table NOT
  expect(readFileSync(join(backupDir, "miro", "settings.ndjson"), "utf8")).toContain("notify.ntfy.url");
  expect(readFileSync(join(backupDir, "miro", "memories.ndjson"), "utf8")).toContain("jellyfin");
  expect(existsSync(join(backupDir, "miro", "secrets.ndjson"))).toBe(false);
  expect(r.stateTables).toContain("settings");
  expect(r.stateTables).not.toContain("secrets");

  // no age recipient -> no bundle
  expect(r.ageBundle).toBe("no-recipient");
  expect(existsSync(join(backupDir, "secrets.age"))).toBe(false);
});

test("collectFiles skips symlinks and node_modules", async () => {
  const db = seedDb();
  const root = tmp("miro-walk-");
  writeFileSync(join(root, "keep.conf"), "ok\n");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "skip.js"), "nope\n");
  symlinkSync("/etc/passwd", join(root, "link.conf"));
  const backupDir = tmp("miro-bk-");

  await buildSnapshot(db, backupDir, { configPaths: [root], skipComposeDiscovery: true });
  const dest = join(backupDir, "configs", root.replace(/^\/+/, ""));
  expect(existsSync(join(dest, "keep.conf"))).toBe(true);
  expect(existsSync(join(dest, "node_modules", "skip.js"))).toBe(false);
  expect(existsSync(join(dest, "link.conf"))).toBe(false);
});

test("git commit only when the tree changed", async () => {
  if (!(await commandExists("git"))) return; // git is assumed present; skip cleanly if not
  const dir = tmp("miro-git-");
  await ensureRepo(dir);
  writeFileSync(join(dir, "a.txt"), "one\n");
  expect(await commitAll(dir, "first")).toBe(true);
  expect(await commitAll(dir, "no change")).toBe(false);
  writeFileSync(join(dir, "a.txt"), "two\n");
  expect(await commitAll(dir, "second")).toBe(true);
});

test("age bundle reports age-missing when age absent, no recipient otherwise", async () => {
  const db = seedDb();
  const backupDir = tmp("miro-bk-");
  const keyPath = join(backupDir, "sk");
  writeFileSync(keyPath, "notarealkey");
  const r = await buildSnapshot(db, backupDir, {
    configPaths: [],
    skipComposeDiscovery: true,
    ageRecipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxxxxx",
    secretKeyPath: keyPath,
  });
  // Either age is installed and it wrote a bundle, or it isn't and we said so - never a silent pass.
  expect(["written", "age-missing"]).toContain(r.ageBundle);
  if (r.ageBundle === "written") {
    const armored = readFileSync(join(backupDir, "secrets.age"), "utf8");
    expect(armored).toContain("BEGIN AGE ENCRYPTED FILE");
    expect(armored).not.toContain("notarealkey");
  }
});
