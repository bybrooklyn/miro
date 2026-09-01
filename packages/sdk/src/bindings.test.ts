import { test, expect } from "bun:test";
import { createFakeExec, createFakeReadFile, type ExtensionOperation, type ExtensionContext } from "./index";

test("createFakeExec routes by exact command and fills defaults", async () => {
  const exec = createFakeExec({ "radarr --version": { stdout: "4.0.0\n" }, "failing": { exitCode: 1, stderr: "boom" } });
  expect(await exec("radarr --version")).toEqual({ exitCode: 0, stdout: "4.0.0\n", stderr: "" });
  expect(await exec("failing")).toEqual({ exitCode: 1, stdout: "", stderr: "boom" });
  await expect(exec("nope")).rejects.toThrow(/No fixture/);
});

test("createFakeReadFile routes by path", async () => {
  const readFile = createFakeReadFile({ "/opt/app/config.xml": "<x/>" });
  expect(await readFile("/opt/app/config.xml")).toBe("<x/>");
  await expect(readFile("/etc/nope")).rejects.toThrow(/No fixture/);
});

test("an operation binding is plain data the daemon can run", () => {
  const op: ExtensionOperation<{ name: string }> = {
    name: "complete_wizard",
    label: "Complete setup wizard",
    description: "Finish first-run setup.",
    parameters: {},
    bind: (args) => ({
      kind: "http_mutation",
      goal: `complete setup for ${args.name}`,
      method: "POST",
      url: "http://127.0.0.1:8096/Startup/Complete",
      verifyUrl: "http://127.0.0.1:8096/System/Info/Public",
      verifyExpect: '"StartupWizardCompleted":true',
    }),
  };
  const bound = op.bind({ name: "jellyfin" });
  expect(bound.kind).toBe("http_mutation");
  expect(JSON.parse(JSON.stringify(bound))).toEqual(bound); // serialisable — it crosses the host RPC
  const ctxShape: (keyof ExtensionContext)[] = ["http", "browser", "secrets", "exec", "readFile"];
  expect(ctxShape.length).toBe(5);
});
