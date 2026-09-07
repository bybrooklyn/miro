// Format-aware config-paste parser (PLAN.md secure-intake slice). Given a pasted credential blob,
// recognize its format and split it into secret VALUES (to store by ref, never shown to the model)
// and non-secret CONFIG (safe to keep as settings). The `summary` describes what was found WITHOUT
// any secret value in it. Recognizers are a registry so the corpus can grow (WireGuard + .env first,
// then OpenVPN / provider JSON / raw API keys). The owner asked to be able to paste a whole config
// (like the Proton WireGuard block) into a secure surface and have Miro do the right thing.

export interface ParsedConfig {
  /** "wireguard" | "env" | "raw" (unrecognized -> whole blob as one secret). */
  format: string;
  /** Secret values to store by ref - never surfaced to the model. */
  secrets: { ref: string; value: string }[];
  /** Non-secret config, safe to keep as settings and to show. */
  settings: Record<string, string>;
  /** Human description with NO secret value in it. */
  summary: string;
}

interface IniRow {
  section: string;
  key: string;
  value: string;
}

function parseIni(text: string): IniRow[] {
  const rows: IniRow[] = [];
  let section = "";
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1]!.trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    rows.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return rows;
}

/** WireGuard .conf: [Interface] PrivateKey/Address/DNS + [Peer] PublicKey/Endpoint/AllowedIPs. Only
 * PrivateKey is secret; the rest is topology the daemon needs and is safe to keep. */
function parseWireguard(text: string, app: string): ParsedConfig | null {
  const rows = parseIni(text);
  const get = (section: string, key: string) => rows.find((r) => r.section === section && r.key.toLowerCase() === key.toLowerCase())?.value;
  const priv = get("interface", "PrivateKey");
  if (!priv) return null; // not a WireGuard config
  const secrets = [{ ref: `extension.${app}.wg_private_key`, value: priv }];
  const settings: Record<string, string> = {};
  const map: [string, string, string][] = [
    ["interface", "Address", "wg_addresses"],
    ["interface", "DNS", "wg_dns"],
    ["peer", "PublicKey", "wg_public_key"],
    ["peer", "Endpoint", "wg_endpoint"],
    ["peer", "AllowedIPs", "wg_allowed_ips"],
  ];
  for (const [section, key, out] of map) {
    const v = get(section, key);
    if (v) settings[out] = v;
  }
  const ep = settings["wg_endpoint"] ? `endpoint ${settings["wg_endpoint"]}` : "";
  const ad = settings["wg_addresses"] ? `address ${settings["wg_addresses"]}` : "";
  return {
    format: "wireguard",
    secrets,
    settings,
    summary: `WireGuard config: private key stored as ${secrets[0]!.ref}${[ep, ad].filter(Boolean).length ? "; " + [ep, ad].filter(Boolean).join(", ") : ""}`,
  };
}

// A var whose NAME implies a secret value (.env). Anchored to the end so DB_PASSWORD / API_KEY match
// but PUBLIC_KEY_PATH does not.
const SECRET_NAME = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential)$/i;

/** A .env / KEY=VALUE file: secret-named keys become refs, the rest settings. Rejects input that
 * isn't cleanly KEY=VALUE (so a WireGuard block, tried first, isn't misread as env). */
function parseEnv(text: string, app: string): ParsedConfig | null {
  const kvs: { k: string; v: string }[] = [];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) return null; // a non-KV, non-comment line -> not an env file
    const k = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return null; // not an env var name
    kvs.push({ k, v: line.slice(eq + 1).trim().replace(/^["']|["']$/g, "") });
  }
  if (kvs.length === 0) return null;
  const secrets: { ref: string; value: string }[] = [];
  const settings: Record<string, string> = {};
  for (const { k, v } of kvs) {
    if (SECRET_NAME.test(k)) secrets.push({ ref: `extension.${app}.${k.toLowerCase()}`, value: v });
    else settings[k] = v;
  }
  return { format: "env", secrets, settings, summary: `.env: ${secrets.length} secret var(s), ${Object.keys(settings).length} non-secret var(s)` };
}

/** Recognize + split a pasted config. Unrecognized input becomes a single raw secret (the generic
 * blob fallback), so the value is still stored by ref and never left in the model context. */
export function parseConfig(text: string, app = "vpn"): ParsedConfig {
  return (
    parseWireguard(text, app) ??
    parseEnv(text, app) ?? { format: "raw", secrets: [{ ref: `extension.${app}.secret`, value: text.trim() }], settings: {}, summary: "unrecognized format; stored the whole value as one secret" }
  );
}
