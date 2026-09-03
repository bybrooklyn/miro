import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { hostPorts, presenceFrom, formatPresence, factsFrom } from "./discovery";
import type { ContainerSummary } from "./inventory/containers";
import type { ServiceInfo } from "./inventory/systemd";
import { ensureMemoryTable, query, remember } from "./memory/store";

function container(name: string, image: string, state = "running", ports = ""): ContainerSummary {
  return { id: name, name, image, state, status: state, labels: {}, ports };
}
function service(unit: string, active = "active"): ServiceInfo {
  return { unit, load: "loaded", active, sub: active === "active" ? "running" : "dead", description: unit };
}

test("hostPorts extracts host-bound ports, ignores container-only and dedupes", () => {
  expect(hostPorts("0.0.0.0:8096->8096/tcp, :::8096->8096/tcp")).toEqual([8096]);
  expect(hostPorts("0.0.0.0:32400->32400/tcp, 0.0.0.0:1900->1900/udp")).toEqual([1900, 32400]);
  expect(hostPorts("127.0.0.1:5432->5432/tcp")).toEqual([5432]);
  expect(hostPorts("8096/tcp")).toEqual([]); // published to no host port
  expect(hostPorts("")).toEqual([]);
});

test("presenceFrom finds an app by container name and guesses its base URL", () => {
  const p = presenceFrom("jellyfin", [container("jellyfin", "jellyfin/jellyfin:10.11", "running", "0.0.0.0:8096->8096/tcp")], []);
  expect(p.found).toBe(true);
  expect(p.container?.ports).toEqual([8096]);
  expect(p.baseUrlGuess).toBe("http://localhost:8096");
  expect(formatPresence("jellyfin", p)).toContain("http://localhost:8096");
});

test("presenceFrom matches on image basename when the container name differs", () => {
  const p = presenceFrom("jellyfin", [container("media-server", "jellyfin/jellyfin", "running", "0.0.0.0:8096->8096/tcp")], []);
  expect(p.found).toBe(true);
  expect(p.container?.name).toBe("media-server");
});

test("presenceFrom falls back to a systemd unit when no container matches", () => {
  const p = presenceFrom("jellyfin", [container("postgres", "postgres:16")], [service("jellyfin.service")]);
  expect(p.found).toBe(true);
  expect(p.service).toBe("jellyfin.service");
  expect(p.baseUrlGuess).toBeUndefined(); // no container port to guess from
});

test("presenceFrom reports honestly when nothing matches", () => {
  const p = presenceFrom("sonarr", [container("jellyfin", "jellyfin/jellyfin")], []);
  expect(p.found).toBe(false);
  expect(formatPresence("sonarr", p)).toContain("not found running on this box");
});

test("factsFrom summarises containers and filters noise services", () => {
  const facts = factsFrom(
    [container("jellyfin", "jellyfin/jellyfin"), container("radarr", "linuxserver/radarr"), container("old", "x", "exited")],
    [service("postgresql.service"), service("ssh.service"), service("nginx.service"), service("cron.service"), service("docker.service", "inactive")],
  );
  const byKey = Object.fromEntries(facts.map((f) => [f.key, f.value]));
  expect(byKey["server.containers"]).toContain("3 Docker container(s), 2 running");
  expect(byKey["server.containers"]).toContain("jellyfin, radarr");
  expect(byKey["server.containers"]).not.toContain("old"); // exited → not in the running list
  // ssh + cron are NOISE_UNIT; docker.service is inactive; postgresql + nginx survive.
  expect(byKey["server.services"]).toContain("postgresql.service");
  expect(byKey["server.services"]).toContain("nginx.service");
  expect(byKey["server.services"]).not.toContain("ssh.service");
  expect(byKey["server.services"]).not.toContain("docker.service");
});

test("factsFrom returns nothing on an empty box", () => {
  expect(factsFrom([], [])).toEqual([]);
});

test("discovered facts persist as reinforced server_fact memories", () => {
  const db = new Database(":memory:");
  ensureMemoryTable(db);
  const facts = factsFrom([container("jellyfin", "jellyfin/jellyfin")], []);
  for (const f of facts) remember(db, "server_fact", f.key, f.value, "discovery");
  for (const f of facts) remember(db, "server_fact", f.key, f.value, "discovery"); // second sweep reinforces
  const rows = query(db, { category: "server_fact" });
  const containersRow = rows.find((r) => r.key === "server.containers");
  expect(containersRow).toBeDefined();
  expect(containersRow!.value).toContain("jellyfin");
  expect(containersRow!.occurrenceCount).toBe(2); // reinforced, not duplicated
});
