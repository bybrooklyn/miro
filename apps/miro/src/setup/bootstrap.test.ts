import { test, expect } from "bun:test";
import { probeSshAccess, installCommand } from "./bootstrap";

test("installCommand points at the install script that actually exists", () => {
  // Was a miro.computer URL with nothing behind it; the deploy-anywhere slice shipped install.sh.
  expect(installCommand()).toBe("curl -fsSL https://raw.githubusercontent.com/bybrooklyn/miro/master/install.sh | sudo sh");
});

test(
  "probeSshAccess runs a real ssh invocation and reports failure cleanly against an unreachable target",
  async () => {
    // No real Linux target exists in this environment (the actual blocker on SSH bootstrap) - this
    // proves the real `ssh` CLI gets invoked correctly and fails fast/cleanly rather than hanging,
    // which is exactly what happens for a real unreachable target too.
    const result = await probeSshAccess("127.0.0.1", { port: 1, timeoutSeconds: 2 });
    expect(result.reachable).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  },
  // See network.test.ts's getTailscaleStatus test for why this retries.
  { timeout: 10000, retry: 2 },
);
