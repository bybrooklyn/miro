// Reference extension (audit X3): the canonical shape a learn agent must generate. Kept in the
// source tree so the normal typecheck guards it, and exercised through the real static validators
// by reference.test.ts. The worked example embedded in learn-agent.ts's prompt mirrors this file —
// keep them in sync. A token-auth HTTP app (the common case).
import { Type, type ExtensionContext, type ExtensionTool } from "@miro/sdk";

const auth = (ctx: ExtensionContext) => ({ "X-Api-Key": ctx.secrets.api_key });

export function buildTools(ctx: ExtensionContext): ExtensionTool[] {
  return [
    {
      name: "list_widgets",
      description: "List all widgets.",
      parameters: Type.Object({}),
      execute: async () => (await ctx.http.get("/api/widgets", { headers: auth(ctx) })).json(),
    },
    {
      name: "get_widget",
      description: "Get one widget by id.",
      parameters: Type.Object({ id: Type.String({ description: "Widget id" }) }),
      execute: async (args: { id: string }) => (await ctx.http.get(`/api/widgets/${args.id}`, { headers: auth(ctx) })).json(),
    },
  ];
}
