import { test, expect } from "bun:test";
import { createRetryLedger, planHash } from "./retry-ledger";

test("planHash ignores key order and undefined fields, distinguishes real differences", () => {
  expect(planHash("shell.command", { command: "ls", writes: ["/a"] })).toBe(planHash("shell.command", { writes: ["/a"], command: "ls", cwd: undefined }));
  expect(planHash("shell.command", { command: "ls" })).not.toBe(planHash("shell.command", { command: "ls -l" }));
  expect(planHash("shell.command", { command: "ls" })).not.toBe(planHash("file.write", { command: "ls" }));
});

test("an identical plan is refused after it failed once; a different plan is allowed", () => {
  const ledger = createRetryLedger(3);
  expect(ledger.check("shell.command", { command: "systemctl restart x" })).toBeNull();
  ledger.record("shell.command", { command: "systemctl restart x" }, "Verification failed - restart x, rolled back.");
  expect(ledger.check("shell.command", { command: "systemctl restart x" })).toMatch(/exact plan already failed this turn.*change the plan/);
  expect(ledger.check("shell.command", { command: "systemctl restart y" })).toBeNull();
});

test("after the cap, every further plan is refused with the trajectory", () => {
  const ledger = createRetryLedger(2);
  ledger.record("shell.command", { command: "a" }, "a failed");
  ledger.record("file.write", { path: "/b" }, "b failed");
  const refusal = ledger.check("http.mutation", { url: "http://c" });
  expect(refusal).toMatch(/2 different plans have failed this turn, which is the limit/);
  expect(refusal).toContain("1. shell.command: a failed");
  expect(refusal).toContain("2. file.write: b failed");
});

test("reset starts a fresh turn", () => {
  const ledger = createRetryLedger(1);
  ledger.record("shell.command", { command: "a" }, "a failed");
  expect(ledger.check("shell.command", { command: "b" })).not.toBeNull();
  ledger.reset();
  expect(ledger.check("shell.command", { command: "a" })).toBeNull();
});
