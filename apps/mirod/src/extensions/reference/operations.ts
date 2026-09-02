import { Type, type ExtensionContext, type ExtensionOperation } from "@miro/sdk";

// A write, as a declarative binding the daemon runs through its engine — the extension never
// performs the write itself. Use the app's real name in the ref (e.g. extension.gotify.api_key).
export function buildOperations(_ctx: ExtensionContext): ExtensionOperation[] {
  return [
    {
      name: "create_widget",
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
  ];
}
