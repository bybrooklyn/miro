import { Type, type Static } from "@earendil-works/pi-ai";

// The API surface generated extension code (tools.ts/diagnostics.ts/browser.ts/tests.ts) is
// allowed to use — everything else is denied by extensions/validate.ts's forbidden-import
// allowlist scan. Deliberately read-only this slice: HttpClient exposes only get().

export { Type, type Static };

export interface HttpClient {
  get(path: string, opts?: { query?: Record<string, string> }): Promise<unknown>;
}

function withQuery(path: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return path;
  return `${path}?${new URLSearchParams(query).toString()}`;
}

/** Real client — used by extensions/host-entry.ts's `init`/`learn_init` modes. */
export function createHttpClient(baseUrl: string, headers: Record<string, string>): HttpClient {
  return {
    async get(path, opts) {
      const res = await fetch(new URL(withQuery(path, opts?.query), baseUrl), { headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

/** Fixture-based fake client — used by generated tests.ts (extensions/host-entry.ts's `test_init`
 * mode) so tests exercise the generated parsing/mapping logic deterministically, no real network.
 * Exact-path match only (query string ignored) — a fixture router, not a full HTTP mock. */
export function createFakeHttpClient(routes: Record<string, unknown>): HttpClient {
  return {
    async get(path) {
      const key = path.split("?")[0];
      if (!(key in routes)) throw new Error(`No fixture for GET ${path}`);
      return routes[key];
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
 * extension-host process) — this package declares the shape, not the implementation. */
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
  label: string;
  description: string;
  parameters: unknown; // a TSchema (Type.Object(...)) — kept as unknown here to avoid a hard TypeBox type dependency in generated code's own signatures
  execute: (args: P) => Promise<unknown>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Handed to a generated extension's `buildTools(ctx)`/`buildDiagnostics(ctx)`/`buildOperations(ctx)`.
 * Everything here is read-only: writes exist only as operation bindings, which the daemon runs
 * through its engine (confirmation, sandbox, verification, rollback). */
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
 * itself and never contains rollback logic. `parameters` MUST be a JSON Schema object —
 * Type.Object({...}) from "@miro/sdk" — it becomes the tool schema the agent calls with. */
export interface ExtensionOperation<P = any> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  bind: (args: P) => OperationBinding;
}

/** Fixture-based fake for generated tests.ts: exact-command match. */
export function createFakeExec(routes: Record<string, Partial<ExecResult>>): ExtensionContext["exec"] {
  return async (command) => {
    if (!(command in routes)) throw new Error(`No fixture for exec ${JSON.stringify(command)}`);
    const r = routes[command];
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export function createFakeReadFile(files: Record<string, string>): ExtensionContext["readFile"] {
  return async (path) => {
    if (!(path in files)) throw new Error(`No fixture for file ${path}`);
    return files[path];
  };
}
