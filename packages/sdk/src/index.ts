import { Type, type Static } from "@earendil-works/pi-ai";

// The API surface a generated extension (one file, extension.ts - PLAN.md §5.13) is allowed to
// use - everything else is denied by extensions/validate.ts's forbidden-import allowlist scan.
// Deliberately read-only: HttpClient exposes only get(); writes are declarative bindings the daemon
// runs through its engine. Most entries are declarative DATA (read/bind); `code` is the escape
// hatch for a read that genuinely needs logic.

export { Type, type Static };

/** What ctx.http.get resolves to - the actual HTTP response, not a pre-parsed body. A non-2xx is
 * returned (never thrown), so a health check can read `status` directly; `json()` parses `body`. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  json<T = any>(): T;
}

export interface HttpClient {
  get(path: string, opts?: { query?: Record<string, string>; headers?: Record<string, string> }): Promise<HttpResponse>;
}

function withQuery(path: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return path;
  return `${path}?${new URLSearchParams(query).toString()}`;
}

function response(status: number, body: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, body, json: <T,>() => JSON.parse(body) as T };
}

/** Real client - used by extensions/host-entry.ts's `init`/`learn_init` modes. Per-call headers
 * merge over the client's fixed auth headers. */
export function createHttpClient(baseUrl: string, headers: Record<string, string>): HttpClient {
  return {
    async get(path, opts) {
      const res = await fetch(new URL(withQuery(path, opts?.query), baseUrl), { headers: { ...headers, ...opts?.headers } });
      return response(res.status, await res.text());
    },
  };
}

/** Fixture-based fake client - deterministic, no real network. A fixture value is the response body
 * (an object is JSON-encoded, a string used verbatim); wrap it as `{ status, body }` to fix a
 * non-200. Exact-path match only (query string ignored). Used by unit tests and, from slice 2, to
 * replay a captured trace against a declarative read as its own canary (PLAN.md §5.13). */
export function createFakeHttpClient(routes: Record<string, unknown> = {}): HttpClient {
  return {
    async get(path) {
      const key = path.split("?")[0];
      if (!(key in routes)) throw new Error(`No fixture for GET ${path}`);
      const v = routes[key];
      if (v !== null && typeof v === "object" && "status" in v && "body" in v) {
        const b = (v as { body: unknown }).body;
        return response((v as { status: number }).status, typeof b === "string" ? b : JSON.stringify(b));
      }
      return response(200, typeof v === "string" ? v : JSON.stringify(v));
    },
  };
}

export interface SnapshotNode {
  selector: string;
  tag: string;
  role: string | null;
  text: string;
}

export interface ReadResult {
  text: string;
  value?: string;
  attributes?: Record<string, string>;
}

/** Implemented only inside extensions/host-entry.ts (needs Bun.WebView, which only exists in the
 * extension-host process) - this package declares the shape, not the implementation. */
export interface BrowserSession {
  open(url: string): Promise<void>;
  snapshot(): Promise<SnapshotNode[]>;
  find(query: { text?: string; selector?: string; role?: string }): Promise<SnapshotNode[]>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  read(selector?: string): Promise<ReadResult>;
  wait(selector: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

export interface ExtensionTool<P = any> {
  name: string;
  /** Human label for the UI; defaults to `name` when omitted (generated code rarely sets it). */
  label?: string;
  description: string;
  parameters: unknown; // a TSchema (Type.Object(...)) - kept as unknown here to avoid a hard TypeBox type dependency in generated code's own signatures
  execute: (args: P) => Promise<unknown>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Handed to a generated extension's `code`/`bind` entry functions (PLAN.md §5.13). Everything here
 * is read-only: writes exist only as operation bindings, which the daemon runs through its engine
 * (confirmation, sandbox, verification, rollback). Declarative `read` entries never see it - the
 * daemon interprets them directly. */
export interface ExtensionContext {
  http: HttpClient;
  browser: BrowserSession;
  secrets: Record<string, string>;
  /** Run a read-only shell command (classified by the daemon's rules, executed in a read-only
   * sandbox). Anything that would change state is refused. For apps whose best interface is a
   * CLI or a config file rather than HTTP. */
  exec(command: string): Promise<ExecResult>;
  /** Read a file (capped). Secret material is refused. */
  readFile(path: string): Promise<string>;
}

// --- Write bindings (PLAN.md §5.5 decision 2: declarative, never generated operation code) ---

/** Params for the daemon's http.mutation kind. Credentials only by reference (secretHeader). */
export interface HttpMutationBinding {
  kind: "http_mutation";
  goal: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  secretHeader?: { name: string; ref: string };
  expectStatus?: number[];
  captureUrl?: string;
  verifyUrl?: string;
  verifyExpect?: string;
  rollback?: { method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: string; contentType?: string };
  /** Keep a field of the JSON response in the secret store (a login's AccessToken, a minted API
   * key) under extension.<app>.<name>; the caller gets the ref back, never the value. */
  storeResponseField?: { field: string; ref: string };
}

/** Params for the daemon's shell.command kind. `writes` is the exact sandbox scope. */
export interface ShellCommandBinding {
  kind: "shell_command";
  goal: string;
  command: string;
  writes: string[];
  network: boolean;
  verify?: string;
  rollback?: string;
  cwd?: string;
}

/** Params for the daemon's file.write kind. */
export interface FileWriteBinding {
  kind: "file_write";
  goal: string;
  path: string;
  content: string;
  mode?: number;
}

/** What bind() returns. Deliberately loose (kind + goal + whatever that kind needs) rather than a
 * discriminated union: generated tests naturally write `bound.url`, and a union made that a type
 * error that cost a real learn run three attempts. The daemon validates the fields per kind at
 * learn time (validate.ts dryRunBinding) and again at run time; the specific interfaces above
 * document the exact shapes. */
export interface OperationBinding {
  kind: "http_mutation" | "shell_command" | "file_write";
  goal: string;
  [field: string]: unknown;
}

/** A write the extension offers, as data: the daemon binds the caller's args to one of its own
 * operation kinds and runs it with full engine semantics. The extension never performs the write
 * itself and never contains rollback logic. `parameters` MUST be a JSON Schema object -
 * Type.Object({...}) from "@miro/sdk" - it becomes the tool schema the agent calls with.
 * `bind` is synchronous: it shapes data, it never fetches (the host tolerates an async bind, but
 * generated tests read the result directly). */
export interface ExtensionOperation<P = any> {
  name: string;
  /** Human label for the UI; defaults to `name` when omitted. */
  label?: string;
  description: string;
  parameters: unknown;
  bind: (args: P) => OperationBinding;
}

// --- Declarative reads + the single-file module shape (PLAN.md §5.13) ---

/** A read the extension offers, as DATA rather than code. GET only. The daemon templates
 * {placeholders} in `path` from the tool's args, applies the module's declarative `auth`, GETs, and
 * - if `pick` is given - keeps only those fields (mapping over an array response). `expectStatus`
 * defaults to [200]. A captured HTTP trace maps onto one of these one-to-one, which is what lets a
 * discovered API become an extension with no generated code. */
export interface ReadBinding {
  method?: "GET";
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  pick?: string[];
  expectStatus?: number[];
}

/** Shared declarative auth for every `read`: send `{ [header]: <value of the named secret> }`.
 * `code`/`bind` entries read ctx.secrets directly instead. */
export interface AuthSpec {
  header: string;
  secret: string;
}

/** One capability the extension offers. Exactly one of `read`/`bind`/`code` is present:
 *  - kind "tool"/"diagnostic": `read` (declarative GET - preferred) or `code` (escape hatch).
 *  - kind "operation": `bind` (synchronous, returns an OperationBinding the daemon's engine runs).
 * `parameters` is optional: omitted, it is auto-derived from {placeholders} in a read `path` (each a
 * required string) and defaults to the empty object schema - so the declarative common case needs no
 * hand-typed JSON Schema. Provide a Type.Object({...}) for a `code` entry taking structured args. */
export interface ExtensionEntry<P = any> {
  name: string;
  kind: "tool" | "diagnostic" | "operation";
  label?: string;
  description: string;
  parameters?: unknown;
  read?: ReadBinding;
  bind?: (args: P) => OperationBinding;
  code?: (ctx: ExtensionContext, args: P) => Promise<unknown>;
}

/** The single generated file's default export: `export default { auth?, entries } satisfies
 * ExtensionModule`. Behavior only - the app's metadata (baseUrl, secrets, displayName) is passed to
 * the daemon out-of-band by extension_write, so the model writes just what the app can do. */
export interface ExtensionModule {
  auth?: AuthSpec;
  entries: ExtensionEntry[];
}

/** Fixture-based fake HTTP/exec/readFile clients: exact-match routing. Kept for unit tests and for
 * replaying captured traces against a declarative read (PLAN.md §5.13 slice 2). */
export function createFakeExec(routes: Record<string, Partial<ExecResult>> = {}): ExtensionContext["exec"] {
  return async (command) => {
    if (!(command in routes)) throw new Error(`No fixture for exec ${JSON.stringify(command)}`);
    const r = routes[command];
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export function createFakeReadFile(files: Record<string, string> = {}): ExtensionContext["readFile"] {
  return async (path) => {
    if (!(path in files)) throw new Error(`No fixture for file ${path}`);
    return files[path];
  };
}
