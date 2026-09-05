import { Type, type Static } from "@miro/schema-engine/typebox";
import { textResult } from "./tool-result";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { classifyCommand, isSensitivePath, isLocalOrPrivateUrl, redactSecretsInText } from "../operations/classify";
import { anchoredView } from "../operations/hashline";
import { runSandboxed, sandboxAvailable } from "../operations/sandbox";
import { commandExists, runPrivileged } from "../inventory/exec";
import { readTextCapped } from "../fetch-body";

// Read-only primitives that need a little context (PLAN.md §5.4 B): a sandboxed shell for
// inspection, a file reader with the secret-path guard, an HTTP GET with credentials by reference,
// and packet capture - the last rung of the learn agent's discovery ladder. Kept out of
// agent/tools.ts's static AGENT_TOOLS because http_get needs getSecret and the rest need a
// sandbox. Everything here is read-only; the narrow investigation workers (agent/worker.ts) still
// see only AGENT_TOOLS, so these reach a worker only if one is ever handed a context.

const shellInspectParams = Type.Object({
  command: Type.String({ description: "A read-only inspection command (ip route, docker inspect, ss -tlnp, cat /etc/x, journalctl -u x, ...). Anything that would change state is refused - use shell_command for that. Use absolute paths." }),
});

const readFileParams = Type.Object({
  path: Type.String({ description: "Absolute path." }),
  maxBytes: Type.Optional(Type.Integer({ description: "Cap on bytes returned (default 65536)." })),
  offset: Type.Optional(Type.Integer({ description: "Byte offset to start from (default 0)." })),
  anchored: Type.Optional(Type.Boolean({ description: "true to tag every line as N:hhhh|text - the anchors file_edit takes. Needs offset 0." })),
});

const httpGetParams = Type.Object({
  url: Type.String({ description: "Local or private-network URL only." }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Non-credential headers. Credentials go in secretHeader by reference." })),
  secretHeader: Type.Optional(Type.Object({ name: Type.String(), ref: Type.String({ description: "Secret store reference, e.g. extension.jellyfin.api_key" }) })),
});

const netCaptureParams = Type.Object({
  durationSeconds: Type.Integer({ description: "How long to capture (1-60). Perform the action you want to observe while it runs." }),
  filter: Type.Optional(Type.String({ description: "BPF capture filter, e.g. 'tcp port 8096' or 'host 172.17.0.2'. Strongly recommended - unfiltered captures are noisy." })),
  interface: Type.Optional(Type.String({ description: "Interface name (default 'any')." })),
  mode: Type.Optional(Type.Enum(["summary", "http"], { description: "summary = one line per packet (time, src→dst, protocol, info). http = decoded plaintext HTTP requests/responses only (method, URI, status, body). Default summary." })),
});

export interface ReadToolContext {
  getSecret: (ref: string) => string | null;
}

/** Reads at most `max` bytes from `offset` without loading the whole file - `read_file /dev/zero`
 * or a multi-GB log must not take the daemon down (adversarial review). */
function readCapped(path: string, offset: number, max: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, offset);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function buildReadTools(ctx: ReadToolContext) {
  let sandboxOk: Promise<boolean> | null = null;
  const sandbox = () => (sandboxOk ??= sandboxAvailable());

  return [
    {
      name: "shell_inspect",
      label: "Inspect (shell)",
      description:
        "Run a read-only shell command in a read-only filesystem sandbox and return its output. Use for ad-hoc inspection: routes, sockets, container internals, config files, logs. Commands that would change state are refused with the reason - use shell_command for those. Secret material (keys, Miro's own state, credential files) is refused.",
      parameters: shellInspectParams,
      execute: async (_id: string, params: Static<typeof shellInspectParams>) => {
        const c = classifyCommand(params.command);
        if (c.class !== "read") {
          return textResult({ refused: true, class: c.class, reasons: c.reasons, hint: c.class === "forbidden" ? c.alternative : "This changes state - run it with shell_command instead, declaring what it writes." });
        }
        if (!(await sandbox())) return textResult({ unavailable: true, reason: "bubblewrap is not installed; refusing to run unsandboxed" });
        // Host network namespace only for commands that inspect the network (ip, ss, dig, local
        // curl ...); everything else runs with no network at all, so a read can never be an egress.
        const r = await runSandboxed(["sh", "-c", params.command], { writableRoots: [], network: c.needsNetwork, timeoutMs: 60_000 });
        return textResult({ exitCode: r.exitCode, stdout: redactSecretsInText(r.stdout), stderr: redactSecretsInText(r.stderr), timedOut: r.timedOut, truncated: r.truncated });
      },
    },
    {
      name: "read_file",
      label: "Read file",
      description: "Read a file's contents (capped). With anchored: true every line is tagged N:hhhh| - the anchors file_edit takes, so read a file that way before editing it. Secret material - private keys, /etc/shadow, Miro's own key and database, credential files - is refused.",
      parameters: readFileParams,
      execute: async (_id: string, params: Static<typeof readFileParams>) => {
        if (isSensitivePath(params.path)) return textResult({ refused: true, reason: `${params.path} is secret material` });
        if (params.anchored && params.offset) return textResult({ refused: true, reason: "anchored needs offset 0 - line numbers count from the start of the file" });
        if (!existsSync(params.path)) return textResult({ missing: true, path: params.path });
        const st = statSync(params.path);
        if (st.isDirectory()) return textResult({ directory: true, path: params.path, hint: "use shell_inspect with ls" });
        if (!st.isFile()) return textResult({ refused: true, reason: `${params.path} is not a regular file` });
        // Model input: a negative maxBytes reached Buffer.alloc(-1) as an opaque RangeError (audit R5).
        const max = Math.max(1, Math.min(params.maxBytes ?? 65_536, 1_048_576));
        const offset = Math.max(0, params.offset ?? 0);
        const buf = readCapped(params.path, offset, max);
        const binary = buf.subarray(0, 1024).includes(0);
        return textResult({
          path: params.path,
          size: st.size,
          offset,
          returned: buf.length,
          truncated: offset + buf.length < st.size,
          // Anchors hash the REAL line (so an edit to a redacted line still matches); the tags survive
          // redaction because they sit before the text the regexes look at.
          ...(binary ? { binary: true, note: "binary content omitted" } : { content: redactSecretsInText(params.anchored ? anchoredView(buf.toString("utf-8")) : buf.toString("utf-8")) }),
        });
      },
    },
    {
      name: "http_get",
      label: "HTTP GET",
      description: "GET a local or private-network URL and return status, headers, and body (capped). Credentials only as a secretHeader reference - never pasted literally. Redirects are reported, not followed.",
      parameters: httpGetParams,
      execute: async (_id: string, params: Static<typeof httpGetParams>) => {
        if (!isLocalOrPrivateUrl(params.url)) return textResult({ refused: true, reason: `${params.url} is not a local or private-network address` });
        if (params.headers && Object.keys(params.headers).some((k) => /authorization|token|api[-_]?key|cookie|secret|password/i.test(k))) {
          return textResult({ refused: true, reason: "credentials must be passed via secretHeader by reference" });
        }
        const headers: Record<string, string> = { ...(params.headers ?? {}) };
        if (params.secretHeader) {
          const value = ctx.getSecret(params.secretHeader.ref);
          if (!value) return textResult({ error: `secret ${params.secretHeader.ref} is not set` });
          headers[params.secretHeader.name] = value;
        }
        try {
          const res = await fetch(params.url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
          const body = await readTextCapped(res, 65_536);
          const resHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => { if (!/set-cookie|authorization/i.test(k)) resHeaders[k] = v; });
          return textResult({ status: res.status, headers: resHeaders, body: redactSecretsInText(body) });
        } catch (err) {
          return textResult({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      name: "net_capture",
      label: "Capture packets",
      description:
        "Capture network traffic for a few seconds and return a machine-readable summary - the last resort of discovery, for when docs, API probing, config files and the CLI have not explained how an app is controlled: watch what a web UI sends to its backend, find undocumented local calls, confirm which port/protocol a component speaks, or check that traffic takes the intended path (VPN, DNS). Always filter. Run the action you want to observe while the capture is open (start the capture, then trigger the action from another tool).",
      parameters: netCaptureParams,
      execute: async (_id: string, params: Static<typeof netCaptureParams>) => {
        if (!(await commandExists("tshark"))) return textResult({ unavailable: true, reason: "tshark is not installed" });
        const duration = Math.max(1, Math.min(60, params.durationSeconds));
        const mode = params.mode ?? "summary";
        const fields =
          mode === "http"
            ? ["-Y", "http", "-e", "frame.time_relative", "-e", "ip.src", "-e", "tcp.srcport", "-e", "ip.dst", "-e", "tcp.dstport", "-e", "http.request.method", "-e", "http.host", "-e", "http.request.uri", "-e", "http.response.code", "-e", "http.content_type", "-e", "http.file_data"]
            : ["-e", "frame.time_relative", "-e", "ip.src", "-e", "tcp.srcport", "-e", "udp.srcport", "-e", "ip.dst", "-e", "tcp.dstport", "-e", "udp.dstport", "-e", "_ws.col.Protocol", "-e", "_ws.col.Info"];
        const args = ["tshark", "-l", "-n", "-i", params.interface ?? "any", "-a", `duration:${duration}`, ...(params.filter ? ["-f", params.filter] : []), "-T", "fields", "-E", "separator=|", "-E", "header=y", ...fields];
        // Capture needs CAP_NET_RAW: root in production; sudo on a dev box running mirod unprivileged.
        try {
          const out = await runPrivileged(args, { timeoutMs: (duration + 15) * 1000 });
          const lines = out.split("\n").filter(Boolean);
          const capped = lines.slice(0, 500).map((line, i) => {
            // tshark emits http.file_data (the last field in http mode) hex-encoded; decode it so
            // the model reads the body, then mask anything credential-shaped.
            if (mode !== "http" || i === 0) return redactSecretsInText(line);
            const cells = line.split("|");
            const body = cells[cells.length - 1];
            if (body && body.length % 2 === 0 && /^[0-9a-f]+$/i.test(body)) {
              cells[cells.length - 1] = Buffer.from(body, "hex").toString("utf-8").replace(/[\r\n]+/g, " ").slice(0, 2000);
            }
            return redactSecretsInText(cells.join("|"));
          });
          return textResult({ mode, interface: params.interface ?? "any", filter: params.filter ?? null, durationSeconds: duration, packets: lines.length - 1, truncated: lines.length > capped.length, lines: capped });
        } catch (err) {
          return textResult({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
  ];
}
