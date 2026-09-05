import { test, expect } from "bun:test";
import { severityFrom, type SeverityInputs } from "./severity";

function service(unit: string, active = "active"): SeverityInputs["services"][number] {
  return { unit, load: "loaded", active, sub: active === "active" ? "running" : "dead", description: unit };
}
function container(name: string, state = "running"): SeverityInputs["containers"][number] {
  return { id: name, name, image: "x", state, status: state, labels: {}, ports: "" };
}
function mount(mountPoint: string, usedPercent: number): SeverityInputs["mounts"][number] {
  return { filesystem: "ext4", mountPoint, sizeBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent };
}

test("severityFrom: a clean box scores zero", () => {
  const score = severityFrom({
    services: [service("nginx.service"), service("docker.service")],
    containers: [container("jellyfin"), container("radarr")],
    mounts: [mount("/", 40)],
  });
  expect(score).toBe(0);
});

test("severityFrom: counts failed units, not merely-inactive ones", () => {
  const score = severityFrom({
    services: [service("nginx.service", "failed"), service("oneshot.service", "inactive")],
    containers: [],
    mounts: [],
  });
  expect(score).toBe(1); // only the failed one counts - inactive is not a regression signal
});

test("severityFrom: counts a crash-looping (restarting) container, not a stopped one", () => {
  const score = severityFrom({
    services: [],
    containers: [container("jellyfin", "restarting"), container("old", "exited")],
    mounts: [],
  });
  expect(score).toBe(1);
});

test("severityFrom: counts a mount at or above the critical threshold, not below it", () => {
  const score = severityFrom({
    services: [],
    containers: [],
    mounts: [mount("/", 89), mount("/data", 90), mount("/backup", 99)],
  });
  expect(score).toBe(2);
});

test("severityFrom: dimensions sum, matching PLAN.md's 'AND μ_post ≤ μ_pre' commit-gate design", () => {
  const score = severityFrom({
    services: [service("a.service", "failed"), service("b.service", "failed")],
    containers: [container("c", "restarting")],
    mounts: [mount("/", 95)],
  });
  expect(score).toBe(2 + 1 + 1);
});
