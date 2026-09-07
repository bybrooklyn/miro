import { Type, type Static } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import type { ServerEvent } from "@miro/protocol";
import { openSync, readSync, closeSync, existsSync } from "node:fs";
import { containerLogs } from "../inventory/containers";
import { serviceLogs } from "../inventory/systemd";
import { isSensitivePath, redactSecretsInText } from "../operations/classify";
import { notify as busNotify, testAndConfigure } from "../notifications";
import { parseConfig } from "../secret-intake/parse-config";

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

const requestSecretParams = Type.Object({
  ref: Type.String({ description: "Secret-store reference to save the value under, e.g. provider.github or extension.gluetun.wg_private_key." }),
  prompt: Type.String({ description: "What to ask the owner for, one line - shown above a masked input." }),
});

const pasteConfigParams = Type.Object({
  app: Type.String({ description: "The app/namespace the secrets belong under, e.g. gluetun - used to name the refs (extension.<app>.<name>)." }),
  prompt: Type.Optional(Type.String({ description: "What to ask the owner to paste, one line. Defaults to 'Paste the <app> config'." })),
});

const notifyParams = Type.Object({
  tier: Type.Enum(["routine", "worth_knowing", "needs_attention"], {
    description: "needs_attention reaches the owner's phone (a push) AND the TUI - use it for anything you judge worth interrupting them for. worth_knowing shows in the TUI (now, or on their next connect) but does not push. routine is logged only. Most of what you do should be invisible; do not narrate routine work as notifications.",
  }),
  title: Type.String({ description: "One line, the headline the owner sees first." }),
  body: Type.Optional(Type.String({ description: "Optional detail below the title." })),
});

const notifyConfigureParams = Type.Object({
  channel: Type.Enum(["ntfy", "gotify"], { description: "Which push service to set up." }),
  url: Type.String({ description: "Base URL of the service, e.g. http://127.0.0.1:8090 (ntfy) or the Gotify server URL." }),
  topic: Type.Optional(Type.String({ description: "ntfy only: the topic the owner subscribes to (their address on the server)." })),
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
  pattern: Type.String({ description: "A regular expression with exactly ONE capture group around the value, matched line by line; the NEWEST (last) match wins - an app that prints a fresh first-start password on every start has several. E.g. 'temporary password is provided for this session: (\\\\S+)' or 'ApiKey>([^<]+)<'." }),
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
        // The LAST match: a log appends, and an app that mints a fresh first-start password on every
        // start (qBittorrent) has several such lines - the first was the stale one (run #3).
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = re.exec(lines[i]!);
          if (!m || !m[1]) continue;
          ctx.setSecret(params.ref, m[1]);
          // The line goes back redacted - enough to confirm WHAT matched, never the value itself.
          return textResult({ saved: true, ref: params.ref, source, line: i + 1, matched: redactSecretsInText(lines[i]!.slice(0, 200)), note: "the newest matching line was taken" });
        }
        return textResult({ saved: false, reason: `no line in ${source} matched the pattern (${lines.length} lines read)` });
      },
    },
    {
      name: "notify",
      label: "Notify the owner",
      description:
        "Surface something to the owner proactively, outside a reply they are reading. Choose the tier by how much it warrants their attention: needs_attention pushes to their phone, worth_knowing shows in the TUI, routine is logged. This is how you reach them when they are away or not watching - a job you finished, something you noticed, a problem you handled or could not. You decide what is worth it; keep the routine invisible.",
      parameters: notifyParams,
      execute: async (_id: string, params: Static<typeof notifyParams>) => {
        busNotify({ tier: params.tier, title: params.title, body: params.body ?? "", source: "agent", at: Date.now() });
        return textResult({ notified: true, tier: params.tier, reachedPhone: params.tier === "needs_attention" });
      },
    },
    {
      name: "notify_configure",
      label: "Set up notifications",
      description:
        "Connect a push channel so your needs_attention notifications reach the owner's phone. For ntfy, give the server url and a topic. For Gotify, FIRST call ask_user with secretRef 'notify.gotify.token' to get the owner's Gotify app token (it never reaches you), then call this with the server url. This sends one test notification and only saves the channel if it is accepted.",
      parameters: notifyConfigureParams,
      execute: async (_id: string, params: Static<typeof notifyConfigureParams>) => {
        const result = await testAndConfigure(params.channel, { url: params.url, topic: params.topic });
        return textResult(result.ok ? { configured: true, channel: params.channel } : { configured: false, reason: result.reason });
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
    {
      name: "request_secret",
      label: "Request a secret",
      description:
        "Ask the owner for a single credential (a token, password, or key) and store it by reference. The owner types it into a MASKED field; the value goes straight to the secret store and NEVER reaches you - you get back only the ref. Use this (or paste_config for a whole config) instead of a plain question whenever you need a human-held secret; never ask for a secret in ordinary chat.",
      parameters: requestSecretParams,
      execute: async (_id: string, p: Static<typeof requestSecretParams>) => {
        const id = `ask:${crypto.randomUUID()}`;
        ctx.send({ type: "secret_prompt", id, prompt: p.prompt });
        const value = (await ctx.waitForAnswer(id)).trim();
        if (!value || value === NO_USER_ANSWER) return textResult({ stored: false, reason: value === NO_USER_ANSWER ? "no user available" : "no value given" });
        ctx.setSecret(p.ref, value);
        return textResult({ stored: true, ref: p.ref });
      },
    },
    {
      name: "paste_config",
      label: "Paste a config",
      description:
        "Ask the owner to paste a whole credential/config blob (a WireGuard .conf, a .env, a provider block) into a MASKED field. Miro parses it locally: secret values are stored by reference, the non-secret parts (endpoints, addresses, public keys) are returned to you as config. The raw paste and the secret values NEVER reach you. Use this for multi-value credentials instead of asking the owner to paste into chat.",
      parameters: pasteConfigParams,
      execute: async (_id: string, p: Static<typeof pasteConfigParams>) => {
        const id = `ask:${crypto.randomUUID()}`;
        ctx.send({ type: "secret_prompt", id, prompt: p.prompt ?? `Paste the ${p.app} config` });
        const raw = (await ctx.waitForAnswer(id)).trim();
        if (!raw || raw === NO_USER_ANSWER) return textResult({ stored: false, reason: raw === NO_USER_ANSWER ? "no user available" : "no value given" });
        const parsed = parseConfig(raw, p.app);
        for (const s of parsed.secrets) ctx.setSecret(s.ref, s.value);
        return textResult({ format: parsed.format, storedRefs: parsed.secrets.map((s) => s.ref), config: parsed.settings, summary: parsed.summary });
      },
    },
  ];
}
