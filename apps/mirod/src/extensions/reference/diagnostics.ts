import { Type, type ExtensionContext, type ExtensionTool } from "@miro/sdk";

export function buildDiagnostics(ctx: ExtensionContext): ExtensionTool[] {
  return [
    {
      name: "reachable",
      description: "App answers on its health endpoint.",
      parameters: Type.Object({}),
      execute: async () => {
        const r = await ctx.http.get("/health");
        return { healthy: r.ok, status: r.status };
      },
    },
  ];
}
