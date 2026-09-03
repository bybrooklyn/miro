import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Part of `miro setup`'s discovery step (plan §10) - this runs on the user's own machine to find
// candidate servers via their SSH config, before mirod exists anywhere. Not a mirod agent tool:
// mirod runs on the target server diagnosing itself, this runs on the client finding one.

export interface SshHostEntry {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
}

/** Parses an OpenSSH client config's `Host` blocks. Skips wildcard-only patterns (e.g. `Host *`). */
export function parseSshConfig(text: string): SshHostEntry[] {
  const entries: SshHostEntry[] = [];
  let current: SshHostEntry | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(" ");

    if (/^host$/i.test(key)) {
      if (current) entries.push(current);
      current = value.includes("*") ? null : { alias: value, hostname: null, user: null, port: null };
    } else if (current) {
      if (/^hostname$/i.test(key)) current.hostname = value;
      else if (/^user$/i.test(key)) current.user = value;
      else if (/^port$/i.test(key)) current.port = Number(value);
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function discoverSshHosts(configPath: string = join(homedir(), ".ssh", "config")): SshHostEntry[] {
  if (!existsSync(configPath)) return [];
  return parseSshConfig(readFileSync(configPath, "utf8"));
}
