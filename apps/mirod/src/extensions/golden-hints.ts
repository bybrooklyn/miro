import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Golden hints: a small, hand-authored research shortcut for an app the learning agent already
// has a name for — NOT a pre-built extension. The agent still researches, browses, generates,
// validates, and promotes for real; a hint just cuts wasted search and reduces hallucination risk
// on the first pass. Static reference data, not runtime extension state — lives in the repo tree
// and is read directly from there, unlike ~/.miro/extensions/ (see paths.ts's own comment on why
// generated extensions live outside the repo).
export const GOLDEN_HINTS_DIR = join(import.meta.dir, "../../golden-hints");

export interface GoldenHint {
  docsUrl?: string;
  defaultPort?: number;
  authScheme?: string;
}

/** Exact match only on the lowercased, trimmed app name — e.g. "Jellyfin" and "jellyfin" both
 * resolve to golden-hints/jellyfin.json. No fuzzy matching this slice. */
export function loadGoldenHint(app: string): GoldenHint | null {
  const path = join(GOLDEN_HINTS_DIR, `${app.trim().toLowerCase()}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // malformed hint file — fail open, learn flow proceeds with no hint
  }
}

export function formatGoldenHint(hint: GoldenHint): string {
  const parts: string[] = [];
  if (hint.docsUrl) parts.push(`API docs: ${hint.docsUrl}`);
  if (hint.defaultPort) parts.push(`default port: ${hint.defaultPort}`);
  if (hint.authScheme) parts.push(`auth: ${hint.authScheme}`);
  return parts.join("; ");
}
