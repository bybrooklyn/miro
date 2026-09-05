import { Type, type Static } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import type { ServerEvent } from "@miro/protocol";
import { openSync, readSync, closeSync, existsSync } from "node:fs";
import { containerLogs } from "../inventory/containers";
import { serviceLogs } from "../inventory/systemd";
import { isSensitivePath, redactSecretsInText } from "../operations/classify";

// The two tools that make the outcome loop conversational without ending the turn (PLAN.md
// §5.4 A): ask_user for the intent Miro genuinely cannot infer, and system_plan for the one
// approval an experienced self-hoster wants before a multi-component change. Both ride on the
// existing question/secret_prompt events and the connection's pending-answer map - the same
// mechanism operation confirmations already use - so nothing new crosses the wire for answers.

export interface InteractionContext {
  send: (event: ServerEvent) => void;
  waitForAnswer: (id: string) => Promise<string>;
  /** Called with each secret answer so it is stored by reference - the model never sees the value. */
  setSecret: (ref: string, value: string) => void;
}

const askUserParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      key: Type.String({ description: "Short identifier for this answer in the result, e.g. media_types." }),
      question: Type.String({ description: "The question, phrased around the user's intent - never around implementation you could decide yourself." }),
      options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), { description: "Choices, if the answer is one of a fixed set. Omit for free text." })),
      secretRef: Type.Optional(Type.String({ description: "If this answer is a credential, the secret-store reference to save it under (e.g. extension.jellyfin.api_key). The value is stored, never returned to you - only the reference." })),
    }),
    { minItems: 1, maxItems: 6, description: "Ask everything you need in one batch." },
  ),
});

const systemPlanParams = Type.Object({
  title: Type.String({ description: "One line: the outcome this plan delivers." }),
  findings: Type.Array(Type.String(), { description: "What you inspected and inferred - the evidence. Cite real tool results." }),
  components: Type.Array(
    Type.Object({
      name: Type.String(),
      action: Type.Enum(["reuse", "install", "configure", "remove"]),
      detail: Type.String({ description: "What exactly happens to it and why. Existing, working software is reused, not replaced." }),
    }),
  ),
  steps: Type.Array(Type.String(), { description: "Ordered steps you will take." }),
  verification: Type.Array(Type.String(), { description: "How you will prove the whole system works - architecture checks, not 'the container started'." }),
  notes: Type.Optional(Type.Array(Type.String(), { description: "Irreversible parts, credentials you will create, tradeoffs the user should know." })),
});

const credentialCreateParams = Type.Object({
  ref: Type.String({ description: "Secret-store reference to create, e.g. extension.jellyfin.admin_password or extension.jellyfin.api_key." }),
  purpose: Type.String({ description: "What it is for, shown to the user with the value, e.g. 'Jellyfin admin password for user admin'." }),
  kind: Type.Optional(Type.Enum(["password", "token"], { description: "password = 20 chars, letters/digits/symbols; token = 32 hex chars. Default password." })),
});

const credentialCaptureParams = Type.Object({
  ref: Type.String({ description: "Secret-store reference to save the captured value under: extension.<app>.<name>, e.g. extension.qbittorrent.bootstrap_password." }),
  from: Type.Object(
    {
      container: Type.Optional(Type.String({ description: "Capture from this container's log (docker logs, last 500 lines)." })),
      unit: Type.Optional(Type.String({ description: "Capture from this systemd unit's journal (last 500 lines)." })),
      path: Type.Optional(Type.String({ description: "Capture from this file (first 256 KB). Miro's own state and credential files are refused." })),
    },
    { description: "Exactly one source." },
  ),
  pattern: Type.String({ description: "A regular expression with exactly ONE capture group around the value, matched line by line; the first match wins. E.g. 'temporary password is provided for this session: (\\\\S+)' or 'ApiKey>([^<]+)<'." }),
});

/** The only credential refs an agent may write - Miro's own refs (provider.*, transport.*, oauth.*) never. */
const CAPTURABLE_REF = /^extension\.[a-z0-9][a-z0-9_-]*\.[a-z0-9_][a-z0-9_-]*$/i;

function readHead(path: string, max = 256 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function generateCredential(kind: "password" | "token"): string {
  if (kind === "token") return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#%^*-_=+";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** What an autonomous session (a repair, with nobody on the other end) answers every question
 * with. The model is told to decide or stop; it is never a value to store anywhere. */
export const NO_USER_ANSWER = "[no user available - decide yourself or stop]";

export function buildInteractionTools(ctx: InteractionContext) {
  return [
    {
      name: "credential_create",
      label: "Create credential",
      description:
        "Generate a strong password or token for an app on this machine, store it under a secret reference, and show it to the user ONCE. You receive only the reference - never the value. Use this whenever an app needs a new password or API key (a first admin account, an API token); never ask the user to invent one.",
      parameters: credentialCreateParams,
      execute: async (_id: string, params: Static<typeof credentialCreateParams>) => {
        const value = generateCredential(params.kind ?? "password");
        ctx.setSecret(params.ref, value);
        // The one place a secret value is ever sent to the client: the owner needs it to log in
        // themselves. It goes to the user's screen, not into the model's context.
        ctx.send({ type: "notice", level: "credential", text: `Created ${params.purpose} - stored as ${params.ref}. Value (shown once, save it): ${value}` });
        return textResult({ created: true, ref: params.ref, shownToUserOnce: true });
      },
    },
    {
      name: "credential_capture",
      label: "Capture credential",
      description:
        "Take a credential the MACHINE produced - a first-start password an app printed to its container log, an API key in its config file, a token in a journal line - straight into the secret store by reference. Every read tool redacts such values before you see them, so this is the way to use one: give the source and a regex with one capture group; you get back the reference, never the value. Then use {{secret:<ref>}} in http_mutation or a secretHeader. Never ask the user for a value that is already on this machine.",
      parameters: credentialCaptureParams,
      execute: async (_id: string, params: Static<typeof credentialCaptureParams>) => {
        if (!CAPTURABLE_REF.test(params.ref)) return textResult({ saved: false, reason: `ref must be extension.<app>.<name>, got ${params.ref}` });
        // Models fill the optional sources they are not using with null (or ""), and some send the
        // object as a JSON string - both are "absent", not "a second source" (found live, golden-proof
        // run #2: every call was refused as ambiguous).
        let from = params.from as unknown;
        if (typeof from === "string") {
          try { from = JSON.parse(from); } catch { return textResult({ saved: false, reason: "from must be an object: { container } | { unit } | { path }" }); }
        }
        const f = (from ?? {}) as Record<string, unknown>;
        const given = (["container", "unit", "path"] as const).filter((k) => typeof f[k] === "string" && (f[k] as string).trim() !== "");
        if (given.length !== 1) return textResult({ saved: false, reason: `give exactly one of from.container, from.unit, from.path (got ${given.length ? given.join(" and ") : "none"})` });
        const source0 = { kind: given[0]!, value: (f[given[0]!] as string).trim() };
        let re: RegExp;
        try {
          re = new RegExp(params.pattern);
        } catch (err) {
          return textResult({ saved: false, reason: `pattern does not compile: ${String(err instanceof Error ? err.message : err)}` });
        }
        if (new RegExp(`${re.source}|`).exec("")!.length !== 2) return textResult({ saved: false, reason: "pattern needs exactly one capture group around the value" });
        let lines: string[];
        const source = `${source0.kind} ${source0.value}`;
        try {
          if (source0.kind === "container") {
            lines = (await containerLogs(source0.value, 500)).map((l) => l.line);
          } else if (source0.kind === "unit") {
            const r = await serviceLogs(source0.value, 500);
            if (!r.available) return textResult({ saved: false, reason: `journal for ${source0.value} is not available here` });
            lines = r.logs.map((l) => l.line);
          } else {
            if (isSensitivePath(source0.value)) return textResult({ saved: false, reason: `${source0.value} is Miro's own state or a credential file - refused` });
            if (!existsSync(source0.value)) return textResult({ saved: false, reason: `${source0.value} does not exist` });
            lines = readHead(source0.value).split("\n");
          }
        } catch (err) {
          return textResult({ saved: false, reason: `could not read ${String(err instanceof Error ? err.message : err)}` });
        }
        for (let i = 0; i < lines.length; i++) {
          const m = re.exec(lines[i]!);
          if (!m || !m[1]) continue;
          ctx.setSecret(params.ref, m[1]);
          // The line goes back redacted - enough to confirm WHAT matched, never the value itself.
          return textResult({ saved: true, ref: params.ref, source, line: i + 1, matched: redactSecretsInText(lines[i]!.slice(0, 200)) });
        }
        return textResult({ saved: false, reason: `no line in ${source} matched the pattern (${lines.length} lines read)` });
      },
    },
    {
      name: "ask_user",
      label: "Ask the user",
      description:
        "Ask the user one or more questions and wait for the answers, without ending your turn. Only for genuine intent (movies or TV? torrent or Usenet?), credentials Miro cannot obtain itself, tradeoffs that matter to them, or irreversible choices. Never for anything you could find by inspecting the machine - check first. Batch everything you need into one call.",
      parameters: askUserParams,
      execute: async (_id: string, params: Static<typeof askUserParams>) => {
        const answers: Record<string, string> = {};
        for (const q of params.questions) {
          const id = `ask:${crypto.randomUUID()}`;
          if (q.secretRef) {
            ctx.send({ type: "secret_prompt", id, prompt: q.question });
            const value = (await ctx.waitForAnswer(id)).trim();
            // Never store the no-user marker as a credential: found live on the dev VM, where an
            // autonomous repair had stored it as an app's API key (PLAN.md §5.20).
            if (value && value !== NO_USER_ANSWER) {
              ctx.setSecret(q.secretRef, value);
              answers[q.key] = `[stored as ${q.secretRef}]`;
            } else {
              answers[q.key] = value === NO_USER_ANSWER ? value : "[no value given]";
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
        "Show the user the architecture you intend to build - findings, components (reuse vs install), ordered steps, and how you will verify it - and wait for one approval. Required before any multi-component setup. After approval, routine operations proceed without re-asking; destructive, lifeline, or irreversible ones still confirm individually.",
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
