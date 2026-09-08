import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { scanCompose, stackDeployKind } from "../operations/kinds/stack-deploy";
import { ensureStacksTable, upsertStack, getStack, listStacks, setStackStatus, removeStack } from "./store";

const SAFE = `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    ports: ["8096:8096"]
    volumes:
      - config:/config
      - /etc/localtime:/etc/localtime:ro
      - /mnt/media:/media
volumes:
  config:`;

test("scanCompose: a normal compose passes and reports its host binds", () => {
  const r = scanCompose(SAFE);
  expect(r.refuse).toBeNull();
  expect(r.binds).toContain("/mnt/media");
  expect(r.binds).toContain("/etc/localtime");
});

test("scanCompose: refuses privileged", () => {
  expect(scanCompose("services:\n  x:\n    image: a\n    privileged: true").refuse).toMatch(/privileged/i);
});

test("scanCompose: refuses SYS_ADMIN / ALL cap", () => {
  expect(scanCompose("services:\n  x:\n    image: a\n    cap_add: [SYS_ADMIN]").refuse).toMatch(/privileged|SYS_ADMIN/i);
});

test("scanCompose: refuses the docker socket, root, /root and /var/lib/miro binds", () => {
  expect(scanCompose('services:\n  x:\n    image: a\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]').refuse).toMatch(/docker/i);
  expect(scanCompose('services:\n  x:\n    image: a\n    volumes: ["/:/host"]').refuse).toMatch(/host/i);
  expect(scanCompose('services:\n  x:\n    image: a\n    volumes: ["/root:/r"]').refuse).toMatch(/Miro state|secret/i);
  expect(scanCompose('services:\n  x:\n    image: a\n    volumes: ["/var/lib/miro:/m"]').refuse).toMatch(/Miro state|secret/i);
});

test("scanCompose: refuses invalid YAML and a compose with no services", () => {
  expect(scanCompose(":::not yaml:::").refuse).toBeTruthy();
  expect(scanCompose("version: '3'").refuse).toMatch(/no services/i);
});

test("stack.deploy describe refuses a bad app name before anything else", async () => {
  const db = new Database(":memory:");
  ensureStacksTable(db);
  await expect(stackDeployKind(db).describe({ app: "Bad Name", compose: SAFE })).rejects.toThrow(/valid app name/i);
});

test("managed_stacks store: upsert/get/list/status/remove", () => {
  const db = new Database(":memory:");
  ensureStacksTable(db);
  upsertStack(db, { app: "immich", dir: "/var/lib/miro/stacks/immich", composePath: "/var/lib/miro/stacks/immich/compose.yaml", status: "running" });
  expect(getStack(db, "immich")?.status).toBe("running");
  setStackStatus(db, "immich", "stopped");
  expect(getStack(db, "immich")?.status).toBe("stopped");
  expect(listStacks(db).map((s) => s.app)).toEqual(["immich"]);
  removeStack(db, "immich");
  expect(getStack(db, "immich")).toBeNull();
});
