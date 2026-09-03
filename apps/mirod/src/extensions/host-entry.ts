#!/usr/bin/env bun
// Extension-host subprocess bootstrap (plan §34). Spawned by extensions/host.ts via Bun.spawn,
// one process per app, communicating over stdin/stdout via @miro/protocol's encodeLine/
// createLineBuffer JSON-line framing. This file is fixed and hand-written - never generated - and
// deliberately has no import path to bun:sqlite/secrets.ts/operations/engine.ts, so nothing
// generated code does can reach those, regardless of what it tries to import. (The second layer
// of the same boundary is extensions/validate.ts's forbidden-import allowlist scan, run before
// any generated code is ever loaded here.)

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { encodeLine, createLineBuffer } from "@miro/protocol";
import { createHttpClient, type ExtensionContext, type ExtensionModule, type BrowserSession, type SnapshotNode, type ReadResult } from "@miro/sdk";
import type { HostRequest, HostResponse, HostToolSpec } from "./host-protocol";
import { runRead, entrySpec, validateEntry } from "./declarative";
// Pure / CLI-backed modules with no path to the DB or secrets - safe to import into this process.
// They let generated code's ctx.exec/ctx.readFile be gated by the same classifier and sandbox the
// daemon uses (PLAN.md §5.7), without a reverse RPC.
import { classifyCommand, isSensitivePath, redactSecretsInText } from "../operations/classify";
import { runSandboxed, sandboxAvailable } from "../operations/sandbox";

function send(res: HostResponse): void {
  process.stdout.write(encodeLine(res));
}

// --- BrowserSession, backed by Bun.WebView (research finding: Playwright doesn't work under
// Bun; Bun.WebView is the confirmed-working native replacement - live-verified against real
// Chromium on the real dev VM before this file was written: navigate/evaluate both work).
// Built lazily on first real use - an extension whose tools are pure HTTP never pays for a
// Chromium launch. Chrome discovery is left to Bun.WebView's own built-in fallback chain
// (BUN_CHROME_PATH -> $PATH -> standard install dirs) rather than a hardcoded path, so this
// works across whatever server Miro is actually managing, not just this dev VM. ---

// Bun.WebView has no accessibility-tree/snapshot API and no stable selector scheme of its own -
// this tags every snapshotted element with a data-miro-ref marker so a later click/fill/read can
// reliably re-select the exact element the snapshot returned, without relying on the page having
// usable ids/classes of its own.
const SNAPSHOT_JS = `(() => {
  const nodes = [];
  const sel = 'a,button,input,select,textarea,[role],h1,h2,h3';
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (nodes.length >= 200) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const ref = 'miro-ref-' + (i++);
    el.setAttribute('data-miro-ref', ref);
    nodes.push({
      selector: '[data-miro-ref="' + ref + '"]',
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 200),
    });
  }
  return nodes;
})()`;

function createBrowserSession(): BrowserSession {
  let wv: InstanceType<typeof Bun.WebView> | null = null;

  function ensure(): InstanceType<typeof Bun.WebView> {
    if (!wv) wv = new Bun.WebView({ headless: true });
    return wv;
  }

  return {
    async open(url) {
      // navigate() can wait forever on a single-page app that never settles (found live on
      // Jellyfin's web UI); the session is still usable afterwards, so time out and let the
      // agent snapshot whatever has rendered.
      await Promise.race([
        ensure().navigate(url),
        Bun.sleep(30_000).then(() => {
          throw new Error(`navigate to ${url} did not settle within 30s - snapshot the page as it is`);
        }),
      ]);
    },
    async snapshot() {
      return (await ensure().evaluate(SNAPSHOT_JS)) as SnapshotNode[];
    },
    async find(query) {
      const all = (await ensure().evaluate(SNAPSHOT_JS)) as SnapshotNode[];
      return all.filter((n) => {
        if (query.role && n.role !== query.role) return false;
        if (query.selector && n.selector !== query.selector) return false;
        if (query.text && !n.text.toLowerCase().includes(query.text.toLowerCase())) return false;
        return true;
      });
    },
    async click(selector) {
      await ensure().click(selector);
    },
    async fill(selector, value) {
      const view = ensure();
      await view.click(selector);
      await view.type(value);
    },
    async select(selector, value) {
      await ensure().evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error(${JSON.stringify(`select: no element for ${selector}`)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    },
    async read(selector) {
      const expr = selector
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const attributes = {};
            for (const a of el.attributes) attributes[a.name] = a.value;
            return { text: (el.innerText || el.value || '').trim().slice(0, 2000), value: el.value, attributes };
          })()`
        : `({ text: document.body.innerText.trim().slice(0, 2000) })`;
      const result = (await ensure().evaluate(expr)) as ReadResult | null;
      if (result === null) throw new Error(`read: no element for ${selector}`);
      return result;
    },
    async wait(selector, timeoutMs = 10000) {
      const view = ensure();
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = await view.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
        if (found) return;
        await Bun.sleep(200);
      }
      throw new Error(`Timed out waiting for ${selector}`);
    },
    close() {
      wv?.close();
      wv = null;
    },
  };
}

// --- Generated-extension loading (init mode) ---

// extension.ts doesn't exist in the source tree - it's written per-extension at runtime under
// ~/.miro/extensions/<app>/. Two issues, both handled here:
// 1. A plain string-literal import() would make TS try (and fail) to statically resolve it;
//    routing the specifier through a non-literal `string` parameter opts out of that resolution
//    attempt entirely (standard TS behavior: only literal import() specifiers get statically
//    resolved).
// 2. A relative import() specifier resolves against the IMPORTING MODULE'S OWN location (this
//    file, in apps/mirod/src/extensions/), never against process.cwd() - cwd only affects
//    process.cwd() calls and Node-style path resolution, not ESM import resolution. Bun.spawn's
//    cwd option (set by extensions/host.ts) still correctly sets process.cwd() inside this
//    process, so building an absolute path from it here works. (Found live: an isolated RPC
//    smoke test threw "Cannot find module './tools.ts'" before this fix.)
function importGenerated(relativePath: string): Promise<any> {
  return import(join(process.cwd(), relativePath));
}

interface LoadedExtension {
  tools: Map<string, { spec: HostToolSpec; execute: (args: any) => Promise<unknown> }>;
  operations: Map<string, { spec: HostToolSpec; bind: (args: any) => unknown }>;
}

// The declarative-read interpreter + entry validation live in ./declarative (pure, unit-tested).
async function loadExtension(ctx: ExtensionContext): Promise<LoadedExtension> {
  const mod = (await importGenerated("./extension.ts")).default as ExtensionModule;
  if (!mod || !Array.isArray(mod.entries)) throw new Error(`extension.ts must \`export default { auth?, entries } satisfies ExtensionModule\` - entries missing`);
  const tools: LoadedExtension["tools"] = new Map();
  const operations: LoadedExtension["operations"] = new Map();
  for (const entry of mod.entries) {
    validateEntry(entry);
    const spec = entrySpec(entry);
    if (entry.kind === "operation") {
      operations.set(entry.name, { spec, bind: (args) => entry.bind!(args) });
    } else if (entry.read) {
      tools.set(entry.name, { spec, execute: (args) => runRead(ctx, mod, entry.read!, args) });
    } else {
      tools.set(entry.name, { spec, execute: (args) => entry.code!(ctx, args) });
    }
  }
  return { tools, operations };
}

/** The read-only primitives generated code gets (PLAN.md §5.2 C, adaptive control method): the
 * daemon's classifier decides read vs. not, bubblewrap makes read-only true in the kernel. */
function createReadPrimitives(): Pick<ExtensionContext, "exec" | "readFile"> {
  return {
    async exec(command) {
      const c = classifyCommand(command);
      if (c.class !== "read") throw new Error(`refused: ${command} is ${c.class} (${c.reasons.join("; ")}) - extension code may only read; writes are operation bindings`);
      if (!(await sandboxAvailable())) throw new Error("refused: sandbox unavailable");
      // Network only for network-inspecting commands, like shell_inspect - generated code holding
      // ctx.secrets must not be able to curl them anywhere (adversarial review).
      const r = await runSandboxed(["sh", "-c", command], { writableRoots: [], network: c.needsNetwork, timeoutMs: 60_000 });
      return { exitCode: r.exitCode, stdout: redactSecretsInText(r.stdout), stderr: redactSecretsInText(r.stderr) };
    },
    async readFile(path) {
      if (isSensitivePath(path)) throw new Error(`refused: ${path} is secret material`);
      return redactSecretsInText(readFileSync(path).subarray(0, 256 * 1024).toString("utf-8"));
    },
  };
}

// --- Main ---

let mode: "init" | "learn_init" | null = null;
let browser: BrowserSession | null = null;
let loaded: LoadedExtension | null = null;

const feed = createLineBuffer((line) => {
  handle(JSON.parse(line) as HostRequest).catch((err) => {
    send({ type: "log", level: "error", message: String(err?.stack ?? err) });
    // A failure during init (a generated file that fails to even import) means this process can
    // never usefully respond to anything - exiting lets host.ts's spawn-time race (waitReady vs.
    // proc.exited) reject promptly instead of hanging forever waiting for a "ready" that will
    // never come. Found live: an isolated RPC smoke test hung indefinitely before this fix.
    process.exit(1);
  });
});

process.stdin.on("data", (chunk) => feed(chunk));

async function handle(req: HostRequest): Promise<void> {
  if (req.type === "init") {
    mode = "init";
    browser = createBrowserSession();
    const ctx: ExtensionContext = { http: createHttpClient(req.baseUrl, authHeaders(req.secrets)), browser, secrets: req.secrets, ...createReadPrimitives() };
    loaded = await loadExtension(ctx);
    send({ type: "ready" });
    return;
  }
  if (req.type === "learn_init") {
    mode = "learn_init";
    browser = createBrowserSession();
    send({ type: "ready" });
    return;
  }
  if (req.type === "call") {
    if (mode === "learn_init") {
      try {
        const value = await callBrowserTool(req.tool, req.args);
        send({ type: "result", id: req.id, ok: true, value });
      } catch (err) {
        send({ type: "result", id: req.id, ok: false, error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }
    const entry = loaded?.tools.get(req.tool);
    if (!entry) {
      const isOp = loaded?.operations.has(req.tool);
      send({ type: "result", id: req.id, ok: false, error: isOp ? `${req.tool} is an operation - it runs through the daemon's engine, never here` : `Unknown tool: ${req.tool}` });
      return;
    }
    try {
      const value = await entry.execute(req.args);
      send({ type: "result", id: req.id, ok: true, value });
    } catch (err) {
      send({ type: "result", id: req.id, ok: false, error: String(err instanceof Error ? err.message : err) });
    }
    return;
  }
  if (req.type === "bind") {
    const entry = loaded?.operations.get(req.tool);
    if (!entry) {
      send({ type: "result", id: req.id, ok: false, error: `Unknown operation: ${req.tool}` });
      return;
    }
    try {
      // await: a generated `bind: async (args) => ({...})` is natural next to an async execute,
      // and unawaited it serialised as {} - "binding must include kind and goal" on a file that
      // plainly had both (found live, run #5).
      const value = await entry.bind(req.args);
      send({ type: "result", id: req.id, ok: true, value });
    } catch (err) {
      send({ type: "result", id: req.id, ok: false, error: String(err instanceof Error ? err.message : err) });
    }
    return;
  }
  if (req.type === "list_tools") {
    const tools = loaded ? [...[...loaded.tools.values()].map((e) => e.spec), ...[...loaded.operations.values()].map((e) => e.spec)] : [];
    send({ type: "tools", id: req.id, tools });
    return;
  }
  if (req.type === "shutdown") {
    browser?.close();
    process.exit(0);
  }
}

function authHeaders(secrets: Record<string, string>): Record<string, string> {
  // The default baked into ctx.http for `code` entries: a declared secret named "api_key" (if
  // present) is sent as Authorization: Bearer <value>. Declarative `read` entries override this via
  // the module's `auth` (e.g. Jellyfin's X-Emby-Token); a `code` entry can also read ctx.secrets
  // directly for an app-specific header scheme.
  return secrets.api_key ? { Authorization: `Bearer ${secrets.api_key}` } : {};
}

async function callBrowserTool(tool: string, args: any): Promise<unknown> {
  if (!browser) throw new Error("browser session not initialized");
  switch (tool) {
    case "browser_open":
      return browser.open(args.url);
    case "browser_snapshot":
      return browser.snapshot();
    case "browser_find":
      return browser.find(args);
    case "browser_click":
      return browser.click(args.selector);
    case "browser_fill":
      return browser.fill(args.selector, args.value);
    case "browser_select":
      return browser.select(args.selector, args.value);
    case "browser_read":
      return browser.read(args.selector);
    case "browser_wait":
      return browser.wait(args.selector, args.timeoutMs);
    default:
      throw new Error(`Unknown browser tool: ${tool}`);
  }
}
