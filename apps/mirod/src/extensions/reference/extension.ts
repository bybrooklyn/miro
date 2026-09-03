// Reference extension (PLAN.md §5.13): the canonical shape a learn agent generates — ONE file,
// declarative-first, with a `code` escape hatch. Kept in the source tree so the normal typecheck
// guards it, and driven through the real static validators by reference.test.ts. The worked example
// embedded in learn-agent.ts's prompt mirrors this file — keep them in sync. A token-auth HTTP app
// (the common case).
import { Type, type ExtensionModule, type ExtensionContext } from "@miro/sdk";

export default {
  // Shared auth for every declarative read: send `X-Api-Key: <the api_key secret>`.
  auth: { header: "X-Api-Key", secret: "api_key" },
  entries: [
    // Declarative read — pure data, no code runs. `pick` keeps only these fields of the response.
    {
      name: "list_widgets",
      kind: "tool",
      description: "List all widgets.",
      read: { path: "/api/widgets", pick: ["id", "label"] },
    },
    // Declarative read with a path param — `parameters` is AUTO-DERIVED from {id} (a required string).
    {
      name: "get_widget",
      kind: "tool",
      description: "Get one widget by id.",
      read: { path: "/api/widgets/{id}" },
    },
    // Declarative write — the daemon runs this binding through its engine (confirm/sandbox/verify/
    // rollback). Credentials by reference only (secretHeader / {{secret:ref}} placeholders).
    {
      name: "create_widget",
      kind: "operation",
      description: "Create a widget.",
      parameters: Type.Object({ label: Type.String() }),
      bind: (args: { label: string }) => ({
        kind: "http_mutation",
        goal: `Create widget ${args.label}`,
        method: "POST",
        url: "/api/widgets",
        body: JSON.stringify({ label: args.label }),
        contentType: "application/json",
        secretHeader: { name: "X-Api-Key", ref: "extension.myapp.api_key" },
        verifyUrl: "/api/widgets",
      }),
    },
    // Escape hatch — a health check returns a boolean instead of throwing on a non-200, so it needs
    // logic a declarative `read` cannot express. Reach for `code` ONLY here; prefer `read`.
    {
      name: "reachable",
      kind: "diagnostic",
      description: "App answers on its health endpoint.",
      code: async (ctx: ExtensionContext) => {
        const r = await ctx.http.get("/health");
        return { healthy: r.ok, status: r.status };
      },
    },
  ],
} satisfies ExtensionModule;
