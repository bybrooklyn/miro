import { test, expect } from "bun:test";
import { parseLabels, parseDockerPs, parseDockerInspect, parseDockerLogs } from "./containers";

test("parseLabels splits docker's comma-joined key=value label string", () => {
  expect(parseLabels("com.docker.compose.project=media,com.docker.compose.service=jellyfin")).toEqual({
    "com.docker.compose.project": "media",
    "com.docker.compose.service": "jellyfin",
  });
  expect(parseLabels("")).toEqual({});
});

test("parseDockerPs parses `docker ps --format {{json .}}` output (one JSON object per line)", () => {
  const line = JSON.stringify({
    ID: "abc123",
    Image: "jellyfin/jellyfin:latest",
    Names: "jellyfin",
    State: "running",
    Status: "Up 3 hours",
    Labels: "com.docker.compose.project=media",
    Ports: "0.0.0.0:8096->8096/tcp",
  });
  const [container] = parseDockerPs(line + "\n");
  expect(container.id).toBe("abc123");
  expect(container.name).toBe("jellyfin");
  expect(container.state).toBe("running");
  expect(container.labels).toEqual({ "com.docker.compose.project": "media" });
});

test("parseDockerInspect extracts health, ports, mounts, restart count from `docker inspect` output", () => {
  const raw = JSON.stringify([
    {
      Id: "abc123def456",
      Name: "/jellyfin",
      Config: { Image: "jellyfin/jellyfin:latest", Labels: { "com.docker.compose.project": "media" } },
      State: { Status: "running", Health: { Status: "healthy" }, StartedAt: "2026-08-30T12:00:00Z" },
      RestartCount: 2,
      Mounts: [{ Source: "/mnt/media", Destination: "/media" }],
      NetworkSettings: { Ports: { "8096/tcp": [{ HostIp: "0.0.0.0", HostPort: "8096" }] } },
    },
  ]);
  const detail = parseDockerInspect(raw);
  expect(detail.name).toBe("jellyfin");
  expect(detail.health).toBe("healthy");
  expect(detail.restartCount).toBe(2);
  expect(detail.mounts).toEqual([{ source: "/mnt/media", destination: "/media" }]);
  expect(detail.ports).toEqual([{ containerPort: "8096/tcp", hostPort: "8096" }]);
});

test("parseDockerInspect handles an unpublished port (null host binding)", () => {
  const raw = JSON.stringify([
    {
      Id: "x",
      Name: "/redis",
      Config: { Image: "redis:alpine" },
      State: { Status: "running" },
      RestartCount: 0,
      NetworkSettings: { Ports: { "6379/tcp": null } },
    },
  ]);
  const detail = parseDockerInspect(raw);
  expect(detail.ports).toEqual([{ containerPort: "6379/tcp", hostPort: null }]);
  expect(detail.health).toBeNull();
});

test("parseDockerLogs splits `docker logs --timestamps` lines into timestamp + message", () => {
  const output = "2026-08-30T12:00:00.123456789Z Starting Jellyfin server...\n2026-08-30T12:00:01.000000000Z Ready\n";
  expect(parseDockerLogs(output)).toEqual([
    { timestamp: "2026-08-30T12:00:00.123456789Z", line: "Starting Jellyfin server..." },
    { timestamp: "2026-08-30T12:00:01.000000000Z", line: "Ready" },
  ]);
});
