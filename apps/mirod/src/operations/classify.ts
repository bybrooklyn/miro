import { accessSync, constants, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { homedir } from "node:os";

// The command classifier (PLAN.md §5.7). Every agent-issued shell command - main agent, learn
// agent, extension write bindings, repair - passes through classifyCommand() in the daemon before
// anything executes. It is a pure function over the command string (plus a binary resolver) with
// a table-driven corpus in classify.test.ts: the bypass catalogue in the plan IS the test file.
//
// Two layers work together and neither is redundant: this classifier decides the *path* a command
// takes (read → shell_inspect, everything else → an operation through the engine, forbidden →
// refused), and the kernel sandbox (operations/sandbox.ts) *contains* whatever runs. The sandbox
// cannot see past a socket (docker, systemd, D-Bus), which is why the per-binary argument rules
// below exist even with a sandbox underneath.

export type CommandClass = "read" | "mutate" | "destructive" | "lifeline" | "forbidden";

const RANK: Record<CommandClass, number> = { read: 0, mutate: 1, destructive: 2, lifeline: 3, forbidden: 4 };

export function maxClass(a: CommandClass, b: CommandClass): CommandClass {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface Redirect {
  fd: number | null; // null = stdout by default
  op: string; // ">", ">>", ">|", "<", "<>", "&>", ">&"
  target: string;
}

export interface Segment {
  argv: string[];
  redirects: Redirect[];
  background: boolean;
  /** Unresolved shell expansion somewhere in this segment ($VAR, $(...), backticks, <(...)). */
  hasExpansion: boolean;
  /** Glob metacharacters in argv[0]. */
  globInCommand: boolean;
}

export interface SegmentClassification {
  segment: Segment;
  /** The command actually classified after wrapper unwrapping (e.g. `sudo nice rm x` → rm). */
  effectiveArgv: string[];
  class: CommandClass;
  reason: string;
}

export interface Classification {
  class: CommandClass;
  segments: SegmentClassification[];
  reasons: string[];
  /** A `read` command that needs the host network namespace (routes, sockets, DNS, local HTTP).
   * Everything else runs in an empty namespace, so a read can never be an egress. */
  needsNetwork: boolean;
  /** For forbidden results: the safe thing to do instead, phrased for the model. */
  alternative?: string;
  /** The parse failed; `class` is the conservative fallback. */
  parseError?: string;
}

export interface ClassifyOptions {
  /** Resolve a bare or pathed command name to its real path (realpath, following symlinks), or
   * null if not found. Injected so tests can point at a real temp directory; the default walks
   * PATH. This is dependency injection over a real filesystem, not a mock. */
  resolveBinary?: (name: string) => string | null;
  /** Directories a binary must live in (after realpath) to ever be classified `read`. */
  trustedBinDirs?: string[];
  /** Home directory used to expand a leading `~`. */
  home?: string;
}

// ---------------------------------------------------------------------------------------------
// Tokeniser - a real POSIX shell-word parser, never a regex on the raw string. Quoting tricks
// (`r'm'`, `"r"m`, `r\m`, `$'rm'`) all canonicalise to the literal word; anything that would need
// the shell to *compute* a value (variables, command substitution, process substitution) is
// flagged rather than guessed at.
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: "word"; value: string; expansion: boolean; glob: boolean }
  | { kind: "op"; value: "|" | "||" | "&&" | ";" | "&" | "\n" }
  | { kind: "redirect"; fd: number | null; op: string; target: string };

const CONTROL_OPS = ["||", "&&", "|", ";", "&", "\n"] as const;
const REDIRECT_OPS = [">>", ">|", "&>", ">&", "<>", "<<", ">", "<"] as const;

function decodeAnsiC(body: string): string {
  return body.replace(/\\([nrt\\'"]|x[0-9a-fA-F]{2}|[0-7]{1,3})/g, (_, esc: string) => {
    switch (esc[0]) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      case "x": return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const flushWord = (word: string, expansion: boolean, glob: boolean, started: boolean) => {
    if (!started) return;
    // A redirect operator immediately followed by a word: attach as its target.
    const last = tokens[tokens.length - 1];
    if (last && last.kind === "redirect" && last.target === "") {
      last.target = word;
      if (expansion) tokens.push({ kind: "word", value: "", expansion: true, glob: false }); // keep the flag visible
      return;
    }
    tokens.push({ kind: "word", value: word, expansion, glob });
  };

  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "\n") { tokens.push({ kind: "op", value: "\n" }); i++; continue; }
    if (c === "#") { while (i < n && input[i] !== "\n") i++; continue; }

    // Control operators.
    const op = CONTROL_OPS.find((o) => input.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }

    // Process substitution `<(cmd)` / `>(cmd)` is an expansion the shell would have to compute -
    // a word flagged as expansion, never a redirect. Consumed to the matching paren.
    if ((c === "<" || c === ">") && input[i + 1] === "(") {
      let depth = 0;
      let k = i + 1;
      for (; k < n; k++) {
        if (input[k] === "(") depth++;
        else if (input[k] === ")") { depth--; if (depth === 0) { k++; break; } }
      }
      tokens.push({ kind: "word", value: input.slice(i, k), expansion: true, glob: false });
      i = k;
      continue;
    }

    // Redirects, optionally preceded by a digit fd (2>, 1>&2, 2>&1).
    let fd: number | null = null;
    let j = i;
    if (/[0-9]/.test(input[j]) && (input[j + 1] === ">" || input[j + 1] === "<")) {
      fd = Number(input[j]);
      j++;
    }
    const rop = REDIRECT_OPS.find((o) => input.startsWith(o, j));
    if (rop) {
      j += rop.length;
      // `>&1` / `2>&1` / `>&2` - duplication target is a digit or `-`.
      if (rop === ">&" || rop === "<>" || rop === "&>") {
        let k = j;
        while (k < n && /[0-9-]/.test(input[k])) k++;
        if (k > j) {
          tokens.push({ kind: "redirect", fd, op: rop, target: input.slice(j, k) });
          i = k;
          continue;
        }
      }
      // Also handle `2>&1` written as fd + ">" + "&1".
      if (rop === ">" && input[j] === "&") {
        let k = j + 1;
        while (k < n && /[0-9-]/.test(input[k])) k++;
        tokens.push({ kind: "redirect", fd, op: ">&", target: input.slice(j + 1, k) });
        i = k;
        continue;
      }
      tokens.push({ kind: "redirect", fd, op: rop, target: "" });
      i = j;
      continue;
    }

    // A word.
    let word = "";
    let expansion = false;
    let glob = false;
    let started = false;
    while (i < n) {
      const ch = input[i];
      if (ch === " " || ch === "\t" || ch === "\n") break;
      if (CONTROL_OPS.some((o) => input.startsWith(o, i))) break;
      if ((ch === ">" || ch === "<") || (/[0-9]/.test(ch) && (input[i + 1] === ">" || input[i + 1] === "<") && !started)) break;
      started = true;
      if (ch === "'") {
        const end = input.indexOf("'", i + 1);
        if (end < 0) throw new Error("unterminated single quote");
        word += input.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === "$" && input[i + 1] === "'") {
        const end = input.indexOf("'", i + 2);
        if (end < 0) throw new Error("unterminated $'...' quote");
        word += decodeAnsiC(input.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < n && input[i] !== '"') {
          if (input[i] === "\\" && i + 1 < n && '"\\$`'.includes(input[i + 1])) {
            word += input[i + 1];
            i += 2;
            continue;
          }
          if (input[i] === "$" || input[i] === "`") expansion = true;
          word += input[i];
          i++;
        }
        if (i >= n) throw new Error("unterminated double quote");
        i++;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < n) { word += input[i + 1]; i += 2; } else { i++; }
        continue;
      }
      if (ch === "$" || ch === "`") expansion = true;
      if ((ch === "<" || ch === ">") && input[i + 1] === "(") expansion = true;
      if (ch === "*" || ch === "?" || ch === "[") glob = true;
      word += ch;
      i++;
    }
    flushWord(word, expansion, glob, started);
  }
  return tokens;
}

export function splitSegments(tokens: Token[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { argv: [], redirects: [], background: false, hasExpansion: false, globInCommand: false };
  const push = () => {
    if (current.argv.length > 0 || current.redirects.length > 0) segments.push(current);
    current = { argv: [], redirects: [], background: false, hasExpansion: false, globInCommand: false };
  };
  for (const t of tokens) {
    if (t.kind === "op") {
      if (t.value === "&") current.background = true;
      push();
      continue;
    }
    if (t.kind === "redirect") {
      if (t.target === "") throw new Error(`redirect ${t.op} without a target`);
      current.redirects.push({ fd: t.fd, op: t.op, target: t.target });
      continue;
    }
    if (t.expansion) current.hasExpansion = true;
    if (t.value === "" && t.expansion) continue; // marker only
    if (current.argv.length === 0 && t.glob) current.globInCommand = true;
    current.argv.push(t.value);
  }
  push();
  return segments;
}

// ---------------------------------------------------------------------------------------------
// Tables. Kept as data so the corpus in classify.test.ts reads against them directly.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_TRUSTED_BIN_DIRS = ["/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin", "/usr/local/sbin"];

const BLOCK_DEVICE = /^\/dev\/(sd[a-z]|vd[a-z]|nvme\d|hd[a-z]|xvd[a-z]|mmcblk\d|md\d|dm-\d|mapper\/|loop\d|disk\/)/;

/** Paths whose modification can lock the user out, take the server off the network, or damage
 * Miro itself. A `mutate` touching any of these becomes `lifeline`. */
const LIFELINE_PATHS: RegExp[] = [
  /^\/etc\/ssh(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /^\/etc\/sudoers/,
  /^\/etc\/(passwd|shadow|group|gshadow)$/,
  /^\/etc\/pam\.d(\/|$)/,
  /^\/etc\/fstab$/,
  /^\/boot(\/|$)/,
  /^\/etc\/network(\/|$)/,
  /^\/etc\/netplan(\/|$)/,
  /^\/etc\/systemd\/network(\/|$)/,
  /^\/etc\/resolv\.conf$/,
  /^\/etc\/hosts$/,
  /^\/etc\/nftables/,
  /^\/etc\/iptables(\/|$)/,
  /^\/etc\/ufw(\/|$)/,
  /^\/etc\/wireguard(\/|$)/,
  /(^|\/)\.miro(\/|$)/,
  /^\/var\/lib\/miro(\/|$)/,
  /^\/etc\/miro(\/|$)/,
  /^\/etc\/systemd\/system\/(ssh|sshd|docker|mirod|networking|systemd-networkd|NetworkManager)/,
];

/** Reading these leaks a secret straight into model-visible context. Never `read` - and never a
 * write target through any generic kind either. Whole directories, not just known filenames:
 * `grep -r . ~/.ssh` and `cat /var/lib/miro/miro.db` are the same leak (adversarial review). */
const SENSITIVE_READ_PATHS: RegExp[] = [
  /^\/etc\/shadow$/,
  /^\/etc\/gshadow$/,
  // Everything under .ssh except the three public files an operator legitimately edits
  // (authorized_keys / known_hosts / config) - those are lifeline writes, not secrets.
  /(^|\/)\.ssh(\/(?!(authorized_keys|known_hosts|config)$)|$)/,
  /(^|\/)\.miro(\/|$)/,
  // /proc aliases that cannot be resolved from a string (cwd, fd) - no inspection needs them.
  /^\/proc\/(self|thread-self|\d+)\/(cwd|fd)(\/|$)/,
  /^\/var\/lib\/miro(\/|$)/,
  /^\/etc\/wireguard(\/|$)/,
  /(^|\/)\.env$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /^\/proc\/(self|thread-self|\d+)(\/task\/\d+)?\/environ$/,
  /^\/proc\/(self|thread-self|\d+)(\/task\/\d+)?\/(mem|maps)$/,
  /^\/etc\/ssl\/private(\/|$)/,
];

/** Directories whose subtree holds secret material. Recursing from at or above one reads it
 * without ever naming it: `grep -r . /root`, `rg token /home`, `tar cf - /etc`. Every home
 * counts - the .ssh/.env/.netrc patterns above are home-relative. Found reviewing the root
 * sandbox: uid 0 owns /root/.ssh outright, and reads as root hold CAP_DAC_READ_SEARCH. */
const SECRET_HOLDING_DIRS = ["/root", "/etc", "/proc", "/var/lib/miro"];
function holdsSecrets(dir: string, home: string): boolean {
  if (dir === "/" || dir === "/home" || /^\/home\/[^/]+$/.test(dir)) return true;
  return [...SECRET_HOLDING_DIRS, home].some((d) => d === dir || d.startsWith(dir + "/"));
}

/** A tree-walking content reader rooted where secrets live is forbidden whatever its class -
 * `tar czf /tmp/x.tgz /home/miro` is a mutate that packs every key for a later read. Named
 * targets only: a walker with no path walks the working directory, which is refused outright.
 * ponytail: `find /root -type f | xargs cat` feeds paths through a pipe the classifier does not
 * follow; there redactSecretsInText on the output is the last line. */
function secretTreeWalk(name: string, argv: string[], paths: string[], home: string): string | null {
  const rest = argv.slice(1);
  const walks =
    (["grep", "egrep", "fgrep"].includes(name) && rest.some((x) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(x) || x === "--recursive" || x === "--dereference-recursive" || x === "--directories=recurse")) ||
    ["rg", "ag", "ack"].includes(name) ||
    (name === "tar" && ((/^-?[a-zA-Z]*c/.test(rest[0] ?? "") && !(rest[0] ?? "").startsWith("--")) || rest.includes("-c") || rest.includes("--create"))) ||
    (name === "find" && ["-exec", "-execdir", "-ok", "-okdir"].some((f) => rest.includes(f)));
  if (!walks) return null;
  if (paths.length === 0) return `${name} would walk the working directory - name an absolute path to search`;
  const hit = paths.find((p) => holdsSecrets(p, home));
  return hit ? `recursive read over ${hit}, which holds secret material - name a narrower directory` : null;
}

/** Canonical form for path matching: `~` expanded, `.`/`..`/`//` collapsed, the /proc back doors
 * (`/proc/self/root/etc/shadow`, `/proc/1/cwd/…`) stripped to what they alias. Symlinks are the
 * kinds' job at apply time (realpath); this handles what a string can hide. */
export function normalizePath(path: string, home = homedir()): string {
  let p = expandHome(path, home);
  if (!p.startsWith("/")) {
    // A relative path's real base is the (unknown) working directory. Resolve it against "/" so a
    // `..` traversal reaches its absolute target and the ^/-anchored sensitive rules can match it -
    // `../../../../etc/shadow` becomes `/etc/shadow`. This can over-map a genuinely cwd-relative
    // path onto an absolute sensitive path, which errs safe (refuse). Found live: relative `..`
    // tokens bypassed every ^/-anchored secret rule (audit C1).
    p = posix.resolve("/", p);
  }
  // Aliases first, then textual normalisation: `/proc/self/root/../etc/shadow` must become
  // `/etc/shadow`, which normalising first would turn into `/proc/self/etc/shadow`. The cwd/fd
  // aliases cannot be resolved from a string; they are left in place for the sensitive-path rule.
  for (let i = 0; i < 4; i++) {
    const m = p.match(/^\/proc\/(self|thread-self|\d+)\/root(\/|$)/);
    if (!m) break;
    p = "/" + p.slice(m[0].length);
  }
  if (/^\/proc\/(self|thread-self|\d+)\/(cwd|fd)(\/|$)/.test(p)) return p;
  p = posix.normalize(p);
  const again = p.match(/^\/proc\/(self|thread-self|\d+)\/root(\/|$)/);
  if (again) return normalizePath(p, home);
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** Exported for the file kinds: a write to one of these is `lifeline`, never plain `mutate`. */
export function isLifelinePath(path: string, home = homedir()): boolean {
  const p = normalizePath(path, home);
  return LIFELINE_PATHS.some((re) => re.test(p));
}

/** Exported for the file kinds and read tools: Miro's own secret material, private keys, and
 * credential files - never read into model context, never written or deleted through any
 * generic kind. */
export function isSensitivePath(path: string, home = homedir()): boolean {
  const p = normalizePath(path, home);
  return SENSITIVE_READ_PATHS.some((re) => re.test(p));
}

/** Masks credential-shaped values in text bound for model context (tool output, captures).
 * ponytail: regex over common shapes, not a full parser - the structural defence is that
 * secret-path reads are refused outright above; this catches the env dump and the JSON blob. */
export function redactSecretsInText(text: string): string {
  // Protect `{{secret:<ref>}}` placeholders first - a reference is not a value, and the `secret:`
  // keyword rule below would otherwise redact the ref name out of a plan or a capability doc.
  const refs: string[] = [];
  const guarded = text.replace(/\{\{secret:[^}]+\}\}/g, (m) => "\u0000" + (refs.push(m) - 1) + "\u0000");
  const redacted = guarded
    .replace(/("?(?:password|passwd|pw|token|api_?key|secret|authorization|x-emby-token|x-mediabrowser-token|x-api-key|access_?key|private_?key|cookie|set-cookie|session(?:_?id)?|jwt|refresh_?token|client_?secret)"?\s*[:=]\s*"?)([^"&\s,}]+)/gi, "$1[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]")
    .replace(/(Authorization:\s*)(\S.*)/gi, "$1[redacted]")
    .replace(/(MediaBrowser[^"\n]*Token=")([^"]+)/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g, "[redacted]")
    // /etc/shadow and /etc/gshadow hash lines: `user:$6$…:…` - not keyword-shaped, so caught by structure.
    .replace(/^([^\s:]+:)([$!*][^\s:]*)/gm, "$1[redacted]")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1 [redacted] $2");
  return redacted.replace(/\u0000(\d+)\u0000/g, (_, i) => refs[Number(i)] ?? "");
}

/** Binaries whose read-only use needs the host network namespace (routes, sockets, DNS, local
 * HTTP). Everything else inspects in an empty namespace - no egress possible. */
const NETWORK_READERS = new Set(["ip", "ss", "netstat", "nft", "iptables", "ip6tables", "ufw", "route", "arp", "ethtool", "wg", "tailscale", "nmcli", "dig", "nslookup", "host", "getent", "curl", "wget", "ping", "traceroute", "tracepath", "mtr", "tcpdump", "tshark", "nc", "ncat", "ifconfig"]);

/** Only hosts on this machine or its private network - a `read`-class fetch may not leave the LAN;
 * a public URL becomes a confirmed `mutate` (egress is visible in a plan). */
export function isLocalOrPrivateUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fd") || h.startsWith("fc")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return !h.includes("."); // a bare single-label hostname is a LAN name
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const LIFELINE_UNITS = /^(ssh|sshd|docker|containerd|mirod|networking|systemd-networkd|systemd-resolved|NetworkManager|wg-quick@.*|tailscaled|firewalld|nftables|ufw)(\.(service|socket|target|timer))?$/;
const LIFELINE_PROCESSES = /^(mirod|sshd|dockerd|containerd|systemd|init|NetworkManager|systemd-networkd)$/;

/** Wrappers that run another command: classify the inner one. Each returns the inner argv, or
 * null when the invocation itself is the problem (interactive shell, no command). */
const WRAPPERS: Record<string, (argv: string[]) => { inner: string[] } | { forbidden: string } | null> = {
  env: (a) => {
    let i = 1;
    while (i < a.length && (a[i] === "-i" || a[i] === "-" || a[i].startsWith("-u") || a[i].startsWith("--") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[i]))) {
      if ((a[i] === "-u" || a[i] === "--unset") && i + 1 < a.length) i++;
      i++;
    }
    return i < a.length ? { inner: a.slice(i) } : null;
  },
  nice: (a) => skipOptions(a, ["-n", "--adjustment"]),
  ionice: (a) => skipOptions(a, ["-c", "-n", "-p", "--class", "--classdata"]),
  timeout: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (["-s", "--signal", "-k", "--kill-after"].includes(a[i])) i++;
      i++;
    }
    i++; // the duration
    return i < a.length ? { inner: a.slice(i) } : null;
  },
  nohup: (a) => (a.length > 1 ? { inner: a.slice(1) } : null),
  setsid: (a) => skipOptions(a, []),
  time: (a) => skipOptions(a, ["-f", "-o", "--format", "--output"]),
  stdbuf: (a) => skipOptions(a, ["-i", "-o", "-e", "--input", "--output", "--error"]),
  chronic: (a) => (a.length > 1 ? { inner: a.slice(1) } : null),
  command: (a) => skipOptions(a, []),
  exec: (a) => (a.length > 1 ? { inner: a.slice(1) } : { forbidden: "exec with no command replaces the shell" }),
  sudo: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (a[i] === "-i" || a[i] === "-s" || a[i] === "--login" || a[i] === "--shell") return { forbidden: "sudo -i/-s opens an interactive shell" };
      if (["-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-U", "--user", "--group", "--prompt", "--chdir"].includes(a[i])) i++;
      i++;
    }
    if (i >= a.length) return { forbidden: "sudo with no command opens an interactive shell" };
    return { inner: a.slice(i) };
  },
  doas: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (a[i] === "-s") return { forbidden: "doas -s opens an interactive shell" };
      if (["-u", "-C"].includes(a[i])) i++;
      i++;
    }
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "doas with no command opens an interactive shell" };
  },
  su: (a) => {
    const c = a.indexOf("-c");
    if (c < 0 || c + 1 >= a.length) return { forbidden: "su without -c opens an interactive shell" };
    return { inner: ["sh", "-c", a[c + 1]] };
  },
  nsenter: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (a[i] === "--") { i++; break; }
      if (["-t", "--target", "-S", "-G", "-w", "-r", "--wd", "--root", "--setuid", "--setgid"].includes(a[i])) i++;
      i++;
    }
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "nsenter with no command opens a shell in the target namespace" };
  },
  chroot: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) { if (["--userspec", "--groups"].includes(a[i])) i++; i++; }
    i++; // NEWROOT
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "chroot with no command opens an interactive shell" };
  },
  xargs: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (["-I", "-n", "-P", "-L", "-s", "-d", "-a", "-E", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"].includes(a[i])) i++;
      i++;
    }
    return i < a.length ? { inner: a.slice(i) } : { inner: ["echo"] }; // xargs with no utility = echo
  },
  busybox: (a) => (a.length > 1 ? { inner: a.slice(1) } : { forbidden: "busybox with no applet opens a shell" }),
  toybox: (a) => (a.length > 1 ? { inner: a.slice(1) } : { forbidden: "toybox with no applet opens a shell" }),
  // More exec wrappers (adversarial review): each runs its trailing command; classify that.
  flock: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) { if (["-w", "--timeout", "-E", "--conflict-exit-code"].includes(a[i])) i++; i++; }
    i++; // the lock file/fd
    return i < a.length ? { inner: a.slice(i) } : null;
  },
  runuser: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (a[i] === "-c" || a[i] === "--command") return i + 1 < a.length ? { inner: ["sh", "-c", a[i + 1]] } : null;
      if (["-u", "--user", "-g", "--group", "-G", "--supp-group"].includes(a[i])) i++;
      i++;
    }
    if (a[i] === "--") i++;
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "runuser with no command opens an interactive shell" };
  },
  setpriv: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) { if (a[i] === "--") { i++; break; } i++; }
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "setpriv with no command" };
  },
  taskset: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) { if (["-p", "--pid", "-c", "--cpu-list"].includes(a[i])) i++; i++; }
    i++; // the mask
    return i < a.length ? { inner: a.slice(i) } : null;
  },
  chrt: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) { if (["-p", "--pid"].includes(a[i])) i++; i++; }
    i++; // the priority
    return i < a.length ? { inner: a.slice(i) } : null;
  },
  unshare: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) { if (["--setuid", "--setgid", "--wd", "--root", "-S", "-G", "-w", "-R"].includes(a[i])) i++; i++; }
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "unshare with no command opens a shell" };
  },
  script: (a) => {
    const c = a.indexOf("-c");
    if (c >= 0 && c + 1 < a.length) return { inner: ["sh", "-c", a[c + 1]] };
    return { forbidden: "script without -c opens an interactive shell" };
  },
  ssh: (a) => {
    let i = 1;
    while (i < a.length && a[i].startsWith("-")) {
      if (/^-[bcDEeFIiJLlmOopQRSWw]$/.test(a[i])) i++;
      i++;
    }
    i++; // destination
    return i < a.length ? { inner: a.slice(i) } : { forbidden: "ssh with no command opens an interactive session" };
  },
};

function skipOptions(a: string[], withValue: string[]): { inner: string[] } | null {
  let i = 1;
  while (i < a.length && a[i].startsWith("-")) {
    if (withValue.includes(a[i])) i++;
    i++;
  }
  return i < a.length ? { inner: a.slice(i) } : null;
}

/** Interpreters: inline code is `mutate` (contained by the sandbox, PLAN §5.7 F2); a bare
 * invocation is an interactive shell/REPL → forbidden. The inline body is scanned for deletion/
 * format APIs, which bumps it to `destructive`. `-c` bodies for POSIX shells are re-classified as
 * commands, so `bash -c "rm -rf /"` is still `rm`. */
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh", "fish", "ash"]);
const INTERPRETERS: Record<string, string[]> = {
  python: ["-c", "-m"], python3: ["-c", "-m"], python2: ["-c", "-m"],
  perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"], deno: ["eval"], lua: ["-e"], awk: [], gawk: [], mawk: [],
};
const DESTRUCTIVE_CODE = /os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|\bunlink\w*\b|\brmtree\b|\.rm(Sync)?\s*\(|\.rmdir(Sync)?\s*\(|\brimraf\b|File\.delete|FileUtils\.rm|DROP\s+(TABLE|DATABASE)|\bTRUNCATE\b|\bmkfs|\bshred\b|\brm\s+-[a-zA-Z]*[rf]/i;

// ---------------------------------------------------------------------------------------------
// Per-binary rules. Each returns the class for that argv, or null for "no opinion" (→ mutate).
// The `read` allowlist is by binary AND arguments: `ip route show` is read, `ip route add` is
// lifeline, and the two share a binary.
// ---------------------------------------------------------------------------------------------

const PLAIN_READERS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "jq", "yq", "ls", "stat", "file",
  "df", "du", "ps", "ss", "netstat", "dig", "nslookup", "host", "getent", "id", "whoami", "uname", "hostname",
  "lsblk", "blkid", "lsof", "lspci", "lsusb", "lscpu", "free", "uptime", "date", "echo", "printf", "true",
  "false", "wc", "sort", "uniq", "cut", "tr", "column", "basename", "dirname", "realpath", "readlink",
  "which", "type", "env", "printenv", "journalctl", "dmesg", "nproc", "arch", "cal", "seq", "sha256sum",
  "md5sum", "sha1sum", "b2sum", "cksum", "xxd", "hexdump", "od", "strings", "diff", "cmp", "comm", "tee",
  "test", "[", "sleep", "pgrep", "pidof", "ip", "nft", "iptables", "ip6tables", "ufw", "systemctl", "docker",
  "find", "sed", "awk", "gawk", "mawk", "curl", "wget", "git", "apt", "apt-get", "apt-cache", "dpkg",
  "sqlite3", "psql", "mysql", "mariadb", "mount", "findmnt", "ping", "traceroute", "tracepath", "mtr",
  "openssl", "tcpdump", "tshark", "nmcli", "wg", "tailscale", "top", "htop", "iostat",
  "vmstat", "sar", "ethtool", "arp", "route", "nvidia-smi", "vainfo", "ffprobe", "mediainfo", "tar", "zcat",
  "gzip", "gunzip", "xz", "unzip", "zip", "base64", "tail", "watch", "true", "yes", "crontab", "kill",
  "pkill", "killall",
]);

/** Flag present, including inside a combined short-flag cluster (`-bn1` contains `-b`, `-rf`
 * contains `-r`). Long flags match exactly or as `--flag=value`. A cluster only counts when it is
 * all short flags (`-rf`), never a word like `-SIGKILL` (adversarial review: `kill -SIGKILL 1`
 * used to match `-L`). */
function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) =>
    flags.some((f) => a === f || (f.length === 2 && f[0] === "-" && /^-[a-z][a-z0-9]{1,5}$/.test(a) && a.slice(1).includes(f[1])) || a.startsWith(`${f}=`)),
  );
}

/** First non-option word, with the given options' values consumed - the subcommand of `git -C
 * /x clean`, `docker --log-level debug system prune`, `apt -o X=Y purge` (adversarial review:
 * a flag's value used to be mistaken for the verb, downgrading these to `mutate`). */
function firstVerb(args: string[], valueFlags: string[]): { verb: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (valueFlags.includes(args[i]) && !args[i].includes("=")) i++;
    i++;
  }
  return { verb: args[i] ?? "", rest: args.slice(i + 1) };
}

/** Value of a flag written any of the usual ways: `-s 0`, `-s0`, `-s=0`, `--size 0`, `--size=0`. */
function argAfter(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) return args[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    if (flag.length === 2 && a.startsWith(flag) && a.length > 2 && !a.startsWith("--")) return a.slice(2);
  }
  return undefined;
}

function sqlClass(sql: string | undefined): CommandClass {
  if (!sql) return "mutate";
  const s = sql.toUpperCase();
  if (/\b(DROP|TRUNCATE|DELETE|ALTER)\b/.test(s)) return "destructive";
  if (/\b(INSERT|UPDATE|CREATE|REPLACE|VACUUM|ATTACH)\b/.test(s)) return "mutate";
  if (/^\s*(SELECT|PRAGMA|EXPLAIN|WITH|\.schema|\.tables|\.indexes|\\d|SHOW|DESCRIBE)/.test(s)) return "read";
  return "mutate";
}

type Rule = (args: string[], ctx: RuleContext) => CommandClass | null;
interface RuleContext {
  classifyInner: (argv: string[]) => SegmentClassification;
}

const RULES: Record<string, Rule> = {
  // --- deletion: forbidden by design; deletion exists only as the file_delete trash kind ---
  rm: () => "forbidden",
  rmdir: () => "forbidden",
  unlink: () => "forbidden",
  shred: () => "forbidden",
  wipefs: () => "forbidden",
  mkfs: () => "forbidden",
  fdisk: () => "forbidden",
  sfdisk: () => "forbidden",
  cfdisk: () => "forbidden",
  parted: () => "forbidden",
  gdisk: () => "forbidden",
  mkswap: () => "destructive",
  reboot: () => "forbidden",
  shutdown: () => "forbidden",
  halt: () => "forbidden",
  poweroff: () => "forbidden",
  init: () => "forbidden",
  telinit: () => "forbidden",
  kexec: () => "forbidden",
  dd: (a) => {
    const of = a.find((x) => x.startsWith("of="))?.slice(3);
    if (!of) return "read"; // dd if=x (to stdout) is a copy to the pipe
    if (BLOCK_DEVICE.test(of)) return "forbidden";
    return "destructive";
  },
  truncate: (a) => {
    const size = argAfter(a, "-s") ?? argAfter(a, "--size") ?? "";
    return /^[+-]?0+(\.0+)?\s*[kKmMgGtTbB]?[bB]?$/.test(size) ? "forbidden" : "mutate";
  },
  cp: (a) => (a.slice(1).some((x) => x === "/dev/null") && a.length >= 3 && a[a.length - 1] !== "/dev/null" ? "forbidden" : "mutate"),
  mv: (a) => {
    const rest = a.slice(1).filter((x) => !x.startsWith("-"));
    if (rest.includes("/dev/null")) return "forbidden";
    if (rest[0] === "/" || rest.some((x) => x === "/*")) return "forbidden";
    return "mutate";
  },
  // A crontab is root code on a timer, run by cron outside any sandbox: installing one is
  // `lifeline`, wiping them is forbidden, the editor is interactive.
  crontab: (a) => (hasFlag(a, "-r") ? "forbidden" : hasFlag(a, "-e") ? "forbidden" : hasFlag(a, "-l") ? "read" : "lifeline"),
  // Hand execution to PID 1 / atd, outside the sandbox and the classifier - never.
  "systemd-run": () => "forbidden",
  at: () => "forbidden",
  batch: () => "forbidden",
  chmod: (a) => permClass(a),
  chown: (a) => permClass(a),
  chgrp: (a) => permClass(a),
  chattr: () => "destructive",
  umount: () => "lifeline",
  swapoff: () => "mutate",
  passwd: (a) => (hasFlag(a, "-l", "--lock", "-d", "--delete") ? "lifeline" : "mutate"),
  usermod: (a) => (hasFlag(a, "-L", "--lock", "-e", "--expiredate", "-s", "--shell") ? "lifeline" : "mutate"),
  chage: () => "lifeline",
  userdel: () => "lifeline",
  deluser: () => "lifeline",
  visudo: () => "lifeline",
  ifdown: () => "lifeline",
  ifconfig: (a) => (a.length <= 2 ? "read" : "lifeline"),
  "wg-quick": (a) => (a[1] === "down" ? "lifeline" : "mutate"),
  nmcli: (a) => (a.some((x) => ["down", "off", "delete", "disconnect"].includes(x)) ? "lifeline" : a.some((x) => ["up", "add", "modify", "connect", "on"].includes(x)) ? "mutate" : "read"),
  ufw: (a) => (a[1] === "status" || a[1] === "show" || a[1] === "version" ? "read" : "lifeline"),
  iptables: (a) => (hasFlag(a, "-L", "-S", "--list", "--list-rules") ? "read" : "lifeline"),
  ip6tables: (a) => (hasFlag(a, "-L", "-S", "--list", "--list-rules") ? "read" : "lifeline"),
  nft: (a) => (a[1] === "list" || a[1] === "--json" || a[1] === "-j" ? "read" : "lifeline"),
  ip: (a) => {
    // Batch mode reads commands from a file or stdin - none of them visible here (adversarial
    // review: `echo 'link set eth0 down' | ip -b -` classified read).
    if (a.slice(1).some((x) => x === "-b" || x === "-batch" || x === "--batch" || x === "-force" || x.startsWith("-b="))) return "lifeline";
    // Skip global options; the ones that take a value (`-n <netns>`, `-f <family>`) consume it.
    const rest: string[] = [];
    for (let i = 1; i < a.length; i++) {
      if (a[i].startsWith("-")) {
        if (["-n", "-netns", "-f", "-family", "-l", "-loops", "-rc", "-rcvbuf"].includes(a[i])) i++;
        continue;
      }
      rest.push(a[i]);
    }
    const verb = rest[1] ?? "show";
    if (["show", "list", "ls", "get", "l", "s", "lst", "monitor", "help"].includes(verb) || rest.length <= 1) return "read";
    return "lifeline";
  },
  route: (a) => (a.length <= 2 || a[1] === "-n" ? "read" : "lifeline"),
  arp: (a) => (hasFlag(a, "-d", "-s") ? "lifeline" : "read"),
  ethtool: (a) => (a.slice(1).some((x) => x.startsWith("-") && !["-i", "-S", "-k", "-g", "-c", "-a", "-l", "--show-features"].includes(x)) ? "lifeline" : "read"),
  systemctl: (a) => {
    const { verb, rest } = firstVerb(a.slice(1), ["-M", "--machine", "-H", "--host", "-p", "--property", "-t", "--type", "-n", "--lines", "-o", "--output", "-s", "--signal", "--state", "--job-mode", "--preset-mode"]);
    const unit = rest.find((x) => !x.startsWith("-")) ?? "";
    if (!verb) return "read";
    if (["status", "show", "cat", "is-active", "is-enabled", "is-failed", "is-system-running", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies", "list-jobs", "show-environment", "get-default", "help"].includes(verb)) return "read";
    // Every change: refused as a shell command, with the operation kinds as the alternative. A
    // sandboxed systemctl can never reach systemd - bubblewrap gives the command its own PID
    // namespace (on purpose: no host process's environ is readable there) and systemctl refuses to
    // talk to PID 1 from another one ("Failed to connect to system scope bus", found live). The
    // restart/unit kinds run in the daemon's namespace with capture/verify/rollback instead; reboot
    // and friends were never allowed this way (PLAN.md §5.23). `unit` is unused now on purpose.
    void unit;
    return "forbidden";
  },
  kill: (a) => {
    const args = a.slice(1);
    if (args.includes("-l") || args.includes("-L")) return "read";
    const sig = args.includes("-0") || (args.includes("-s") && args[args.indexOf("-s") + 1] === "0") || args.includes("-n") && args[args.indexOf("-n") + 1] === "0";
    const dash = args.indexOf("--");
    const targets = [...args.filter((x, i) => (dash < 0 || i < dash) && !x.startsWith("-") && x !== "0"), ...(dash >= 0 ? args.slice(dash + 1) : [])];
    if (sig && !args.some((x) => /^-(SIG)?[A-Z]+$/.test(x))) return "read"; // signal 0 = existence check
    if (targets.some((t) => t === "1" || t === "-1")) return "lifeline"; // init, or every process
    if (args.length === 1 && args[0] === "-1") return "lifeline"; // bare -1: only ever means "everything"
    return "mutate";
  },
  pkill: (a) => (a.slice(1).some((x) => LIFELINE_PROCESSES.test(x)) ? "lifeline" : "mutate"),
  killall: (a) => (a.slice(1).some((x) => LIFELINE_PROCESSES.test(x)) ? "lifeline" : "mutate"),
  docker: (a, ctx) => {
    const args = a.slice(1);
    const { verb: sub, rest: subArgs } = firstVerb(args, ["-H", "--host", "-l", "--log-level", "-c", "--context", "--config", "--tlscacert", "--tlscert", "--tlskey"]);
    const sub2 = subArgs.find((x) => !x.startsWith("-")) ?? "";
    if (["ps", "images", "inspect", "logs", "top", "port", "diff", "history", "info", "version", "stats", "events", "search"].includes(sub)) return sub === "stats" && !hasFlag(subArgs, "--no-stream") ? "mutate" : "read";
    if (["network", "volume", "image", "container", "context", "plugin", "system"].includes(sub)) {
      if (["ls", "list", "inspect", "df", "info", "show"].includes(sub2)) return "read";
      if (["rm", "remove", "prune"].includes(sub2)) return sub === "network" || sub === "context" ? "mutate" : "destructive";
      return "mutate";
    }
    if (sub === "exec") {
      let i = 0;
      while (i < subArgs.length && subArgs[i].startsWith("-")) {
        if (["-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file"].includes(subArgs[i])) i++;
        i++;
      }
      const container = subArgs[i];
      const inner = subArgs.slice(i + 1);
      if (!container || inner.length === 0) return "forbidden";
      const innerCls = ctx.classifyInner(inner);
      if (hasFlag(subArgs.slice(0, i), "-it", "-i", "-t", "--interactive", "--tty") && SHELLS.has(inner[0]) && !inner.includes("-c")) return "forbidden";
      return innerCls.class;
    }
    if (sub === "rm" || sub === "rmi") return "destructive";
    if (sub === "run" || sub === "create") {
      // The daemon does the container's work on the far side of a socket, outside any sandbox:
      // a host bind mount is the host filesystem handed to whatever the container runs.
      if (subArgs.some((x) => x === "--privileged" || x.startsWith("--pid=host") || x.startsWith("--cap-add") || x.startsWith("--security-opt") || x.startsWith("--userns=host") || x.startsWith("--ipc=host") || x.startsWith("--device"))) return "destructive";
      const binds = subArgs.flatMap((x, i) => (x === "-v" || x === "--volume" || x === "--mount" ? [subArgs[i + 1] ?? ""] : x.startsWith("-v") || x.startsWith("--volume=") || x.startsWith("--mount=") ? [x.replace(/^(-v|--volume=|--mount=)/, "")] : []));
      if (binds.some((b) => /^\/(:|$)/.test(b) || /(^|,)(source|src)=\/(,|$)/.test(b))) return "forbidden"; // the root filesystem itself
      if (binds.some((b) => /^\/(etc|root|home|boot|var\/lib\/miro|usr|bin|sbin|lib|proc|sys|dev)(:|\/|$)/.test(b) || /docker\.sock/.test(b) || /(^|,)(source|src)=\/(etc|root|home|boot|var\/lib\/miro|usr|bin|sbin|lib|proc|sys|dev)(,|\/|$)/.test(b))) return "destructive";
      if (binds.some((b) => /^\//.test(b) || /(^|,)(source|src)=\//.test(b))) return "destructive"; // any host path
      return "mutate";
    }
    if (sub === "compose") {
      const { verb } = firstVerb(subArgs, ["-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile", "--ansi", "--progress"]);
      if (["ps", "ls", "logs", "config", "images", "top", "version", "events", "port"].includes(verb)) return "read";
      if (verb === "down" && (hasFlag(subArgs, "-v", "--volumes") || hasFlag(subArgs, "--rmi"))) return "destructive";
      if (verb === "rm") return "destructive";
      return "mutate";
    }
    if (["kill", "stop", "pause", "unpause", "start", "restart", "pull", "push", "tag", "build", "cp", "commit", "update", "rename", "attach", "wait", "load", "save", "import", "export", "login", "logout"].includes(sub)) return sub === "cp" ? "mutate" : "mutate";
    return "mutate";
  },
  find: (a, ctx) => {
    const args = a.slice(1);
    if (args.includes("-delete")) return "forbidden";
    for (const flag of ["-exec", "-execdir", "-ok", "-okdir"]) {
      const i = args.indexOf(flag);
      if (i >= 0) {
        const end = args.findIndex((x, j) => j > i && (x === ";" || x === "+" || x === "\\;"));
        const inner = args.slice(i + 1, end < 0 ? undefined : end).map((x) => (x === "{}" ? "/placeholder" : x));
        return maxClass("mutate", ctx.classifyInner(inner).class);
      }
    }
    if (args.some((x) => x.startsWith("-fprint") || x === "-fls")) return "mutate";
    return "read";
  },
  sed: (a) => (hasFlag(a, "-i", "--in-place") || a.slice(1).some((x) => /^-[a-zA-Z]*i/.test(x) && !x.startsWith("--")) ? "mutate" : "read"),
  awk: (a) => (a.slice(1).some((x) => /\bprint[f]?\s*[^;]*>\s*"/.test(x) || /\bsystem\s*\(/.test(x) || x === "-i" || x.startsWith("-i")) ? "mutate" : "read"),
  gawk: (a) => RULES.awk(a, undefined as any),
  mawk: (a) => RULES.awk(a, undefined as any),
  curl: (a) => {
    const args = a.slice(1);
    const writes = args.some((x) => ["-o", "--output", "-O", "--remote-name", "-T", "--upload-file", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-X", "--request", "-c", "--cookie-jar", "-D", "--dump-header", "--trace", "--trace-ascii"].includes(x) || /^-[a-zA-Z]*[oOTdFXcD]/.test(x) && !x.startsWith("--") || x.startsWith("--output=") || x.startsWith("--data") || x.startsWith("--request=") || x.startsWith("--upload-file="));
    if (writes) return "mutate";
    // A read-class GET may not leave the local network (egress with data in the URL is
    // exfiltration). A public URL is a confirmed mutate - visible in a plan.
    const urls = args.filter((x) => /^https?:\/\//i.test(x));
    return urls.length > 0 && urls.every(isLocalOrPrivateUrl) ? "read" : "mutate";
  },
  wget: (a) => {
    const args = a.slice(1);
    // wget always writes a file unless the output is stdout: `-O -`, `-O-`, `-qO-`, `--output-document=-`.
    const toStdout = args.some((x, i) => (x === "-O" && args[i + 1] === "-") || /^-[a-zA-Z]*O-$/.test(x) || x === "--output-document=-" || (/^-[a-zA-Z]*O$/.test(x) && args[i + 1] === "-"));
    const posts = args.some((x) => x.startsWith("--post") || x.startsWith("--method") || x.startsWith("--body"));
    if (posts || !toStdout) return "mutate";
    const urls = args.filter((x) => /^https?:\/\//i.test(x));
    return urls.length > 0 && urls.every(isLocalOrPrivateUrl) ? "read" : "mutate";
  },
  git: (a) => {
    const { verb: sub, rest } = firstVerb(a.slice(1), ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
    if (["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-remote", "branch", "tag", "remote", "config", "describe", "blame", "shortlog", "cat-file", "grep", "reflog", "stash"].includes(sub)) {
      if (sub === "branch" && (hasFlag(rest, "-D", "-d", "--delete", "-m", "-M"))) return hasFlag(rest, "-D") ? "destructive" : "mutate";
      if (sub === "tag" && hasFlag(rest, "-d", "--delete")) return "destructive";
      if (sub === "remote" && rest.length > 0 && !["-v", "show", "get-url"].includes(rest[0])) return "mutate";
      if (sub === "config" && !hasFlag(rest, "--get", "--list", "-l", "--get-all", "--get-regexp")) return rest.length > 1 ? "mutate" : "read";
      if (sub === "stash" && ["drop", "clear"].includes(rest[0])) return "destructive";
      if (sub === "stash" && ["push", "pop", "apply", "save", ""].includes(rest[0] ?? "")) return "mutate";
      return "read";
    }
    if (sub === "clean") return "destructive";
    if (sub === "reset" && hasFlag(rest, "--hard")) return "destructive";
    if (sub === "checkout" && (rest.includes("--") || rest.includes("."))) return "destructive";
    if (sub === "restore") return "destructive";
    if (sub === "push" && hasFlag(rest, "-f", "--force", "--force-with-lease", "-d", "--delete")) return "destructive";
    if (sub === "rebase" || sub === "filter-branch") return "destructive";
    return "mutate";
  },
  apt: (a) => aptClass(a),
  "apt-get": (a) => aptClass(a),
  "apt-cache": () => "read",
  dpkg: (a) => (hasFlag(a, "-l", "-L", "-s", "-S", "-p", "--list", "--listfiles", "--status", "--search", "--print-avail", "-I", "--info", "-c", "--contents") ? "read" : hasFlag(a, "-r", "-P", "--remove", "--purge") ? "destructive" : "mutate"),
  pip: (a) => (a[1] === "uninstall" ? "destructive" : ["list", "show", "freeze", "check", "--version"].includes(a[1]) ? "read" : "mutate"),
  pip3: (a) => RULES.pip(a, undefined as any),
  npm: (a) => (["uninstall", "remove", "rm", "un", "unlink"].includes(a[1]) ? "destructive" : ["ls", "list", "view", "info", "outdated", "audit", "--version", "-v"].includes(a[1]) ? "read" : "mutate"),
  sqlite3: (a) => sqlClass(a.slice(1).find((x) => !x.startsWith("-") && !/\.(db|sqlite|sqlite3)$/.test(x) && !x.includes("/"))),
  psql: (a) => sqlClass(argAfter(a, "-c") ?? argAfter(a, "--command")),
  mysql: (a) => sqlClass(argAfter(a, "-e") ?? argAfter(a, "--execute")),
  mariadb: (a) => RULES.mysql(a, undefined as any),
  // A bind mount can shadow /etc or /root with anything; a remount changes what the system can
  // write - lockouts by another name.
  mount: (a) => {
    if (a.length === 1 || hasFlag(a, "-l")) return "read";
    const opts = a.slice(1).flatMap((x, i) => (/^(-o|--options)$/.test(x) ? [a[i + 2] ?? ""] : /^-o./.test(x) ? [x.slice(2)] : []));
    const optText = opts.join(",");
    if (a.slice(1).some((x) => x === "--bind" || x === "--rbind" || x === "-B" || x === "-R") || /(^|,)(r?bind|remount)(,|$)/.test(optText)) return "lifeline";
    return "mutate";
  },
  tar: (a) => {
    const args = a.slice(1);
    if (args.some((x) => x === "--remove-files" || x === "--delete")) return "forbidden";
    const mode = args[0] ?? "";
    if (/^-?[a-zA-Z]*[xc]/.test(mode) && !mode.startsWith("--") || args.some((x) => x === "-x" || x === "-c" || x === "--extract" || x === "--create")) return "mutate";
    return "read";
  },
  rsync: (a) => (a.slice(1).some((x) => x.startsWith("--delete") || x === "--remove-source-files") ? "forbidden" : hasFlag(a, "-n", "--dry-run", "--list-only") ? "read" : "mutate"),
  tee: (a) => "mutate",
  crontabs: () => "mutate",
  tcpdump: (a) => (hasFlag(a, "-w") ? "mutate" : "read"),
  tshark: (a) => (hasFlag(a, "-w") ? "mutate" : "read"),
  // netcat moves bytes to arbitrary hosts - `cat data | nc host 443` is exfiltration. Only the
  // zero-I/O port scan is a read.
  nc: (a) => (hasFlag(a, "-z") && !hasFlag(a, "-l", "--listen", "-e") ? "read" : "mutate"),
  ncat: (a) => RULES.nc(a, undefined as any),
  openssl: (a) => (["genrsa", "genpkey", "req", "x509", "pkcs12", "rand"].includes(a[1]) && hasFlag(a, "-out") ? "mutate" : "read"),
  gzip: (a) => (hasFlag(a, "-c", "--stdout", "-l", "--list", "-t", "--test") ? "read" : "mutate"),
  gunzip: (a) => RULES.gzip(a, undefined as any),
  xz: (a) => RULES.gzip(a, undefined as any),
  unzip: (a) => (hasFlag(a, "-l", "-t", "-p") ? "read" : "mutate"),
  zip: () => "mutate",
  watch: () => "forbidden",
  yes: (a, ctx) => "forbidden",
  sleep: () => "read",
  top: (a) => (hasFlag(a, "-b") ? "read" : "forbidden"),
  htop: () => "forbidden",
  less: () => "forbidden",
  more: () => "forbidden",
  vi: () => "forbidden", vim: () => "forbidden", nano: () => "forbidden", emacs: () => "forbidden",
  tailscale: (a) => (["status", "ip", "netcheck", "version", "ping", "whois", "dns"].includes(a[1]) ? "read" : ["down", "logout"].includes(a[1]) ? "lifeline" : "mutate"),
  wg: (a) => (a.length === 1 || a[1] === "show" || a[1] === "showconf" ? "read" : "lifeline"),
  echo: () => "read",
  printf: () => "read",
  ln: () => "mutate",
  mkdir: () => "mutate",
  touch: () => "mutate",
  install: () => "mutate",
  mktemp: () => "mutate",
  chsh: () => "lifeline",
  hostnamectl: (a) => (a.length === 1 || a[1] === "status" ? "read" : "mutate"),
  timedatectl: (a) => (a.length === 1 || a[1] === "status" || a[1] === "show" ? "read" : "mutate"),
  sysctl: (a) => (hasFlag(a, "-w", "--write") || a.slice(1).some((x) => x.includes("=")) ? "lifeline" : "read"),
  modprobe: (a) => (hasFlag(a, "-r", "--remove") ? "lifeline" : "mutate"),
  rmmod: () => "lifeline",
  setcap: () => "mutate",
  update: () => null,
};

function permClass(a: string[]): CommandClass {
  const rest = a.slice(1).filter((x) => !x.startsWith("-"));
  const recursive = hasFlag(a, "-R", "--recursive");
  const targets = rest.slice(1);
  if (targets.some((t) => t === "/" || t === "/*" || t === "/usr" || t === "/etc" || t === "/var" || t === "/bin" || t === "/lib" || t === "/boot")) return recursive ? "forbidden" : "lifeline";
  return recursive ? "destructive" : "mutate";
}

function aptClass(a: string[]): CommandClass {
  const { verb } = firstVerb(a.slice(1), ["-o", "--option", "-c", "--config-file", "-t", "--target-release", "-a", "--host-architecture"]);
  if (["list", "show", "search", "policy", "depends", "rdepends", "showsrc", "changelog", "madison", "--version", "help"].includes(verb)) return "read";
  if (["remove", "purge", "autoremove", "autopurge", "upgrade", "full-upgrade", "dist-upgrade", "clean", "autoclean"].includes(verb)) return "destructive";
  return "mutate"; // install, update, download, source, build-dep, ...
}

// ---------------------------------------------------------------------------------------------
// Resolution and classification.
// ---------------------------------------------------------------------------------------------

function defaultResolveBinary(name: string): string | null {
  const candidates = name.includes("/")
    ? [name]
    : (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(Boolean).map((d) => join(d, name));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return realpathSync(c);
    } catch {
      /* next */
    }
  }
  return null;
}

/** Shell builtins that never touch the filesystem on their own. */
const HARMLESS_BUILTINS = new Set(["true", "false", ":", "echo", "printf", "test", "[", "pwd", "type", "command", "help", "hash", "times"]);

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** A token is path-like if it is absolute/home/explicit-relative, OR it carries a `..` traversal
 * segment anywhere (`foo/../../../etc/shadow`) - the latter can escape to any absolute path and
 * must be normalized and checked, not skipped (audit C1). */
function isPathLike(v: string): boolean {
  return /^(\/|~|\.\/|\.\.\/)/.test(v) || /(^|\/)\.\.(\/|$)/.test(v);
}

function pathTokens(argv: string[], redirects: Redirect[], home: string): string[] {
  const out: string[] = [];
  for (const a of argv.slice(1)) {
    const v = a.includes("=") && !a.startsWith("/") ? a.slice(a.indexOf("=") + 1) : a;
    if (isPathLike(v)) out.push(normalizePath(v, home));
  }
  for (const r of redirects) if (isPathLike(r.target)) out.push(normalizePath(r.target, home));
  return out;
}

/** A glob in a path argument that could expand into secret material. Returns the offending token
 * or null. The glob can't be expanded without the filesystem, so the test is the literal prefix
 * before the first metacharacter: if the directory it names holds secrets (or the prefix already
 * starts a sensitive path), the expansion can reach a secret - `cat /etc/shado?`, `/etc/gshad*`,
 * `/home/miro/.ss?/id_rsa`. Ordinary globbed reads under a non-secret dir stay reads (audit C2). */
function pathWithinSecretArea(p: string, home: string): boolean {
  if (p === "/" || p === "/home") return true;
  if ([...SECRET_HOLDING_DIRS, home].some((d) => p === d || p.startsWith(d + "/"))) return true;
  return /^\/home\/[^/]+(\/|$)/.test(p); // any user's home holds .ssh/.env/…
}
function globReadRisk(argv: string[], home: string): string | null {
  for (const a of argv.slice(1)) {
    const v = a.includes("=") && !a.startsWith("/") ? a.slice(a.indexOf("=") + 1) : a;
    if (!isPathLike(v)) continue;
    const g = v.search(/[*?[]/);
    if (g < 0) continue;
    // A glob does not cross "/", so its expansion stays in the directory literally containing the
    // metacharacter. Forbid only when THAT directory is within a secret area (or the prefix itself
    // starts a sensitive path) - not when some unrelated secret dir merely sits under an ancestor.
    const prefix = normalizePath(v.slice(0, g), home);
    const dir = prefix.slice(0, prefix.lastIndexOf("/")) || "/";
    if (pathWithinSecretArea(dir, home) || SENSITIVE_READ_PATHS.some((re) => re.test(prefix))) return v;
  }
  return null;
}

/** Absolute path literals embedded inside a quoted string argument - an interpreter/awk/sed
 * program can read a secret whose path lives inside its program text, not as a bare path token:
 * `awk 'BEGIN{while((getline l < "/etc/shadow")>0)...}'`, `sed 'r /etc/shadow'` (audit C4).
 * Scoped to program-bearing commands so a grep regex that merely contains a path string is not
 * swept in. */
function embeddedPathLiterals(argv: string[], home: string): string[] {
  const out: string[] = [];
  for (const a of argv.slice(1)) {
    for (const m of a.matchAll(/(?:^|[\s"'(<>=,;|&])(\/[^\s"'()<>,;|&]+)/g)) {
      if (isPathLike(m[1])) out.push(normalizePath(m[1], home));
    }
  }
  return out;
}

/** git subcommands that run an arbitrary command while looking like a read: an `ext::`/`fd::`
 * transport remote runs a helper program, and `-c <key>=<cmd>` for an exec-bearing config key
 * (diff.external, *.textconv, core.sshCommand, aliases, filters, hooks) runs `<cmd>`. Both are
 * code execution mislabeled `read` (audit C3). Returns a reason or null. */
function gitInjection(argv: string[]): string | null {
  const EXEC_CONFIG = /^(diff\.external|core\.(sshcommand|fsmonitor|gitproxy|pager|editor)|sequence\.editor|.*\.textconv|.*\.(clean|smudge|process)|alias\..+|protocol\.ext\.allow|uploadpack\.|receive\.|ssh\.variant)/i;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/(^|[=@:])(ext|fd)::/i.test(a) || /^(ext|fd)::/i.test(a)) return `git ${a} runs an external transport helper (arbitrary command)`;
    const kv = a === "-c" || a === "--config-env" ? args[i + 1] : a.startsWith("-c") && a.length > 2 ? a.slice(2) : null;
    if (kv && EXEC_CONFIG.test(kv.split("=")[0])) return `git -c ${kv.split("=")[0]} sets an exec-bearing config key`;
    if (a.startsWith("--upload-pack=") || a.startsWith("--receive-pack=") || a === "--upload-pack" || a === "--receive-pack") return `git ${a} runs a named remote command`;
  }
  return null;
}

/** Network probes whose destination argument is attacker-controllable and carries data - a `read`
 * that reaches a public host is DNS/ICMP exfiltration of any literal in context (audit C5). These
 * stay reads for a local/private/LAN-name target and demote to a tracked `mutate` for a public one. */
const EXFIL_NET_TOOLS = new Set(["dig", "host", "nslookup", "getent", "ping", "ping6", "traceroute", "tracepath", "mtr", "nc", "ncat"]);
function isPublicHost(h: string): boolean {
  const host = h.replace(/^@/, "").replace(/^\[|\]$/g, "");
  if (!host || /^-/.test(host)) return false;
  try {
    return !isLocalOrPrivateUrl(`http://${host}`);
  } catch {
    return false;
  }
}
function networkProbePublicTarget(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith("-") && !a.startsWith("@")) continue; // flag, not a host
    if (/^\d+$/.test(a)) continue; // a port number
    if ((a.startsWith("@") || a.includes(".") || a.includes(":")) && isPublicHost(a)) return a.replace(/^@/, "");
  }
  return null;
}

export function classifyCommand(command: string, opts: ClassifyOptions = {}): Classification {
  const resolveBinary = opts.resolveBinary ?? defaultResolveBinary;
  const trusted = opts.trustedBinDirs ?? DEFAULT_TRUSTED_BIN_DIRS;
  const home = opts.home ?? homedir();

  let segments: Segment[];
  try {
    segments = splitSegments(tokenize(command));
  } catch (err) {
    return {
      class: "forbidden",
      segments: [],
      reasons: [`could not parse command: ${err instanceof Error ? err.message : String(err)}`],
      needsNetwork: false,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  if (segments.length === 0) return { class: "forbidden", segments: [], reasons: ["empty command"], needsNetwork: false };

  const classified = segments.map((seg) => classifySegment(seg, { resolveBinary, trusted, home }));
  const overall = classified.reduce<CommandClass>((acc, s) => maxClass(acc, s.class), "read");
  const reasons = classified.filter((s) => s.class !== "read").map((s) => `${s.effectiveArgv[0] ?? "(redirect)"}: ${s.reason}`);
  const forbidden = classified.find((s) => s.class === "forbidden");
  return {
    class: overall,
    segments: classified,
    reasons: reasons.length > 0 ? reasons : ["read-only"],
    needsNetwork: classified.some((s) => NETWORK_READERS.has(baseName(s.effectiveArgv[0] ?? ""))),
    alternative: forbidden ? alternativeFor(forbidden.effectiveArgv[0] ?? "") : undefined,
  };
}

interface Env {
  resolveBinary: (name: string) => string | null;
  trusted: string[];
  home: string;
}

function classifySegment(segment: Segment, env: Env): SegmentClassification {
  const inner = (argv: string[]): SegmentClassification =>
    classifySegment({ argv, redirects: [], background: false, hasExpansion: false, globInCommand: false }, env);

  // Redirect-only segment (`> file`, `: > file`) is a truncation with no command → forbidden.
  if (segment.argv.length === 0 || (segment.argv.length === 1 && segment.argv[0] === ":")) {
    if (segment.redirects.some((r) => r.op === ">" || r.op === ">|")) {
      return { segment, effectiveArgv: segment.argv, class: "forbidden", reason: "truncating a file with a bare redirect" };
    }
    return { segment, effectiveArgv: segment.argv, class: "read", reason: "no-op" };
  }

  // Redirect targets first: a write to a block device is forbidden regardless of the command.
  let redirectClass: CommandClass = "read";
  let redirectReason = "";
  for (const r of segment.redirects) {
    // fd duplication (`2>&1`, `>&2`) is harmless; `>&file` is a write (adversarial review).
    if ((r.op === ">&" || (r.op === ">" && r.target.startsWith("&"))) && /^&?\d+-?$/.test(r.target)) continue;
    if (r.op === "<" || r.op === "<<") continue; // input
    if (r.target === "/dev/null" || r.target === "/dev/stderr" || r.target === "/dev/stdout") continue;
    const target = normalizePath(r.target, env.home);
    if (SENSITIVE_READ_PATHS.some((re) => re.test(target))) return { segment, effectiveArgv: segment.argv, class: "forbidden", reason: `redirect writes to secret material ${target}` };
    if (BLOCK_DEVICE.test(target)) return { segment, effectiveArgv: segment.argv, class: "forbidden", reason: `redirect writes to block device ${target}` };
    if (LIFELINE_PATHS.some((re) => re.test(target))) { redirectClass = maxClass(redirectClass, "lifeline"); redirectReason = `writes to lifeline path ${target}`; }
    else { redirectClass = maxClass(redirectClass, "mutate"); redirectReason = redirectReason || `writes to ${target} via redirect`; }
  }

  // Fork bomb / function definitions.
  if (segment.argv.some((a) => /\(\)\s*\{?$/.test(a) || a === "(){" || a.startsWith(":()"))) {
    return { segment, effectiveArgv: segment.argv, class: "forbidden", reason: "shell function definition (fork-bomb shape)" };
  }

  // Unwrap wrappers to the effective command.
  let argv = segment.argv;
  let unwrapped = 0;
  while (argv.length > 0 && unwrapped < 8) {
    const name = baseName(argv[0]);
    const w = WRAPPERS[name];
    if (!w) break;
    const r = w(argv);
    if (r === null) return { segment, effectiveArgv: argv, class: "forbidden", reason: `${name} with no command` };
    if ("forbidden" in r) return { segment, effectiveArgv: argv, class: "forbidden", reason: r.forbidden };
    argv = r.inner;
    unwrapped++;
  }
  if (argv.length === 0) return { segment, effectiveArgv: segment.argv, class: "forbidden", reason: "no command after unwrapping" };

  const name = baseName(argv[0]);

  // Secret material is off limits for EVERY command, before any per-tool logic: `awk '{print}'
  // /etc/shadow` used to slip past because the awk branch returned before the path check
  // (adversarial review). Reading it leaks it; writing it corrupts Miro or locks the user out.
  const programBearing = SHELLS.has(name) || name in INTERPRETERS || /^(g|m)?awk$/.test(name) || name === "sed";
  const earlyPaths = programBearing
    ? [...pathTokens(argv, segment.redirects, env.home), ...embeddedPathLiterals(argv, env.home)]
    : pathTokens(argv, segment.redirects, env.home);
  const secret = earlyPaths.find((p) => SENSITIVE_READ_PATHS.some((re) => re.test(p)));
  if (secret) return { segment, effectiveArgv: argv, class: "forbidden", reason: `touches secret material at ${secret}` };
  const walk = secretTreeWalk(name, argv, earlyPaths, env.home);
  if (walk) return { segment, effectiveArgv: argv, class: "forbidden", reason: walk };
  // A glob metacharacter in a path argument dodges the literal sensitive match - `cat /etc/shado?`
  // expands to /etc/shadow only at exec time (audit C2). Forbid a glob whose literal prefix lies
  // in a secret-holding area; ordinary globbed reads (`ls /var/log/*.log`) are untouched.
  const glob = globReadRisk(argv, env.home);
  if (glob) return { segment, effectiveArgv: argv, class: "forbidden", reason: `glob ${glob} could expand into secret material` };
  if (name === "git") {
    const gi = gitInjection(argv);
    if (gi) return { segment, effectiveArgv: argv, class: "forbidden", reason: gi };
  }

  // Interpreters and shells.
  if (SHELLS.has(name)) {
    const c = argv.indexOf("-c");
    if (c >= 0 && c + 1 < argv.length) {
      const sub = classifyCommand(argv[c + 1], { resolveBinary: env.resolveBinary, trustedBinDirs: env.trusted, home: env.home });
      const cls = maxClass("mutate", sub.class);
      return { segment, effectiveArgv: argv, class: maxClass(cls, redirectClass), reason: sub.class === "read" ? "inline shell code (contained by the sandbox)" : `inline shell code: ${sub.reasons.join("; ")}` };
    }
    const script = argv.slice(1).find((x) => !x.startsWith("-"));
    if (script) return { segment, effectiveArgv: argv, class: maxClass("mutate", redirectClass), reason: `runs script ${script} (contained by the sandbox)` };
    return { segment, effectiveArgv: argv, class: "forbidden", reason: "interactive shell" };
  }
  if (name in INTERPRETERS) {
    const flags = INTERPRETERS[name];
    const inlineIdx = argv.findIndex((x, i) => i > 0 && (flags.includes(x) || flags.some((f) => x.startsWith(f) && f.length === 2 && x.length > 2)));
    const body = inlineIdx >= 0 ? (argv[inlineIdx].length > 2 && argv[inlineIdx].startsWith("-") && !argv[inlineIdx].startsWith("--") ? argv[inlineIdx].slice(2) : argv[inlineIdx + 1] ?? "") : undefined;
    if (name.startsWith("awk") || name === "gawk" || name === "mawk") {
      const cls = RULES.awk(argv, { classifyInner: inner }) ?? "mutate";
      return { segment, effectiveArgv: argv, class: maxClass(cls, redirectClass), reason: cls === "read" ? "read-only" : "awk program writes" };
    }
    if (body !== undefined) {
      const cls: CommandClass = DESTRUCTIVE_CODE.test(body) ? "destructive" : "mutate";
      return { segment, effectiveArgv: argv, class: maxClass(cls, redirectClass), reason: cls === "destructive" ? "inline code contains deletion/format calls" : "inline interpreter code (contained by the sandbox)" };
    }
    const script = argv.slice(1).find((x) => !x.startsWith("-"));
    if (script) {
      return { segment, effectiveArgv: argv, class: maxClass("mutate", redirectClass), reason: `runs script ${script} (contained by the sandbox)` };
    }
    return { segment, effectiveArgv: argv, class: "forbidden", reason: "interactive interpreter" };
  }

  // Rule table. mkfs.ext4 / mkfs.xfs / mke2fs ... all share mkfs's verdict.
  let cls: CommandClass | null = null;
  let reason = "";
  const rule = RULES[name] ?? (name.startsWith("mkfs") || name.startsWith("mke2fs") || name.startsWith("mkswap") ? RULES.mkfs : undefined);
  if (rule) {
    cls = rule(argv, { classifyInner: inner });
    reason = cls ? `${name} rule` : "";
  }
  if (cls === null) {
    if (PLAIN_READERS.has(name) || HARMLESS_BUILTINS.has(name)) { cls = "read"; reason = "read-only utility"; }
    else { cls = "mutate"; reason = `unknown command ${name} - never assumed read-only`; }
  }
  if (cls === "forbidden") return { segment, effectiveArgv: argv, class: "forbidden", reason: forbiddenReason(name, argv) };

  // Path-based escalation.
  const paths = pathTokens(argv, segment.redirects, env.home);
  if (cls === "read") {
    const sensitive = paths.find((p) => SENSITIVE_READ_PATHS.some((re) => re.test(p)));
    if (sensitive) return { segment, effectiveArgv: argv, class: "forbidden", reason: `reads secret material at ${sensitive}` };
  } else if (paths.some((p) => LIFELINE_PATHS.some((re) => re.test(p)))) {
    cls = maxClass(cls, "lifeline");
    reason = `touches lifeline path ${paths.find((p) => LIFELINE_PATHS.some((re) => re.test(p)))}`;
  }

  // `read` needs a clean segment and a trusted binary; anything else demotes to mutate.
  if (cls === "read") {
    if (segment.background) { cls = "mutate"; reason = "backgrounded with &"; }
    else if (segment.hasExpansion) { cls = "mutate"; reason = "unresolved shell expansion"; }
    else if (segment.globInCommand) { cls = "mutate"; reason = "glob in command position"; }
    else if (EXFIL_NET_TOOLS.has(name)) {
      const pub = networkProbePublicTarget(argv);
      if (pub) { cls = "mutate"; reason = `${name} to public host ${pub} - a read may not egress to the internet`; }
    }
    else if (!HARMLESS_BUILTINS.has(name)) {
      const real = env.resolveBinary(argv[0]);
      if (!real) { cls = "mutate"; reason = `binary ${argv[0]} not found`; }
      else if (!env.trusted.some((d) => real.startsWith(d + "/"))) { cls = "mutate"; reason = `binary resolves outside trusted directories (${real})`; }
      else if (baseName(real) !== name && !(RULES[baseName(real)] === undefined && PLAIN_READERS.has(baseName(real)))) {
        // The real binary has a different name (a symlink or PATH shadow): classify by what it really is.
        const realName = baseName(real);
        const realRule = RULES[realName];
        const realCls = realRule ? realRule([real, ...argv.slice(1)], { classifyInner: inner }) : PLAIN_READERS.has(realName) ? "read" : "mutate";
        if (realCls && realCls !== "read") return { segment, effectiveArgv: [real, ...argv.slice(1)], class: realCls, reason: `${argv[0]} is really ${real}` };
      }
    }
  }

  return { segment, effectiveArgv: argv, class: maxClass(cls, redirectClass), reason: redirectClass !== "read" && RANK[redirectClass] >= RANK[cls] ? redirectReason : reason };
}

function baseName(p: string): string {
  const b = p.slice(p.lastIndexOf("/") + 1);
  return b.startsWith("\\") ? b.slice(1) : b;
}

function forbiddenReason(name: string, argv: string[]): string {
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "shred": return `${name} is banned - deletion only exists as the file_delete operation (moves to trash, recoverable)`;
    case "mkfs": case "wipefs": case "fdisk": case "sfdisk": case "cfdisk": case "parted": case "gdisk": return `${name} destroys a filesystem/partition table`;
    case "dd": return "dd writes directly to a block device";
    case "reboot": case "shutdown": case "halt": case "poweroff": case "init": case "telinit": case "kexec": return `${name} via shell - use the dedicated reboot operation`;
    case "crontab": return "crontab -r wipes every scheduled job";
    case "truncate": return "truncate to zero destroys the file's contents";
    case "cp": return "copying /dev/null over a file destroys it";
    case "mv": return "moving to /dev/null or moving / destroys data";
    case "find": return "find -delete is a deletion";
    case "tar": return "tar --remove-files/--delete is a deletion";
    case "rsync": return "rsync --delete is a deletion";
    case "watch": case "top": case "htop": case "less": case "more": case "vi": case "vim": case "nano": case "emacs": return `${name} is interactive`;
    case "yes": return "unbounded output";
    default: return `${name} ${argv.slice(1).join(" ")}`.trim();
  }
}

function alternativeFor(name: string): string {
  switch (baseName(name)) {
    case "rm": case "rmdir": case "unlink": case "shred": case "find": case "rsync": case "tar": case "truncate": case "cp": case "mv":
      return "Use the file_delete operation - it moves the path to Miro's trash (recoverable for 30 days) and can be rolled back.";
    case "reboot": case "shutdown": case "halt": case "poweroff": case "init": case "telinit":
      return "Use the reboot operation, which records a recovery point and verifies the server comes back.";
    case "systemctl":
      return "systemctl cannot change anything from inside the command sandbox (it cannot reach systemd from the sandbox's PID namespace). Restart a unit with the service_restart operation; start, stop, enable, disable or daemon-reload with service_control. A reboot is its own operation.";
    case "mkfs": case "wipefs": case "fdisk": case "sfdisk": case "cfdisk": case "parted": case "gdisk": case "dd":
      return "Miro never formats or overwrites block devices. Ask the user to do this themselves if it is genuinely needed.";
    case "bash": case "sh": case "zsh": case "dash": case "fish": case "sudo": case "su": case "doas":
      return "Run the specific command directly instead of opening a shell.";
    default:
      return "Use a read-only inspection command, or an operation through the engine for changes.";
  }
}
