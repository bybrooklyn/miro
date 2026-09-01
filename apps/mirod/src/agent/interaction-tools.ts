import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ServerEvent } from "@miro/protocol";

// The two tools that make the outcome loop conversational without ending the turn (PLAN.md
// §5.4 A): ask_user for the intent Miro genuinely cannot infer, and system_plan for the one
// approval an experienced self-hoster wants before a multi-component change. Both ride on the
// existing question/secret_prompt events and the connection's pending-answer map — the same
// mechanism operation confirmations already use — so nothing new crosses the wire for answers.

function textResult(details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details ?? null, null, 2) }], details };
}

export interface InteractionContext {
  send: (event: ServerEvent) => void;
  waitForAnswer: (id: string) => Promise<string>;
  /** Called with each secret answer so it is stored by reference — the model never sees the value. */
  setSecret: (ref: string, value: string) => void;
}

const askUserParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      key: Type.String({ description: "Short identifier for this answer in the result, e.g. media_types." }),
      question: Type.String({ description: "The question, phrased around the user's intent — never around implementation you could decide yourself." }),
      options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), { description: "Choices, if the answer is one of a fixed set. Omit for free text." })),
      secretRef: Type.Optional(Type.String({ description: "If this answer is a credential, the secret-store reference to save it under (e.g. extension.jellyfin.api_key). The value is stored, never returned to you — only the reference." })),
    }),
    { minItems: 1, maxItems: 6, description: "Ask everything you need in one batch." },
  ),
});

const systemPlanParams = Type.Object({
  title: Type.String({ description: "One line: the outcome this plan delivers." }),
  findings: Type.Array(Type.String(), { description: "What you inspected and inferred — the evidence. Cite real tool results." }),
  components: Type.Array(
    Type.Object({
      name: Type.String(),
      action: Type.Unsafe<"reuse" | "install" | "configure" | "remove">({ type: "string", enum: ["reuse", "install", "configure", "remove"] }),
      detail: Type.String({ description: "What exactly happens to it and why. Existing, working software is reused, not replaced." }),
    }),
  ),
  steps: Type.Array(Type.String(), { description: "Ordered steps you will take." }),
  verification: Type.Array(Type.String(), { description: "How you will prove the whole system works — architecture checks, not 'the container started'." }),
  notes: Type.Optional(Type.Array(Type.String(), { description: "Irreversible parts, credentials you will create, tradeoffs the user should know." })),
});

const credentialCreateParams = Type.Object({
  ref: Type.String({ description: "Secret-store reference to create, e.g. extension.jellyfin.admin_password or extension.jellyfin.api_key." }),
  purpose: Type.String({ description: "What it is for, shown to the user with the value, e.g. 'Jellyfin admin password for user admin'." }),
  kind: Type.Optional(Type.Unsafe<"password" | "token">({ type: "string", enum: ["password", "token"], description: "password = 20 chars, letters/digits/symbols; token = 32 hex chars. Default password." })),
});

function generateCredential(kind: "password" | "token"): string {
  if (kind === "token") return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#%^*-_=+";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function buildInteractionTools(ctx: InteractionContext) {
  return [
    {
      name: "credential_create",
      label: "Create credential",
      description:
        "Generate a strong password or token for an app on this machine, store it under a secret reference, and show it to the user ONCE. You receive only the reference — never the value. Use this whenever an app needs a new password or API key (a first admin account, an API token); never ask the user to invent one.",
      parameters: credentialCreateParams,
      execute: async (_id: string, params: Static<typeof credentialCreateParams>) => {
        const value = generateCredential(params.kind ?? "password");
        ctx.setSecret(params.ref, value);
        // The one place a secret value is ever sent to the client: the owner needs it to log in
        // themselves. It goes to the user's screen, not into the model's context.
        ctx.send({ type: "notice", level: "credential", text: `Created ${params.purpose} — stored as ${params.ref}. Value (shown once, save it): ${value}` });
        return textResult({ created: true, ref: params.ref, shownToUserOnce: true });
      },
    },
    {
      name: "ask_user",
      label: "Ask the user",
      description:
        "Ask the user one or more questions and wait for the answers, without ending your turn. Only for genuine intent (movies or TV? torrent or Usenet?), credentials Miro cannot obtain itself, tradeoffs that matter to them, or irreversible choices. Never for anything you could find by inspecting the machine — check first. Batch everything you need into one call.",
      parameters: askUserParams,
      execute: async (_id: string, params: Static<typeof askUserParams>) => {
        const answers: Record<string, string> = {};
        for (const q of params.questions) {
          const id = `ask:${crypto.randomUUID()}`;
          if (q.secretRef) {
            ctx.send({ type: "secret_prompt", id, prompt: q.question });
            const value = (await ctx.waitForAnswer(id)).trim();
            if (value) {
              ctx.setSecret(q.secretRef, value);
              answers[q.key] = `[stored as ${q.secretRef}]`;
            } else {
              answers[q.key] = "[no value given]";
            }
            continue;
          }
          ctx.send({ type: "question", id, prompt: q.question, options: q.options ?? [] });
          answers[q.key] = await ctx.waitForAnswer(id);
        }
        return textResult({ answers });
      },
    },
    {
      name: "system_plan",
      label: "Propose plan",
      description:
        "Show the user the architecture you intend to build — findings, components (reuse vs install), ordered steps, and how you will verify it — and wait for one approval. Required before any multi-component setup. After approval, routine operations proceed without re-asking; destructive, lifeline, or irreversible ones still confirm individually.",
      parameters: systemPlanParams,
      execute: async (_id: string, params: Static<typeof systemPlanParams>) => {
        const id = crypto.randomUUID();
        ctx.send({ type: "system_plan", id, ...params });
        ctx.send({
          type: "question",
          id: `plan_confirm:${id}`,
          prompt: `Approve this plan: ${params.title}?`,
          options: [
            { label: "Approve", value: "approve" },
            { label: "Change something", value: "change" },
            { label: "Cancel", value: "cancel" },
          ],
        });
        const answer = await ctx.waitForAnswer(`plan_confirm:${id}`);
        if (answer === "change") {
          const changeId = `plan_change:${id}`;
          ctx.send({ type: "question", id: changeId, prompt: "What should be different?", options: [] });
          const change = await ctx.waitForAnswer(changeId);
          return textResult({ planId: id, approved: false, requestedChange: change });
        }
        return textResult({ planId: id, approved: answer === "approve", cancelled: answer === "cancel" });
      },
    },
  ];
}
